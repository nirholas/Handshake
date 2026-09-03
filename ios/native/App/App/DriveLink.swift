import AVFoundation
import Foundation
import WebKit

/// The single channel between the CarPlay templates on the car screen and the
/// `/drive` page running in the app's WebView on the phone.
///
/// CarPlay's voice-based conversational category does not hand an app a drawing
/// surface: the car screen is Apple's templates, and nothing else. So the
/// conversation, the agent, its voice and its 3D face all stay in the WebView,
/// and this object is the wire between them. The page posts its state out
/// (`window.webkit.messageHandlers.threeWsDrive`), and template presses go back
/// in as `window.threeWsDrive.command({ type })`. Both halves of that protocol
/// live in `src/drive/bridge.js`.
///
/// It also owns the audio session, because CarPlay requires a conversational
/// app to hold one open only while voice is actually in use.
final class DriveLink: NSObject {

    static let shared = DriveLink()

    enum State: String {
        case idle, listening, transcribing, thinking, speaking

        /// Is a turn in flight? The car screen shows the voice template for
        /// exactly this window and returns to the list outside it.
        var isActive: Bool { self != .idle }
    }

    struct Action {
        let id: String
        let label: String
        let enabled: Bool
    }

    /// Name of the WebKit message handler. Must match `src/drive/bridge.js`.
    private static let channel = "threeWsDrive"
    private static let protocolVersion = 1

    private(set) var state: State = .idle
    private(set) var agentName: String?
    private(set) var lastSpoken: String?
    private(set) var lastHeard: String?
    private(set) var lastError: String?
    private(set) var actions: [Action] = []

    /// Called on the main queue whenever anything above changes.
    var onChange: (() -> Void)?

    private weak var webView: WKWebView?
    private var audioSessionActive = false

    // MARK: - Attachment

    /// Register on the app's WebView. Safe to call more than once.
    func attach(to webView: WKWebView) {
        if self.webView === webView { return }
        detach()
        self.webView = webView
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.channel)
        controller.add(self, name: Self.channel)
    }

    func detach() {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.channel)
        webView = nil
    }

    // MARK: - Outbound: car screen to page

    /// Send a command the page understands. See `onNativeCommand` in
    /// `src/drive/index.js` for the accepted types.
    func send(_ type: String, value: String? = nil) {
        guard let webView else { return }
        var payload: [String: Any] = ["type": type]
        if let value { payload["value"] = value }
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else { return }
        // Optional chaining on the page side: a command that arrives before the
        // page has booted is dropped rather than throwing into the console.
        webView.evaluateJavaScript("window.threeWsDrive?.command(\(json));", completionHandler: nil)
    }

    /// Point the phone's WebView at the car surface. Called when the CarPlay
    /// scene connects, which only happens when the driver launches three.ws
    /// from the CarPlay home screen: navigating then is what they asked for.
    /// The previous page is remembered so disconnecting puts them back.
    func openDriveSurface() {
        guard let webView else { return }
        let current = webView.url
        if current?.path.hasPrefix("/drive") != true {
            returnURL = current
        }
        var components = URLComponents()
        components.scheme = "https"
        components.host = current?.host ?? "three.ws"
        components.path = "/drive"
        components.queryItems = [URLQueryItem(name: "surface", value: "carplay")]
        guard let url = components.url else { return }
        webView.load(URLRequest(url: url))
    }

    /// Put the phone back where the driver left it when CarPlay disconnects.
    func closeDriveSurface() {
        guard let webView, let returnURL else { return }
        self.returnURL = nil
        webView.load(URLRequest(url: returnURL))
    }

    private var returnURL: URL?

    // MARK: - Audio session

    /// CarPlay requires a conversational app to hold an audio session only
    /// while voice is actually in use, so this is driven by the page's own
    /// state rather than held open for the whole trip.
    private func syncAudioSession() {
        let shouldBeActive = state.isActive
        guard shouldBeActive != audioSessionActive else { return }
        let session = AVAudioSession.sharedInstance()
        do {
            if shouldBeActive {
                try session.setCategory(
                    .playAndRecord,
                    mode: .voiceChat,
                    options: [.allowBluetooth, .allowBluetoothA2DP, .duckOthers]
                )
                try session.setActive(true)
            } else {
                try session.setActive(false, options: .notifyOthersOnDeactivation)
            }
            audioSessionActive = shouldBeActive
        } catch {
            // A refused session must not take the conversation down: the page
            // surfaces its own microphone error, and the next turn retries.
            NSLog("[drive] audio session %@ failed: %@", shouldBeActive ? "activate" : "deactivate", error.localizedDescription)
        }
    }

    // MARK: - Reset

    func reset() {
        state = .idle
        agentName = nil
        lastSpoken = nil
        lastHeard = nil
        lastError = nil
        actions = []
        syncAudioSession()
    }
}

// MARK: - Inbound: page to car screen

extension DriveLink: WKScriptMessageHandler {

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.channel,
              let body = message.body as? [String: Any],
              (body["v"] as? Int) == Self.protocolVersion,
              let type = body["type"] as? String
        else { return }

        switch type {
        case "ready":
            let agent = body["agent"] as? [String: Any]
            agentName = agent?["name"] as? String
            lastError = nil
        case "state":
            state = State(rawValue: body["state"] as? String ?? "") ?? .idle
            syncAudioSession()
        case "heard":
            lastHeard = body["text"] as? String
        case "said":
            lastSpoken = body["text"] as? String
            lastError = nil
        case "error":
            lastError = body["message"] as? String
        case "actions":
            let raw = body["actions"] as? [[String: Any]] ?? []
            actions = raw.compactMap { entry in
                guard let id = entry["id"] as? String, let label = entry["label"] as? String else { return nil }
                return Action(id: id, label: label, enabled: (entry["enabled"] as? Bool) ?? true)
            }
        default:
            return
        }

        onChange?()
    }
}
