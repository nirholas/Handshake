import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        // A cold launch straight from the widget link on three.ws/glance. The
        // token is claimed here so it never reaches the WebView; the URL is
        // still handed on, and native-bridge.js drops it for the same reason.
        for context in connectionOptions.urlContexts {
            GlanceLink.claim(context.url)
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // threews://glance/link?token=glw_... hands the home screen widget its
        // own revocable credential. It is stored in the shared keychain and the
        // widget's timelines are reloaded; anything else falls through to
        // Capacitor, which is what routes wallet and OAuth returns.
        let unclaimed = URLContexts.filter { GlanceLink.claim($0.url) == .notALinkURL }
        guard !unclaimed.isEmpty else { return }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: unclaimed)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
