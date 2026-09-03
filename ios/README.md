# `ios/`: the three.ws iOS app

The App Store build of three.ws. A Capacitor 8 shell whose WKWebView runs the
live product at `https://three.ws`, wrapped in the native layer an app needs and
a website cannot have: universal links, the system share sheet, deep links back
from wallets, haptics, a real launch screen, and the camera / location / motion
permissions the AR and IRL surfaces depend on.

The Android counterpart is [`../solana-mobile/`](../solana-mobile), which
packages the same product as a Trusted Web Activity for the Solana dApp Store.
This directory follows its shape on purpose: detection and shims in `src/`, the
native project under a single directory, listing copy in `publish/`, and a
submission checklist in `docs/`.

## Layout

```
ios/
├── capacitor.config.ts     # appId, server URL, iOS behaviour, plugin config
├── shell/                  # local bundle: bootstrap + the designed offline screen
├── src/native-bridge.js    # web-side half; ships with the SITE, not the .ipa
├── scripts/make-icons.mjs  # derives the icon + launch images from the brand mark
├── native/App/             # the generated Xcode project (committed)
│   ├── App.xcodeproj
│   ├── App/MainViewController.swift  # swipe-back, dark chrome, edge-to-edge insets
│   ├── App/CarPlaySceneDelegate.swift # the car screen: templates + voice control
│   ├── App/DriveLink.swift           # CarPlay <-> /drive channel + audio session
│   ├── App/Info.plist                # usage strings, URL scheme, orientations, scenes
│   ├── App/App.entitlements          # associated domains + APNs + CarPlay
│   └── CapApp-SPM/                   # Swift Package Manager plugin graph
└── docs/                   # SUBMISSION.md, REVIEW-RISK.md, ASSETS.md, CARPLAY.md
```

## CarPlay

The app carries a second scene for **three.ws Drive**, the agent in the car. Apple's
voice-based conversational category grants templates and an audio session and no drawing
surface, so the car screen shows four controls and the Voice Control template while the
phone's WebView runs `/drive` with the actual agent in it. The two are joined by the
`threeWsDrive` WebKit message channel.

It is inert without the `com.apple.developer.carplay-voice-based-conversation` entitlement,
which Apple grants per app on request, so nothing about the phone app changes before then.
Read [`docs/CARPLAY.md`](docs/CARPLAY.md) before touching any of it, and
[`../docs/carplay.md`](../docs/carplay.md) for why the architecture is shaped this way.

## Why the WebView loads the live site

The alternative is baking `dist/` into the `.ipa` and serving it from
`capacitor://localhost`. That breaks the product: 733 call sites in `src/` fetch
same-origin `/api/...`, and the session cookie, the OAuth callbacks and the x402
payment headers are all issued for the `three.ws` origin. Rewriting every one of
them behind an API base is a larger and riskier change than shipping the app,
and it would fork the web and app code paths permanently.

What keeps this from being a bookmark (and from failing App Review guideline
4.2) is the native layer in `src/native-bridge.js` and the entitlements: share
sheet, universal links, wallet deep links, haptics, offline screen, and the
native permission prompts. Read [`docs/REVIEW-RISK.md`](docs/REVIEW-RISK.md)
before changing any of it; the crypto surfaces carry real rejection risk and
that document is where the reasoning lives.

`shell/` is still a real bundle: `shell/offline.html` is wired as
`server.errorPath`, so a launch with no network gets a designed screen that
polls `/api/healthz` and recovers on its own instead of the WebKit error page.

## The web-side half

`src/native-bridge.js` is loaded by the **site**, not the app: Capacitor injects
its bridge into the remote page at document start, so `window.Capacitor` exists
on `https://three.ws` whenever it is being viewed inside the app. The
`three-ws-ios-native-bridge` plugin in [`../vite.config.js`](../vite.config.js)
injects the module into every built page except the embed entries. It is a no-op
in every browser.

What it installs, and the breakage each one fixes:

| Shim | Without it |
|---|---|
| `navigator.share` / `canShare` over the native sheet | WKWebView has no Web Share API, so every share button on the platform silently does nothing |
| Off-site links to an in-app Safari sheet | A tap on an explorer link navigates the app's only WebView away from three.ws with no back button |
| `appUrlOpen` routing (universal links + `threews://`) | A wallet or OAuth redirect reopens the app on whatever page it was last showing |
| Splash hide on first paint | `launchAutoHide` fires on WebView load, minutes before a three.js scene renders |
| `html.ios-app` + safe-area custom properties | Install prompts render inside the installed app; bottom controls sit under the home indicator |
| Haptics on primary actions | No tactile feedback anywhere |
| Status-bar padding on the sticky header | The nav renders under the system clock: the site's own compensation is behind `@media (display-mode: standalone)`, which a WKWebView loading a remote URL never matches |
| 16px minimum on form fields | iOS zooms the page on focus and never zooms back out |

## The native half

`native/App/App/MainViewController.swift` replaces Capacitor's stock bridge
controller in `Main.storyboard`. It exists for one thing JavaScript cannot do:

- **Edge-swipe back and forward.** `WKWebView` ships with them off, and iOS has
  no back button. Without this the app is a one-way trip: follow a link into a
  detail page and the only way out is killing the app.
- **Dark, edge-to-edge chrome.** The container, the WebView and its scroll view
  all take the product's `#080814` so there is no white flash behind a loading
  three.js scene and none at the edges of an over-scroll.
- **`contentInsetAdjustmentBehavior = .never`**, which is what makes
  `env(safe-area-inset-*)` non-zero inside the page. The padding the bridge
  installs has nothing to react to without it.

The app icon and launch images are generated, not hand-exported:

```bash
npm run ios:icons        # re-derive from public/pwa-512x512.png
npm run check:ios-icons  # verify the committed assets match (wired into `npm run gate`)
```

## Working on it

```bash
cd ios
npm install          # Capacitor CLI + plugins
npm run sync         # copy shell/ into the Xcode project, resolve plugins
npm run open         # open App.xcodeproj in Xcode (macOS only)
```

`npm run sync` works on Linux: Capacitor 8 resolves plugins through Swift Package
Manager, so there is no CocoaPods step and no macOS requirement for anything
except compiling, signing and uploading.

From the repo root:

```bash
npm run ios:sync     # same as the above, without changing directory
```

## What is not wired yet

Everything here builds and runs; these are the pieces that need an Apple
Developer account before they can exist at all, listed so nobody rediscovers
them at submission time:

- **`APPLE_TEAM_ID`** on the Cloud Run service. `/.well-known/apple-app-site-association`
  ([`../api/wk.js`](../api/wk.js)) answers `503 not_configured` until it is set,
  and universal links keep opening in Safari until it serves a real association.
  Set it with `gcloud run services update three-ws-api --region us-central1 --update-env-vars APPLE_TEAM_ID=<id>`.
- **Push notifications.** The plugin, the `remote-notification` background mode
  and the `aps-environment` entitlement are in place; the APNs key, the device
  token endpoint and the send path are not, and are deliberately absent rather
  than stubbed.
- **Signing.** No team, no provisioning profile, no `ExportOptions.plist`. See
  [`docs/SUBMISSION.md`](docs/SUBMISSION.md).
- **Screenshots** for the listing, which have to be captured on a real device.
  Specs in [`docs/ASSETS.md`](docs/ASSETS.md).

Two findings that are decisions rather than missing work, both written up in
[`docs/REVIEW-RISK.md`](docs/REVIEW-RISK.md): the app currently has no service
workers (`limitsNavigationsToAppBoundDomains: false` disables them in
`WKWebView`, which is why the offline screen is native rather than the site's
own), and routing a surface to the Safari sheet signs the visitor out, because
`SFSafariViewController` does not share the app WebView's cookie jar.

## Related

- Product doc: [`../docs/ios-app.md`](../docs/ios-app.md)
- Android / Seeker app: [`../solana-mobile/README.md`](../solana-mobile/README.md)
- Where everything lives: [`../STRUCTURE.md`](../STRUCTURE.md)
