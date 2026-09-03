import UIKit
import Capacitor
import WebKit

/// The app's root view controller, replacing Capacitor's stock
/// `CAPBridgeViewController` in Main.storyboard.
///
/// It exists for one reason that the WebView cannot solve from JavaScript: iOS
/// has no back button, and `WKWebView` ships with edge-swipe navigation turned
/// off. Without this the app is a one-way trip. A visitor who follows a link
/// into a detail page has no gesture, no button and no hardware key that takes
/// them back, and the only recovery is killing the app. That is both the single
/// most common complaint about web-shell apps and a plausible App Review
/// finding under guideline 4.2.
class MainViewController: CAPBridgeViewController {

    override func viewDidLoad() {
        super.viewDidLoad()

        // Edge-swipe back and forward, the gesture every iOS user already has
        // in Safari. Capacitor leaves it off by default because a single-page
        // app with its own router does not want it; three.ws is a multi-page
        // site where real navigations are exactly what the gesture should
        // traverse.
        webView?.allowsBackForwardNavigationGestures = true

        // The product is dark and full-bleed. The default white gives a flash
        // of white at the edges of an over-scroll and behind the WebView while
        // a heavy three.js page is still painting.
        let background = UIColor(red: 0x08 / 255.0, green: 0x08 / 255.0, blue: 0x14 / 255.0, alpha: 1.0)
        view.backgroundColor = background
        webView?.backgroundColor = background
        webView?.isOpaque = false
        webView?.scrollView.backgroundColor = background

        // Rubber-band scrolling drags the whole page away from the status bar
        // and reveals the container behind it. On the WebGL surfaces, where the
        // canvas is pinned to the viewport, that reads as the app coming apart.
        // Vertical bounce stays: it is what makes ordinary lists feel native.
        webView?.scrollView.bounces = true
        webView?.scrollView.alwaysBounceHorizontal = false

        // Let the page paint under the status bar and home indicator. The web
        // side pads for both from env(safe-area-inset-*), installed by
        // ios/src/native-bridge.js; without this the insets are always zero and
        // that padding has nothing to react to.
        webView?.scrollView.contentInsetAdjustmentBehavior = .never

        // Wire the CarPlay channel. The car screen talks to /drive through this
        // WebView and nothing else, so the handler has to be registered before
        // a CarPlay scene can ever connect. It is inert until one does.
        if let webView { DriveLink.shared.attach(to: webView) }
    }
}
