import SwiftUI
import WebKit

/// The full ULTRON interface (the same page as on the Mac) inside the app. Native code fills in
/// what an iPhone web view can't do: speech recognition (through a SpeechRecognition polyfill),
/// opening other apps, downloading/sharing files, and JS dialogs.
struct GuiView: UIViewRepresentable {
    let ultron: UltronClient

    func makeCoordinator() -> Coordinator { Coordinator(ultron) }
    func makeUIView(context: Context) -> WKWebView { context.coordinator.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        let webView: WKWebView
        private let ultron: UltronClient

        init(_ ultron: UltronClient) {
            self.ultron = ultron
            let config = WKWebViewConfiguration()
            config.allowsInlineMediaPlayback = true
            config.mediaTypesRequiringUserActionForPlayback = []
            config.applicationNameForUserAgent = "UltronApp"   // the page checks this
            let content = WKUserContentController()
            content.addUserScript(WKUserScript(source: Self.bridge(token: ultron.token ?? ""), injectionTime: .atDocumentStart, forMainFrameOnly: true))
            config.userContentController = content
            webView = WKWebView(frame: .zero, configuration: config)
            super.init()
            content.add(WeakHandler(self), name: "ultron")
            webView.navigationDelegate = self
            webView.uiDelegate = self
            webView.isOpaque = false
            webView.backgroundColor = UIColor(ultronBackground)
            webView.scrollView.backgroundColor = UIColor(ultronBackground)
            webView.scrollView.contentInsetAdjustmentBehavior = .never   // the page uses env(safe-area-inset-*)
            webView.scrollView.bounces = false
            if #available(iOS 16.4, *) { webView.isInspectable = true }   // Safari -> Develop -> iPhone, for debugging
            ultron.voice.webResults = { [weak self] text, final in
                self?.run("window.__ultronSR && window.__ultronSR(\(Self.js(text)), \(final))")
            }
            ultron.voice.webEnded = { [weak self] in self?.run("window.__ultronSREnd && window.__ultronSREnd()") }
            ultron.voice.onSpeakingChange = { [weak self] on in self?.run("window.__ultronSpeaking && window.__ultronSpeaking(\(on))") }
            ultron.voice.onLevel = { [weak self] level in self?.run("window.__ultronLevel && window.__ultronLevel(\(level))") }
            ultron.onResume = { [weak self] in self?.run("window.__ultronResume && window.__ultronResume()") }
            load()
        }

        private var baseHost: String? { URL(string: ultron.baseURL)?.host }

        func load() {
            guard let token = ultron.token, let url = URL(string: ultron.baseURL), let host = url.host,
                  let cookie = HTTPCookie(properties: [.name: "ultron_device", .value: token, .domain: host, .path: "/",
                                                       .expires: Date().addingTimeInterval(365 * 86400)]) else { return }
            webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
                self?.webView.load(URLRequest(url: url))
            }
        }

        private func run(_ script: String) { webView.evaluateJavaScript(script, completionHandler: nil) }

        private static func js(_ s: String) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
            return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
        }

        /// SpeechRecognition backed by the app's recognizer, plus the device token for the page.
        private static func bridge(token: String) -> String {
            """
            (() => {
              try { localStorage.setItem('fri.device', \(js(token))); } catch {}
              const native = window.webkit.messageHandlers.ultron;
              let live = null;
              class NativeSpeechRecognition {
                constructor() { this.continuous = false; this.interimResults = false; this.lang = 'en-US'; this.onresult = this.onend = this.onerror = null; this._done = []; }
                start() { if (live && live !== this) live.abort(); live = this; this._done = []; native.postMessage({ cmd: 'sr_start', continuous: !!this.continuous }); }
                stop() { this.abort(); }
                abort() { if (live !== this) return; live = null; native.postMessage({ cmd: 'sr_stop' }); setTimeout(() => this.onend && this.onend(), 0); }
              }
              window.__ultronSR = (text, isFinal) => {
                const r = live; if (!r) return;
                const cur = Object.assign([{ transcript: text }], { isFinal });
                const results = [...r._done, cur];
                if (isFinal) r._done.push(cur);
                r.onresult && r.onresult({ results, resultIndex: r._done.length });
                if (isFinal && !r.continuous) { live = null; native.postMessage({ cmd: 'sr_stop' }); setTimeout(() => r.onend && r.onend(), 0); }
              };
              window.__ultronSREnd = () => { const r = live; live = null; r && r.onend && r.onend(); };
              window.SpeechRecognition = window.webkitSpeechRecognition = NativeSpeechRecognition;
            })();
            """
        }

        // MARK: Messages from the page

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            let body = message.body as? [String: Any] ?? [:]
            switch body["cmd"] as? String {
            case "sr_start": ultron.voice.startWebRecognition(continuous: body["continuous"] as? Bool ?? false)
            case "sr_stop": ultron.voice.stopWebRecognition()
            case "settings": ultron.showSettings = true
            // Her voice: the page hands every clip to the native player.
            case "play":
                if let u = body["url"] as? String, let url = URL(string: ultron.baseURL + u) {
                    ultron.voice.enqueue(url: url, turn: body["turn"] as? Int ?? 0, rate: body["rate"] as? Double ?? 1, token: ultron.token)
                }
            case "stop_audio": ultron.voice.stopPlayback()
            case "turn": ultron.voice.dropTurns(before: body["turn"] as? Int ?? 0)
            case "volume": ultron.voice.setVolume(Float(body["value"] as? Double ?? 1))
            default: break
            }
        }

        // MARK: Navigation

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.allow) }
            let scheme = url.scheme?.lowercased() ?? ""
            // spotify:, sms:, tel:, shortcuts:// ... belong to other apps.
            if !["http", "https", "about", "blob", "data"].contains(scheme) {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            if url.host == baseHost, url.path.hasPrefix("/files/") {
                ultron.share(path: url.path)
                return decisionHandler(.cancel)
            }
            if url.host != baseHost, action.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if url.host == baseHost, url.path.hasPrefix("/files/") { ultron.share(path: url.path) } else { UIApplication.shared.open(url) }
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            // The Mac is off or out of reach: keep trying.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.load() }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { load() }

        // MARK: Dialogs and permissions

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(alert) ?? completionHandler()
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            present(alert) ?? completionHandler(false)
        }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host == baseHost ? .grant : .deny)   // the camera for "what do you see?"
        }

        private func present(_ vc: UIViewController) -> Void? {
            var top = webView.window?.rootViewController
            while let next = top?.presentedViewController { top = next }
            guard let top else { return nil }
            top.present(vc, animated: true)
            return ()
        }
    }
}

/// WKUserContentController holds its handlers strongly; this keeps it from retaining the coordinator.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}
