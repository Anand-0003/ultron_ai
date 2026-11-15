import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

let accent = Color(red: 0.71, green: 0.36, blue: 1.0)
let accentSoft = Color(red: 0.84, green: 0.66, blue: 1.0)
let ultronBackground = Color(red: 0.03, green: 0.01, blue: 0.06)

struct RootView: View {
    @EnvironmentObject var ultron: UltronClient

    var body: some View {
        ZStack {
            ultronBackground.ignoresSafeArea()
            if !ultron.paired { PairView() }
            else if ultron.simpleScreen { MainView(voice: ultron.voice, calls: ultron.calls) }
            else { GuiView(ultron: ultron).ignoresSafeArea() }
        }
        .tint(accent)
        .sheet(isPresented: $ultron.showSettings) { SettingsView(voice: ultron.voice) }
        .sheet(item: $ultron.shared) { ShareSheet(url: $0.url) }
    }
}

// MARK: Pairing

struct PairView: View {
    @EnvironmentObject var ultron: UltronClient
    @State private var code = ""
    @State private var error: String?
    @State private var working = false

    var body: some View {
        VStack(spacing: 18) {
            Orb(speaking: false, listening: false, thinking: working).frame(height: 220)
            Text("PAIR WITH YOUR MAC").font(.system(size: 15, weight: .semibold, design: .monospaced)).tracking(4).foregroundStyle(accent)
            Text("On the Mac, open Phone link in ULTRON and press Pair a phone, then type the code.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            TextField("Mac address", text: $ultron.server)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                .font(.system(.footnote, design: .monospaced)).padding(12).background(field)
            TextField("6-digit code", text: $code)
                .keyboardType(.numberPad).multilineTextAlignment(.center)
                .font(.system(size: 28, weight: .medium, design: .monospaced)).padding(14).background(field)
            Button {
                working = true
                Task { error = await ultron.pair(code: code); working = false }
            } label: {
                Text(working ? "PAIRING…" : "PAIR").font(.system(.subheadline, design: .monospaced)).tracking(4).frame(maxWidth: .infinity).padding(14)
            }
            .buttonStyle(.borderedProminent).disabled(code.filter(\.isNumber).count != 6 || working)
            if let error { Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center) }
        }
        .padding(28)
    }

    private var field: some View { RoundedRectangle(cornerRadius: 4).stroke(accent.opacity(0.5)) }
}

// MARK: Main

struct MainView: View {
    @EnvironmentObject var ultron: UltronClient
    @ObservedObject var voice: VoiceEngine
    @ObservedObject var calls: CallManager
    @State private var text = ""
    @State private var showFiles = false
    @State private var picks: [PhotosPickerItem] = []
    @State private var importing = false
    @FocusState private var typing: Bool

    private var status: String {
        if !ultron.connected { return "CONNECTING…" }
        if calls.inCall { return "ON A CALL" }
        if voice.speaking { return "SPEAKING" }
        if ultron.busy { return "PROCESSING" }
        return voice.listening ? "LISTENING" : "STANDING BY"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Orb(speaking: voice.speaking, listening: voice.listening && !voice.speaking, thinking: ultron.busy && !voice.speaking)
                .frame(height: typing ? 110 : 230)
                .onTapGesture { voice.speaking ? ultron.stop() : voice.setListening(!voice.listening) }
            Text(status).font(.system(size: 12, design: .monospaced)).tracking(5).foregroundStyle(accentSoft).padding(.bottom, 8)
            if let problem = voice.problem { Text(problem).font(.footnote).foregroundStyle(.orange).padding(.horizontal) }
            Transcript(lines: ultron.lines)
            if !voice.hearing.isEmpty {
                Text(voice.hearing).italic().foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 4)
            }
            inputBar
        }
        .animation(.easeInOut(duration: 0.25), value: typing)
        .sheet(isPresented: $showFiles) { FilesView() }
        .alert("Authorization required", isPresented: Binding(get: { ultron.confirm != nil }, set: { if !$0 { ultron.answerConfirm(false) } }),
               presenting: ultron.confirm) { _ in
            Button("Deny", role: .cancel) { ultron.answerConfirm(false) }
            Button("Authorize") { ultron.answerConfirm(true) }
        } message: { c in Text(c.command) }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            let items: [(Data, String)] = urls.compactMap { url in
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                return (try? Data(contentsOf: url)).map { ($0, url.lastPathComponent) }
            }
            sendAttachments(items)
        }
        .onChange(of: picks) { items in
            guard !items.isEmpty else { return }
            picks = []
            Task {
                var out: [(Data, String)] = []
                for (i, item) in items.enumerated() {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                    let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                    out.append((data, "Photo \(Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false)).replacingOccurrences(of: ":", with: "."))\(items.count > 1 ? "-\(i + 1)" : "").\(ext)"))
                }
                sendAttachments(out)
            }
        }
    }

    private var header: some View {
        HStack {
            Text("ULTRON").font(.system(size: 18, weight: .heavy, design: .monospaced)).tracking(5).foregroundStyle(accent)
            Spacer()
            if calls.inCall {
                Button { calls.hangUp() } label: { Image(systemName: "phone.down.fill").foregroundStyle(.red) }.padding(.trailing, 8)
            }
            Button { showFiles = true } label: { Image(systemName: "tray.full") }
            Button { ultron.showSettings = true } label: { Image(systemName: "slider.horizontal.3") }.padding(.leading, 12)
        }
        .font(.title3).padding(.horizontal, 18).padding(.top, 8)
    }

    private var inputBar: some View {
        HStack(spacing: 10) {
            Button { voice.setListening(!voice.listening) } label: {
                Image(systemName: voice.listening ? "mic.fill" : "mic.slash")
                    .frame(width: 46, height: 46).background(Circle().fill(accent.opacity(voice.listening ? 0.3 : 0.08)))
                    .overlay(Circle().stroke(accent.opacity(0.6)))
            }
            Menu {
                PhotosPicker(selection: $picks, maxSelectionCount: 10, matching: .any(of: [.images, .videos, .screenshots])) {
                    Label("Photos & screenshots", systemImage: "photo")
                }
                Button { importing = true } label: { Label("Files", systemImage: "folder") }
            } label: {
                Image(systemName: "paperclip").frame(width: 38, height: 38).overlay(Circle().stroke(accent.opacity(0.4)))
            }
            TextField("Talk or type…", text: $text, axis: .vertical)
                .lineLimit(1...4).focused($typing).submitLabel(.send)
                .onSubmit(send)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 4).stroke(accent.opacity(0.5)))
            Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 30)) }
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func send() {
        ultron.say(text)
        text = ""
    }

    private func sendAttachments(_ items: [(Data, String)]) {
        guard !items.isEmpty else { return }
        let message = text
        text = ""
        Task { await ultron.send(attachments: items, text: message) }
    }
}

// MARK: Pieces

struct Orb: View {
    let speaking: Bool, listening: Bool, thinking: Bool

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let pulse = speaking ? 0.07 * sin(t * 9) + 0.05 * sin(t * 14.3) : listening ? 0.035 * sin(t * 3) : 0.015 * sin(t * 1.4)
            GeometryReader { geo in
                let d = min(geo.size.width, geo.size.height)
                ZStack {
                    Circle().stroke(accent.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [2, 6]))
                        .frame(width: d * 0.95).rotationEffect(.radians(t * 0.25))
                    Circle().trim(from: 0, to: 0.28).stroke(accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .frame(width: d * 0.86).rotationEffect(.radians(t * (thinking ? 2.6 : 0.7)))
                    Circle().trim(from: 0.5, to: 0.72).stroke(accent.opacity(0.6), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .frame(width: d * 0.78).rotationEffect(.radians(-t * 0.55))
                    Circle()
                        .fill(RadialGradient(colors: [Color(white: 0.98), Color(red: 0.85, green: 0.35, blue: 1), accent.opacity(0)],
                                             center: .center, startRadius: 1, endRadius: d * 0.36))
                        .frame(width: d * 0.72).scaleEffect(1 + pulse)
                        .shadow(color: accent.opacity(speaking ? 0.9 : 0.5), radius: speaking ? 30 : 16)
                }
                .frame(width: geo.size.width, height: geo.size.height)
            }
        }
    }
}

struct Transcript: View {
    let lines: [Line]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(lines) { LineView(line: $0).id($0.id) }
                }
                .padding(.horizontal, 16).padding(.vertical, 6)
            }
            .onChange(of: lines.last?.text) { _ in
                if let id = lines.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
            }
            .onChange(of: lines.count) { _ in
                if let id = lines.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
            }
        }
    }
}

struct LineView: View {
    let line: Line

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(line.who == .you ? "YOU" : "ULTRON")
                .font(.system(size: 9, design: .monospaced)).tracking(2)
                .foregroundStyle(line.who == .you ? Color.secondary : accent)
                .frame(width: 50, alignment: .trailing).padding(.top, 4)
            VStack(alignment: .leading, spacing: 8) {
                if !line.text.isEmpty {
                    Text(line.text).foregroundStyle(line.who == .you ? Color(red: 0.56, green: 0.72, blue: 0.81) : .primary).textSelection(.enabled)
                }
                if let file = line.file { FileCard(file: file) }
                if let link = line.link {
                    Link(destination: link) {
                        Text((line.linkLabel ?? "Open").uppercased()).font(.system(size: 12, design: .monospaced)).tracking(3)
                            .padding(.horizontal, 16).padding(.vertical, 10).overlay(Rectangle().stroke(accent.opacity(0.6)))
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct Shared: Identifiable {
    let id = UUID()
    let url: URL
}

struct FileCard: View {
    @EnvironmentObject var ultron: UltronClient
    let file: RemoteFile
    @State private var preview: UIImage?
    @State private var shared: Shared?
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let preview { Image(uiImage: preview).resizable().scaledToFit().frame(maxHeight: 220) }
            Text("\(file.dir == "to_mac" ? "↑ Mac" : "↓ Phone") · \(file.name) · \(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))")
                .font(.footnote).foregroundStyle(.secondary)
            if file.url != nil {
                Button {
                    loading = true
                    Task {
                        if let url = await ultron.download(file) { shared = Shared(url: url) }
                        loading = false
                    }
                } label: {
                    Label(loading ? "Getting it…" : "Save or share", systemImage: "square.and.arrow.up").font(.footnote)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(10)
        .overlay(Rectangle().stroke(accent.opacity(0.3)))
        .task {
            guard file.isImage, file.size < 25_000_000, preview == nil, let url = await ultron.download(file) else { return }
            preview = UIImage(contentsOfFile: url.path)
        }
        .sheet(item: $shared) { ShareSheet(url: $0.url) }
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

struct FilesView: View {
    @EnvironmentObject var ultron: UltronClient

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if ultron.files.isEmpty { Text("Nothing sent yet. Ask ULTRON to send you something from the Mac.").foregroundStyle(.secondary) }
                    ForEach(ultron.files) { FileCard(file: $0) }
                }
                .padding()
            }
            .navigationTitle("Files")
            .background(ultronBackground)
        }
        .preferredColorScheme(.dark)
    }
}

struct SettingsView: View {
    @EnvironmentObject var ultron: UltronClient
    @ObservedObject var voice: VoiceEngine
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Keep listening in other apps", isOn: $ultron.listenInBackground)
                    Toggle("Simple screen instead of the full interface", isOn: $ultron.simpleScreen)
                } footer: {
                    Text("With listening on in the interface (Always listening, or the mic), leaving the app hands the conversation to the iPhone so you can keep talking from other apps.")
                }
                if ultron.simpleScreen {
                    Section {
                        Toggle("Listening (talk any time)", isOn: Binding(get: { voice.listening }, set: { voice.setListening($0) }))
                        Toggle("Voice replies", isOn: $ultron.voiceOn)
                    } footer: {
                        Text("Tap the bubble to start or stop listening, or to cut her off.")
                    }
                }
                Section {
                    LabeledContent("Mac", value: ultron.server)
                    LabeledContent("Link", value: ultron.connected ? "Connected" : "Connecting…")
                } footer: {
                    Text("Ask ULTRON to “call me” and your iPhone rings with the real call screen. It's free, over Tailscale, and works while the app is open or listening in the background.")
                }
                Section {
                    Button("Unpair this iPhone", role: .destructive) { ultron.unpair(); dismiss() }
                }
            }
            .navigationTitle("ULTRON")
            .toolbar { Button("Done") { dismiss() } }
        }
        .preferredColorScheme(.dark)
    }
}
