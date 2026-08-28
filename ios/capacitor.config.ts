import type { CapacitorConfig } from '@capacitor/cli';

// The WebView loads the live product at https://three.ws rather than a copy of
// dist/ baked into the .ipa. That is deliberate and load-bearing, not laziness:
// 733 call sites in src/ fetch same-origin '/api/...', and the session cookie,
// the OAuth callbacks and the x402 payment headers are all issued for the
// three.ws origin. Serving the bundle from capacitor://localhost would break
// every one of them, and rewriting all of them behind an API base is a far
// larger and far riskier change than shipping the app.
//
// What keeps this from being a bookmark (App Review guideline 4.2) is the
// native layer around it: push notifications, the share extension, WidgetKit,
// App Intents, ARKit Quick Look, and the camera/location bridges in src/.
// See docs/REVIEW-RISK.md before touching any of it.
const config: CapacitorConfig = {
	appId: 'ws.three.app',
	appName: 'three.ws',
	// Capacitor still needs a local bundle: it backs errorPath (the offline
	// screen) and is what the WebView falls back to with no network at launch.
	webDir: 'shell',
	loggingBehavior: 'production',
	server: {
		url: 'https://three.ws',
		hostname: 'three.ws',
		iosScheme: 'https',
		// Everything the product legitimately navigates to in-WebView. Anything
		// not listed here opens in the system browser via the App plugin's
		// urlOpen handler (src/native-bridge.js), which is both the correct UX
		// and what keeps third-party auth out of an embedded WebView.
		allowNavigation: [
			'three.ws',
			'*.three.ws',
			'api.three.ws',
		],
		// Shipped in shell/. Loaded when the initial navigation fails, so a
		// launch on the subway shows a designed screen instead of the WebKit
		// "cannot open page" error.
		errorPath: 'offline.html',
	},
	ios: {
		// The generated Xcode project lives at ios/native/App rather than the
		// default ios/ios/App, which would read as a typo in the repo tree.
		path: 'native',
		// The WebGL surfaces (/create, /ar/studio, /walk, /play) all render into
		// full-bleed canvases and paint their own safe-area padding; letting the
		// WebView run under the status bar is what makes them look native.
		contentInset: 'never',
		// three.ws is a dark product. A white flash between splash and first
		// paint is the single most obvious "this is a website" tell.
		backgroundColor: '#080814',
		scrollEnabled: true,
		limitsNavigationsToAppBoundDomains: false,
	},
	plugins: {
		SplashScreen: {
			launchAutoHide: false,
			backgroundColor: '#080814',
			showSpinner: false,
		},
		PushNotifications: {
			presentationOptions: ['badge', 'sound', 'alert'],
		},
	},
};

export default config;
