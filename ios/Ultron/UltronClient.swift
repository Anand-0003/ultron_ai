import SwiftUI
import UIKit
import UserNotifications

struct Line: Identifiable {
    enum Who { case you, ultron }
    let id = UUID()
    let who: Who
    var text: String
    var file: RemoteFile? = nil
    var link: URL? = nil
    var linkLabel: String? = nil
}

struct RemoteFile: Identifiable, Decodable, Equatable {
    let id: String
    let name: String
    let size: Int
    let mime: String?
    let dir: String
    let url: String?
    let path: String?
    let note: String?
    var isImage: Bool { mime?.hasPrefix("image/") ?? false }
}

struct ConfirmRequest: Identifiable {
    let id: Int
    let command: String
}

/// The link to ULTRON on the Mac: the same WebSocket protocol the browser UI speaks,
/// authenticated with the paired device token.
@MainActor
final class UltronClient: ObservableObject {
    @Published var server: String = UserDefaults.standard.string(forKey: "server") ?? ""
    @Published private(set) var paired = Keychain.get("token") != nil
    @Published private(set) var connected = false
    @Published private(set) var busy = false
    @Published var lines: [Line] = []
    @Published private(set) var files: [RemoteFile] = []
    @Published var confirm: ConfirmRequest?
    @Published var showSettings = false
    var onResume: (() -> Void)?
    @Published var shared: Shared?
    /// The full web interface is the main screen; this switches to the simple native one instead.
    @Published var simpleScreen = UserDefaults.standard.bool(forKey: "simpleScreen") {
        didSet { UserDefaults.standard.set(simpleScreen, forKey: "simpleScreen") }
    }
    @Published var listenInBackground = UserDefaults.standard.object(forKey: "listenInBackground") as? Bool ?? true {
        didSet { UserDefaults.standard.set(listenInBackground, forKey: "listenInBackground") }
    }
    @Published var voiceOn = UserDefaults.standard.object(forKey: "voiceOn") as? Bool ?? true {
        didSet { UserDefaults.standard.set(voiceOn, forKey: "voiceOn"); send(["type": "config", "tts": voiceOn]); if !voiceOn { voice.stopPlayback() } }
    }

    let voice = VoiceEngine()
    let calls = CallManager()
    let push = PushManager()
    private var voipToken: String?
    private var outbox: [[String: Any]] = []   // call events that happen before the link is back up

    private var socket: URLSessionWebSocketTask?
    private var turn = 0
    private var ultronLine: UUID?
    private var greeted = false
    private var retries = 0
    private var foreground = true
    private var debugSay: String?
    private var debugAnswer = false

    var token: String? { Keychain.get("token") }

    /// Hardware model, e.g. "iPhone10,3" (iPhone X): the Mac names and targets each phone by it.
    private static var model: String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self) }
    }
    var baseURL: String { base }
    private var base: String { server.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "/+$", with: "", options: .regularExpression) }

    init() {
        voice.onUtterance = { [weak self] text, interrupted in self?.say(text, interrupted: interrupted) }
        voice.onBargeIn = { [weak self] in self?.send(["type": "stop"]) }
        voice.log = { [weak self] in self?.log($0) }
        calls.onPrepareAudio = { [weak self] in self?.voice.prepareForCall() }
        calls.onAnswer = { [weak self] in
            guard let self else { return }
            self.log("call answered")
            self.voice.setListening(true)
            self.send(["type": "call_answered"])
        }
        calls.onAudioActivated = { [weak self] in self?.voice.callAudioActivated() }
        push.onToken = { [weak self] token in
            self?.voipToken = token
            self?.send(["type": "voip_token", "token": token])
        }
        // Rung by Apple while locked or closed: show the call now, reconnect to the Mac meanwhile.
        push.onCall = { [weak self] _, done in
            guard let self else { return done() }
            self.calls.incomingFromPush(done: done)
            if self.socket == nil { self.connect() }
            self.log("woken by a call push")
        }
        calls.onEnd = { [weak self] answered in
            self?.voice.endCall()
            self?.send(["type": answered ? "call_ended" : "call_declined"])
        }
        #if DEBUG
        // Test hooks for simulator runs: -debugToken <t> -debugServer <url> -debugSay "text" -debugAnswer YES
        let d = UserDefaults.standard
        if let t = d.string(forKey: "debugToken") {
            Keychain.set("token", t)
            if let srv = d.string(forKey: "debugServer") { server = srv }
            paired = true
        }
        debugSay = d.string(forKey: "debugSay")
        debugAnswer = d.bool(forKey: "debugAnswer")
        #endif
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        if paired { connect() }
    }

    // MARK: Pairing

    func pair(code: String) async -> String? {
        guard let url = URL(string: base + "/api/pair") else { return "That address isn't valid" }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code.filter(\.isNumber), "name": "iPhone app"])
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            guard j["ok"] as? Bool == true, let token = j["token"] as? String else { return j["error"] as? String ?? "Pairing failed" }
            Keychain.set("token", token)
            UserDefaults.standard.set(base, forKey: "server")
            server = base
            paired = true
            connect()
            return nil
        } catch {
            return "Can't reach the Mac. Is Tailscale on? (\(error.localizedDescription))"
        }
    }

    func unpair() {
        Keychain.set("token", nil)
        paired = false
        disconnect()
        lines = []
        files = []
    }

    // MARK: Connection

    func connect() {
        guard socket == nil, let token, var comps = URLComponents(string: base) else { return }
        let origin = comps.url?.absoluteString ?? base
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        comps.path = "/ws"
        guard let url = comps.url else { return }
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "X-Ultron-Token")
        req.setValue(origin, forHTTPHeaderField: "Origin")
        let task = URLSession.shared.webSocketTask(with: req)
        socket = task
        task.resume()
        receive(task)
        send(["type": "native", "platform": "ios", "model": Self.model, "os": UIDevice.current.systemVersion])
        send(["type": "config", "tts": voiceOn])
        if let voipToken { send(["type": "voip_token", "token": voipToken]) }
        let queued = outbox
        outbox = []
        queued.forEach { send($0) }
        // With the full interface on screen, the page greets you itself.
        if !greeted && simpleScreen { greeted = true; send(["type": "greet"]) }
        ping(task)
    }

    private func disconnect() {
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connected = false
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                switch result {
                case .success(let message):
                    if case .string(let s) = message, let data = s.data(using: .utf8),
                       let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                        self.handle(obj)
                    }
                    self.receive(task)
                case .failure:
                    self.dropped()
                }
            }
        }
    }

    private func ping(_ task: URLSessionWebSocketTask) {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            guard let self, self.socket === task else { return }
            task.sendPing { _ in }
            self.ping(task)
        }
    }

    private func dropped() {
        socket = nil
        connected = false
        guard paired else { return }
        retries += 1
        // Unpaired on the Mac? Then stop retrying and show the pairing screen.
        if retries % 3 == 0 { Task { await self.checkStillPaired() } }
        let delay = min(10.0, 1.5 * Double(retries))
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            self?.connect()
        }
    }

    private func checkStillPaired() async {
        guard let token, let url = URL(string: base + "/api/whoami") else { return }
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "X-Ultron-Token")
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        if j["paired"] as? Bool == false { unpair() }
    }

    /// Diagnostics: printed here and written to the Mac's server log.
    func log(_ text: String) {
        print("[ULTRON] \(text)")
        send(["type": "client_log", "text": text])
    }

    func send(_ obj: [String: Any]) {
        guard let socket else {
            if (obj["type"] as? String)?.hasPrefix("call_") == true { outbox.append(obj) }
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(s)) { _ in }
    }

    private func reply(_ id: Any?, _ value: Any) {
        guard let id else { return }
        send(["type": "reply", "id": id, "value": value])
    }

    func scenePhase(_ phase: ScenePhase) {
        foreground = phase == .active
        if phase != .inactive { log("app \(phase == .active ? "opened" : "in background / locked") (interface listening: \(voice.webMode), keep listening setting: \(listenInBackground))") }
        if phase == .active {
            if paired && socket == nil { retries = 0; connect() }
            if !simpleScreen { voice.handBackToWeb(); onResume?() }
            voice.recover()
        } else if phase == .background, !simpleScreen, listenInBackground, paired {
            voice.handToNative()   // keep the conversation going while you're in other apps
        }
    }

    // MARK: Messages from the Mac

    private func handle(_ m: [String: Any]) {
        switch m["type"] as? String ?? "" {
        case "hello":
            connected = true
            retries = 0
            if let t = debugSay { debugSay = nil; say(t) }
        case "transcript":
            guard lines.isEmpty, let list = m["lines"] as? [[String: Any]] else { break }
            lines = list.compactMap { l in
                guard let t = l["text"] as? String else { return nil }
                return Line(who: (l["who"] as? String) == "user" ? .you : .ultron, text: t)
            }
        case "turn":
            if let t = m["turn"] as? Int, t != turn {
                turn = t
                ultronLine = nil
                voice.dropTurns(before: t)
            }
        case "busy":
            if (m["turn"] as? Int).map({ $0 == turn }) ?? true { busy = m["busy"] as? Bool ?? false }
        case "token":
            if (m["turn"] as? Int) == turn, let t = m["text"] as? String { appendUltron(t) }
        case "audio":
            if calls.inCall, (m["turn"] as? Int) != turn || !voiceOn { log("voice clip skipped (turn \(m["turn"] ?? "?") vs \(turn), voice \(voiceOn))") }
            if (m["turn"] as? Int) == turn, voiceOn, let u = m["url"] as? String, let url = URL(string: base + u) {
                voice.enqueue(url: url, turn: turn, rate: (m["rate"] as? Double) ?? 1, token: token)
            }
        case "notice":
            if let t = m["text"] as? String { append(Line(who: .ultron, text: t)); notify("ULTRON", t) }
        case "error":
            if let t = m["message"] as? String { append(Line(who: .ultron, text: t)) }
        case "files":
            files = decode(m["list"])
        case "file":
            if let f = decode([m["file"] as Any]).first {
                append(Line(who: .ultron, text: f.note ?? "", file: f))
                notify("ULTRON sent you a file", f.name)
            }
        case "phone_open":
            if let u = m["url"] as? String, let url = URL(string: u) { open(url, label: m["label"] as? String ?? "Open") }
        case "confirm_request":
            if let id = m["id"] as? Int {
                confirm = ConfirmRequest(id: id, command: m["command"] as? String ?? "")
                notify("ULTRON needs your OK", m["command"] as? String ?? "")
            }
        case "request_frame":
            reply(m["id"], NSNull())   // the camera tool runs in the browser version
        case "gui":
            reply(m["id"], ["ok": false, "error": "Interface tools only work in the browser version, not the iPhone app."])
        case "call":
            let id = m["id"]
            calls.incoming { [weak self] reason in
                guard let self else { return }
                var result: [String: Any] = ["ok": true]
                if let reason {
                    result = ["ok": false, "error": reason]
                    self.append(Line(who: .ultron, text: "Couldn't ring: \(reason)."))
                }
                self.reply(id, result)
                self.log(reason.map { "call refused: \($0)" } ?? "ringing")
                #if DEBUG
                if reason == nil && self.debugAnswer { self.calls.answer() }
                #endif
            }
        default:
            break
        }
    }

    private func decode(_ any: Any?) -> [RemoteFile] {
        guard let any, let data = try? JSONSerialization.data(withJSONObject: any) else { return [] }
        return (try? JSONDecoder().decode([RemoteFile].self, from: data)) ?? []
    }

    private func append(_ line: Line) {
        lines.append(line)
        if lines.count > 200 { lines.removeFirst(lines.count - 200) }
    }

    private func appendUltron(_ t: String) {
        voice.heard(t)
        if let id = ultronLine, let i = lines.firstIndex(where: { $0.id == id }) {
            lines[i].text += t
        } else {
            let trimmed = t.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return }
            let line = Line(who: .ultron, text: trimmed)
            ultronLine = line.id
            append(line)
        }
    }

    // MARK: Actions

    func say(_ text: String, files: [String] = [], interrupted: Bool = false) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty || !files.isEmpty else { return }
        voice.stopPlayback()
        let names = files.map { "📎 " + ($0 as NSString).lastPathComponent }
        append(Line(who: .you, text: ([t] + names).filter { !$0.isEmpty }.joined(separator: "  ")))
        ultronLine = nil
        send(["type": "user", "text": t, "files": files, "interrupted": interrupted])
    }

    func stop() {
        voice.stopPlayback()
        send(["type": "stop"])
    }

    func answerConfirm(_ ok: Bool) {
        guard let c = confirm else { return }
        reply(c.id, ok)
        confirm = nil
    }

    /// iOS only lets the app open other apps while it's on screen; otherwise leave a notification to tap.
    private func open(_ url: URL, label: String) {
        append(Line(who: .ultron, text: "", link: url, linkLabel: label))
        if UIApplication.shared.applicationState == .active { UIApplication.shared.open(url) }
        else { notify(label, "Tap to open", url: url) }
    }

    private func notify(_ title: String, _ body: String, url: URL? = nil) {
        guard !foreground || url != nil else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let url { content.userInfo = ["url": url.absoluteString] }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    // MARK: Files

    func upload(_ data: Data, name: String) async -> String? {
        guard let token, var comps = URLComponents(string: base + "/api/upload") else { return nil }
        comps.queryItems = [URLQueryItem(name: "name", value: name)]
        guard let url = comps.url else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(token, forHTTPHeaderField: "X-Ultron-Token")
        guard let (body, _) = try? await URLSession.shared.upload(for: req, from: data),
              let j = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], j["ok"] as? Bool == true else { return nil }
        return j["path"] as? String
    }

    func send(attachments: [(Data, String)], text: String) async {
        var paths: [String] = []
        for (data, name) in attachments {
            if let p = await upload(data, name: name) { paths.append(p) }
            else { append(Line(who: .ultron, text: "\(name) didn't upload.")) }
        }
        if !paths.isEmpty || !text.isEmpty { say(text, files: paths) }
    }

    /// A /files/... link tapped in the web interface: download it with the device token, then share.
    func share(path: String) {
        guard let url = URL(string: base + path), let token else { return }
        Task {
            var req = URLRequest(url: url)
            req.setValue(token, forHTTPHeaderField: "X-Ultron-Token")
            guard let (tmp, resp) = try? await URLSession.shared.download(for: req), (resp as? HTTPURLResponse)?.statusCode == 200 else { return }
            let dest = FileManager.default.temporaryDirectory.appendingPathComponent(resp.suggestedFilename ?? url.lastPathComponent)
            try? FileManager.default.removeItem(at: dest)
            guard (try? FileManager.default.moveItem(at: tmp, to: dest)) != nil else { return }
            shared = Shared(url: dest)
        }
    }

    func download(_ f: RemoteFile) async -> URL? {
        guard let u = f.url, let url = URL(string: base + u), let token else { return nil }
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "X-Ultron-Token")
        guard let (tmp, resp) = try? await URLSession.shared.download(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        let dest = FileManager.default.temporaryDirectory.appendingPathComponent(f.name)
        try? FileManager.default.removeItem(at: dest)
        do { try FileManager.default.moveItem(at: tmp, to: dest) } catch { return nil }
        return dest
    }
}
