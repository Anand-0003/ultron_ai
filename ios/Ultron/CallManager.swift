import AVFoundation
import CallKit

/// "ULTRON is calling": the real iOS incoming-call screen, over the Tailscale link instead of
/// the phone network, so it costs nothing. Works while the app is open or running in the
/// background (it stays alive while listening).
@MainActor
final class CallManager: NSObject, ObservableObject {
    @Published private(set) var inCall = false

    var onPrepareAudio: (() -> Void)?
    var onAnswer: (() -> Void)?
    var onEnd: ((_ answered: Bool) -> Void)?
    var onAudioActivated: (() -> Void)?

    private let provider: CXProvider
    private let controller = CXCallController()
    private var current: UUID?

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallsPerCallGroup = 1
        config.maximumCallGroups = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = true
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    private static func update() -> CXCallUpdate {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: "ULTRON")
        update.localizedCallerName = "ULTRON"
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsDTMF = false
        return update
    }

    /// From a VoIP push: iOS demands a reported call for every push, so a duplicate is shown and ended at once.
    func incomingFromPush(done: @escaping () -> Void) {
        guard current != nil else { return incoming { _ in done() } }
        let extra = UUID()
        provider.reportNewIncomingCall(with: extra, update: Self.update()) { [weak self] _ in
            Task { @MainActor in
                self?.provider.reportCall(with: extra, endedAt: nil, reason: .failed)
                done()
            }
        }
    }

    /// Rings the phone; `done` gets nil once iOS shows the call, or the reason it refused.
    func incoming(done: @escaping (String?) -> Void) {
        guard current == nil else { return done("A ULTRON call is already ringing or in progress") }
        let id = UUID()
        current = id
        provider.reportNewIncomingCall(with: id, update: Self.update()) { [weak self] error in
            let reason = error.map(Self.describe)
            Task { @MainActor in
                if reason != nil { self?.current = nil }
                done(reason)
            }
        }
    }

    nonisolated private static func describe(_ error: Error) -> String {
        switch (error as? CXErrorCodeIncomingCallError)?.code {
        case .filteredByDoNotDisturb: return "the iPhone blocked it because a Focus / Do Not Disturb is on"
        case .filteredByBlockList: return "the iPhone has ULTRON on its block list"
        case .unentitled: return "iOS didn't let the app ring from the background"
        case .callUUIDAlreadyExists: return "a ULTRON call is already in progress"
        default: return "iOS refused the call (\(error.localizedDescription))"
        }
    }

    #if DEBUG
    /// Test hook: pick up our own call (simulator runs can't tap the call screen).
    func answer() {
        guard let id = current else { return }
        controller.request(CXTransaction(action: CXAnswerCallAction(call: id))) { _ in }
    }
    #endif

    func hangUp() {
        guard let id = current else { return }
        controller.request(CXTransaction(action: CXEndCallAction(call: id))) { _ in }
    }

    fileprivate func answered() {
        inCall = true
        onAnswer?()
    }

    fileprivate func ended() {
        let wasAnswered = inCall
        current = nil
        inCall = false
        onEnd?(wasAnswered)
    }
}

extension CallManager: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in self.ended() }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        // Audio must be set up for a call before CallKit connects it.
        Task { @MainActor in
            self.onPrepareAudio?()
            action.fulfill()
            self.answered()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        action.fulfill()
        Task { @MainActor in self.ended() }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in self.onAudioActivated?() }
    }
}
