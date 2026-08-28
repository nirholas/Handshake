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
├── native/App/             # the generated Xcode project (committed)
│   ├── App.xcodeproj
│   ├── App/Info.plist          # usage strings, URL scheme, orientations
│   ├── App/App.entitlements    # associated domains + APNs
│   └── CapApp-SPM/             # Swift Package Manager plugin graph
└── docs/                   # SUBMISSION.md, REVIEW-RISK.md, ASSETS.md
```

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
| Haptics on `[data-haptic]` | No tactile feedback anywhere |

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
- **App icons and launch screen art.** `native/App/App/Assets.xcassets` still
  holds Capacitor's template. Specs in [`docs/ASSETS.md`](docs/ASSETS.md).
- **Signing.** No team, no provisioning profile, no `ExportOptions.plist`. See
  [`docs/SUBMISSION.md`](docs/SUBMISSION.md).

## Related

- Product doc: [`../docs/ios-app.md`](../docs/ios-app.md)
- Android / Seeker app: [`../solana-mobile/README.md`](../solana-mobile/README.md)
- Where everything lives: [`../STRUCTURE.md`](../STRUCTURE.md)
