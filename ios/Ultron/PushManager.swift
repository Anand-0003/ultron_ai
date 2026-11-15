import Foundation
import PushKit

/// VoIP push: how the Mac rings this phone while it's locked or the app is closed. Apple wakes
/// (or launches) the app with the push, and iOS requires that we show a CallKit call right away.
final class PushManager: NSObject, PKPushRegistryDelegate {
    var onToken: ((String) -> Void)?
    /// (reason, done): show the call, then call `done` once CallKit has it.
    var onCall: ((String, @escaping () -> Void) -> Void)?

    private let registry = PKPushRegistry(queue: .main)

    override init() {
        super.init()
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        let token = credentials.token.map { String(format: "%02x", $0) }.joined()
        DispatchQueue.main.async { self.onToken?(token) }
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType,
                      completion: @escaping () -> Void) {
        let reason = payload.dictionaryPayload["reason"] as? String ?? ""
        guard let onCall else { return completion() }
        onCall(reason, completion)
    }
}
