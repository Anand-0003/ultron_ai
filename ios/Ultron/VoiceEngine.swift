import AVFoundation
import Speech

/// Mic in, ULTRON's voice out, through one AVAudioEngine with iOS voice processing on, so the
/// hardware echo canceller removes her own voice from the mic and you can talk over her.
@MainActor
final class VoiceEngine: ObservableObject {
    @Published private(set) var listening = false
    @Published private(set) var speaking = false
    @Published private(set) var hearing = ""   // what the mic is picking up right now
    @Published private(set) var problem: String?

    var onUtterance: ((String, Bool) -> Void)?   // (text, interrupted her)
    var onBargeIn: (() -> Void)?
    var log: ((String) -> Void)?
    // The web interface's SpeechRecognition polyfill: raw results go to the page, which does its own
    // wake word, endpointing and echo filtering, exactly like in a desktop browser.
    var webResults: ((String, Bool) -> Void)?
    var webEnded: (() -> Void)?
    private(set) var webMode = false
    private var webStop: Task<Void, Never>?
    private(set) var backgroundListening = false
    var onSpeakingChange: ((Bool) -> Void)?
    var onLevel: ((Float) -> Void)?   // her voice level, ~15 times a second, for the bubble

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let varispeed = AVAudioUnitVarispeed()
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
    private let recognizer = SFSpeechRecognizer()
    private let feed = RequestFeed()
    private var task: SFSpeechRecognitionTask?
    private var generation = 0
    private var endpoint: Task<Void, Never>?
    private var configured = false
    private var callMode = false   // during a call CallKit owns (and activates) the audio session

    private var slots: [Slot] = []
    private var current: Slot?
    private var playID = 0         // completions from older schedules are ignored

    // Echo filter, in case some of her voice still gets through.
    private var spokenRecent = ""
    private var speechEndedAt = Date.distantPast
    private var ignoredPrefix = ""
    private var freshText = ""
    private var bargedIn = false
    private var heardThisTask = false

    private final class Slot: @unchecked Sendable {
        let turn: Int, rate: Double
        var buffer: AVAudioPCMBuffer?
        var failed = false
        init(turn: Int, rate: Double) { self.turn = turn; self.rate = rate }
    }

    init() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let ended = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.ended.rawValue
            if ended { Task { @MainActor in self?.recover() } }
        }
        nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.recover() }
        }
    }

    // MARK: Engine

    private func startEngine() throws {
        let session = AVAudioSession.sharedInstance()
        if !callMode {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP, .mixWithOthers])
            try session.setActive(true)
        }
        if !configured {
            let input = engine.inputNode
            do { try input.setVoiceProcessingEnabled(true) } catch { log?("echo cancellation unavailable: \(error.localizedDescription)") }
            if #available(iOS 17.0, *) {
                input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
            }
            engine.attach(player)
            engine.attach(varispeed)
            engine.connect(player, to: varispeed, format: playFormat)
            engine.connect(varispeed, to: engine.mainMixerNode, format: playFormat)
            varispeed.installTap(onBus: 0, bufferSize: 2048, format: playFormat, block: Self.levelTap(self))
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0), block: Self.tap(feed))
            configured = true
        }
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
            log?("audio engine started (\(callMode ? "call" : "normal") mode, route: \(session.currentRoute.outputs.map(\.portName).joined(separator: ", ")))")
        }
    }

    /// The engine only runs while it has a job, so the mic indicator goes away when you turn listening off.
    private func stopEngineIfIdle() {
        guard !listening, !speaking, slots.isEmpty, !callMode else { return }
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// After a phone call, Siri, another app grabbing audio, a route change, or CallKit activating audio.
    func recover() {
        guard listening || speaking || !slots.isEmpty || current != nil else { return }
        do { try startEngine() } catch { report("Audio didn't start: \(error.localizedDescription)"); return }
        if listening { restartRecognition() }
        // A stopped engine drops whatever was scheduled: replay the current sentence from the top.
        if let c = current {
            current = nil
            slots.insert(c, at: 0)
            playID += 1
            player.stop()
        }
        pump()
    }

    private func report(_ message: String) {
        problem = message
        log?(message)
    }

    nonisolated private static func levelTap(_ owner: VoiceEngine) -> AVAudioNodeTapBlock {
        var last = 0.0
        return { [weak owner] buffer, _ in
            guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            let now = ProcessInfo.processInfo.systemUptime
            guard now - last > 0.06 else { return }
            last = now
            var sum: Float = 0
            for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
            let level = min(1, sqrt(sum / Float(buffer.frameLength)) * 4)
            Task { @MainActor in owner?.onLevel?(level) }
        }
    }

    func setVolume(_ v: Float) { player.volume = max(0, min(1, v)) }

    nonisolated private static func tap(_ feed: RequestFeed) -> AVAudioNodeTapBlock {
        { buffer, _ in feed.append(buffer) }
    }

    // MARK: Calls

    /// Call audio: voice-chat mode through the earpiece (or speaker/headphones from the call screen).
    /// CallKit activates the session itself, then calls `callAudioActivated`.
    func prepareForCall() {
        endWebMode()   // the call is a native conversation
        callMode = true
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
        } catch { log?("call audio setup failed: \(error.localizedDescription)") }
    }

    func callAudioActivated() {
        log?("call audio activated")
        recover()
        if !listening { setListening(true) }
    }

    func endCall() {
        guard callMode else { return }
        callMode = false
        stopPlayback()
        engine.stop()
        if listening { recover() } else { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }

    // MARK: Web interface recognition

    func startWebRecognition(continuous: Bool) {
        webStop?.cancel()
        guard !callMode else { return webEnded?() ?? () }
        webMode = true
        if listening { restartRecognition() } else { setListening(true) }
    }

    /// The page stops and restarts recognition after every sentence; wait a moment before shutting
    /// the engine down so that doesn't bounce the audio hardware each time.
    func stopWebRecognition() {
        guard webMode else { return }
        endRecognition()
        webStop?.cancel()
        webStop = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let self, !Task.isCancelled, self.webMode else { return }
            self.webMode = false
            self.setListening(false)
        }
    }

    private func endWebMode() {
        webStop?.cancel()
        guard webMode else { return }
        webMode = false
        endRecognition()
        webEnded?()
    }

    /// Leaving the app: the page is about to be frozen, so native listening takes over.
    func handToNative() {
        guard !callMode, webMode else {
            log?("left the app: not listening in the interface, so the mic goes off")
            return
        }
        log?("left the app: the iPhone keeps listening")
        endWebMode()
        backgroundListening = true
        setListening(true)
    }

    /// Back in the app: the page picks recognition up again by itself.
    func handBackToWeb() {
        guard backgroundListening, !callMode else { return }
        backgroundListening = false
        setListening(false)
    }

    private func webFinal() {
        let text = freshText.trimmingCharacters(in: .whitespacesAndNewlines)
        restartRecognition()
        if !text.isEmpty { webResults?(text, true) }
    }

    // MARK: Listening

    func setListening(_ on: Bool) {
        if !on {
            listening = false
            endRecognition()
            hearing = ""
            stopEngineIfIdle()
            return
        }
        SFSpeechRecognizer.requestAuthorization { status in
            Task { @MainActor in
                guard status == .authorized else { self.report("Allow Speech Recognition for ULTRON in Settings."); return }
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    Task { @MainActor in
                        guard granted else { self.report("Allow the microphone for ULTRON in Settings."); return }
                        self.problem = nil
                        self.listening = true
                        do { try self.startEngine() } catch {
                            // During a call this is expected until CallKit activates the audio.
                            if !self.callMode { self.report("Audio didn't start: \(error.localizedDescription)") }
                            return
                        }
                        self.restartRecognition()
                    }
                }
            }
        }
    }

    private func beginRecognition() {
        guard listening, task == nil, let recognizer else { return }
        guard recognizer.isAvailable else { log?("speech recognizer unavailable right now"); return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        feed.set(request)
        generation += 1
        heardThisTask = false
        task = recognizer.recognitionTask(with: request, resultHandler: Self.results(self, generation))
        if callMode { log?("listening on the call (on-device: \(request.requiresOnDeviceRecognition))") }
    }

    nonisolated private static func results(_ owner: VoiceEngine, _ gen: Int) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { [weak owner] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let failed = error != nil
            let reason = error.map { "\(($0 as NSError).domain) \(($0 as NSError).code): \($0.localizedDescription)" }
            Task { @MainActor in
                if let reason, !(reason.contains("216") || reason.contains("1110")) { owner?.log?("speech recognition error: \(reason)") }   // 216 = cancelled, 1110 = no speech
                owner?.onResult(text, final: final, failed: failed, gen: gen)
            }
        }
    }

    private func endRecognition() {
        endpoint?.cancel()
        endpoint = nil
        task?.cancel()
        task = nil
        feed.set(nil)
        ignoredPrefix = ""
        freshText = ""
    }

    private func restartRecognition() {
        endRecognition()
        beginRecognition()
    }

    private var inEchoWindow: Bool { speaking || Date().timeIntervalSince(speechEndedAt) < 1.2 }

    private func onResult(_ text: String?, final: Bool, failed: Bool, gen: Int) {
        guard gen == generation else { return }   // a task we already replaced
        guard let text, !text.isEmpty else {
            if failed || final { restartRecognition() }
            return
        }
        if webMode {
            freshText = text
            webResults?(text, false)
            endpoint?.cancel()
            if final { webFinal(); return }
            endpoint = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 800_000_000)
                guard !Task.isCancelled else { return }
                self?.webFinal()
            }
            return
        }
        if !heardThisTask { heardThisTask = true; if callMode { log?("mic picks up speech on the call") } }
        let fresh = text.hasPrefix(ignoredPrefix) ? String(text.dropFirst(ignoredPrefix.count)) : text
        if inEchoWindow && !bargedIn {
            guard fromUser(fresh) else { ignoredPrefix = text; return }   // her own voice: skip past it
            bargedIn = true
            stopPlayback()
            onBargeIn?()
        }
        freshText = fresh
        hearing = fresh.trimmingCharacters(in: .whitespaces)
        endpoint?.cancel()
        if final { flush(); return }
        endpoint = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)   // you stopped talking
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }

    private func flush() {
        let text = freshText.trimmingCharacters(in: .whitespacesAndNewlines)
        let interrupted = bargedIn
        bargedIn = false
        hearing = ""
        restartRecognition()
        guard text.filter({ $0.isLetter || $0.isNumber }).count >= 2 else { return }
        // "Stop" / "wait" on its own just shuts her up.
        if text.range(of: #"^(stop|wait|shut up|enough|quiet|be quiet|pause|hold on|never ?mind|ok(ay)?)\W*$"#, options: [.regularExpression, .caseInsensitive]) != nil { return }
        log?("heard: \(text)")
        onUtterance?(text, interrupted)
    }

    func heard(_ text: String) {
        spokenRecent = String((spokenRecent + " " + text).suffix(1500))
    }

    private static func words(_ t: String) -> [String] {
        t.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }

    private func fromUser(_ text: String) -> Bool {
        let w = Self.words(text)
        guard !w.isEmpty else { return false }
        let mine = Set(Self.words(spokenRecent))
        let novel = w.filter { !mine.contains($0) }
        if novel.contains(where: { ["stop", "wait", "ultron", "quiet", "enough", "pause", "hold", "shut"].contains($0) }) { return true }
        return novel.count >= 3 || (novel.count >= 2 && Double(novel.count) / Double(w.count) >= 0.4)
    }

    // MARK: Speaking

    func enqueue(url: URL, turn: Int, rate: Double, token: String?) {
        let slot = Slot(turn: turn, rate: rate)
        slots.append(slot)
        let format = playFormat
        Task {
            var req = URLRequest(url: url)
            if let token { req.setValue(token, forHTTPHeaderField: "X-Ultron-Token") }
            do {
                let (tmp, resp) = try await URLSession.shared.download(for: req)
                let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if status == 200 { slot.buffer = Self.load(tmp, as: format) }
                if slot.buffer == nil { log?("voice clip unusable (HTTP \(status)) \(url.lastPathComponent)") }
            } catch {
                log?("voice clip download failed: \(error.localizedDescription)")
            }
            if slot.buffer == nil { slot.failed = true }
            pump()
        }
    }

    /// Read a downloaded WAV and convert it to the player's format.
    nonisolated private static func load(_ tmp: URL, as format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let wav = tmp.appendingPathExtension("wav")
        try? FileManager.default.moveItem(at: tmp, to: wav)
        defer { try? FileManager.default.removeItem(at: wav) }
        guard let file = try? AVAudioFile(forReading: wav),
              let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: src)) != nil,
              let converter = AVAudioConverter(from: src.format, to: format) else { return nil }
        let capacity = AVAudioFrameCount(Double(src.frameLength) * format.sampleRate / src.format.sampleRate) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .endOfStream; return nil }
            fed = true
            status.pointee = .haveData
            return src
        }
        return error == nil && out.frameLength > 0 ? out : nil
    }

    private func pump() {
        guard current == nil else { return }
        while let head = slots.first, head.failed { slots.removeFirst() }
        guard let head = slots.first, let buffer = head.buffer else {
            if slots.isEmpty { setSpeaking(false) }
            return
        }
        // Keep the clip queued if audio can't start yet (e.g. a call that hasn't connected its audio).
        do { try startEngine() } catch {
            if !callMode { report("Audio didn't start: \(error.localizedDescription)") } else { log?("call audio not ready yet: \(error.localizedDescription)") }
            return
        }
        slots.removeFirst()
        current = head
        playID += 1
        if callMode { log?("playing her voice on the call (\(AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portName).joined(separator: ", ")))") }
        varispeed.rate = Float(head.rate)   // the server pre-compensated tempo for this pitch shift
        setSpeaking(true)
        player.scheduleBuffer(buffer, completionHandler: Self.done(self, playID))
        if !player.isPlaying { player.play() }
    }

    nonisolated private static func done(_ owner: VoiceEngine, _ id: Int) -> @Sendable () -> Void {
        { [weak owner] in Task { @MainActor in owner?.finished(id) } }
    }

    private func finished(_ id: Int) {
        guard id == playID, current != nil else { return }
        current = nil
        pump()
    }

    private func setSpeaking(_ on: Bool) {
        guard speaking != on else { return }
        speaking = on
        onSpeakingChange?(on)
        if !on {
            speechEndedAt = Date()
            stopEngineIfIdle()
        }
    }

    func stopPlayback() {
        slots.removeAll()
        current = nil
        playID += 1
        if configured { player.stop() }
        setSpeaking(false)
    }

    func dropTurns(before turn: Int) {
        slots.removeAll { $0.turn < turn }
        if let c = current, c.turn < turn {
            current = nil
            playID += 1
            player.stop()
            pump()
        }
    }
}

/// Hands mic buffers from the audio thread to whichever recognition request is current.
final class RequestFeed: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func set(_ r: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        let old = request
        request = r
        lock.unlock()
        old?.endAudio()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let r = request
        lock.unlock()
        r?.append(buffer)
    }
}
