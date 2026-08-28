# three.ws on iOS

three.ws ships to the App Store as a native iOS app (`ws.three.app`). Like the
[Seeker app](./seeker-app.md), it is a shell around the live web product rather
than a second implementation of it: a Capacitor 8 container whose WKWebView runs
`https://three.ws`, wrapped in the native layer a website cannot have. For a
WebGL product that is the right shape, and it means the app is never a version
behind the site. What makes it an app is everything around that shell.

This page is the user-facing map. Packaging, signing, App Review posture and the
submission checklist live in [`ios/README.md`](../ios/README.md).

**Status: in-repo, not yet submitted.** The Xcode project builds and the web
side is live in every deploy. What is outstanding is an Apple Developer
organization account, app icons, and push. See "What is missing" below.

## What the app does differently from the website

| Surface | In the iOS app | Where it lives |
|---|---|---|
| Sharing | The system share sheet, with AR captures attached as real image files | `ios/src/native-bridge.js` (`navigator.share` shim) |
| Deep links | Any `https://three.ws/...` link opens in the app once the app association is live | `ios/native/App/App/App.entitlements`, `api/wk.js` |
| Wallet returns | A wallet or OAuth redirect comes back to the exact page that started it, over `threews://` | `ios/src/native-bridge.js` (`appUrlOpen`), `Info.plist` URL types |
| Off-site links | Open in an in-app Safari sheet and return, instead of navigating the app away with no way back | `ios/src/native-bridge.js` |
| Offline | A designed screen that polls `/api/healthz` and recovers on its own, instead of the WebKit error page | `ios/shell/offline.html`, `server.errorPath` |
| Camera, mic, photos, location, motion | Real iOS permission prompts with real usage strings, which is what `/create/selfie`, `/ar/studio` and `/irl` need on iOS | `ios/native/App/App/Info.plist` |
| Launch | The launch screen holds until the first real frame, so a three.js scene never opens onto a black void | `ios/src/native-bridge.js`, `SplashScreen` config |
| Haptics | A tick on primary and destructive actions, quiet on a disabled or busy one | `ios/src/native-bridge.js` |
| Back navigation | Edge-swipe back and forward, which `WKWebView` ships with off and iOS has no button for | `ios/native/App/App/MainViewController.swift` |
| Status bar | The sticky header clears the notch and the clock. The site's own compensation is behind `@media (display-mode: standalone)`, which a WebView loading a remote URL never matches | `ios/src/native-bridge.js` (injected stylesheet) |
| Forms | Fields never fall below 16px, so focusing one cannot zoom the page and strand it zoomed | `ios/src/native-bridge.js` |

## How the web half reaches the app

Capacitor injects its native bridge into the remote page at document start, so
`window.Capacitor` exists on `https://three.ws` whenever the site is being
viewed inside the app, and nowhere else. `ios/src/native-bridge.js` keys every
behaviour above off that, and ships with the **site**: the
`three-ws-ios-native-bridge` plugin in [`vite.config.js`](../vite.config.js)
copies it into `dist/` under a content-hashed name and injects a script tag into
every built page except the third-party embed entries.

Two consequences worth knowing:

- **App behaviour ships on a web deploy, not an App Store release.** Fixing the
  share sheet or adding a deep-link route is a normal deploy.
- **An old web deploy means an app with no native behaviour.** The app degrades
  to a plain WebView rather than breaking, but the shims are simply absent.

## The app association

`GET /.well-known/apple-app-site-association` ([`api/wk.js`](../api/wk.js)) is
what tells iOS that three.ws links belong to the app, and that the login form
inside the app may offer a saved three.ws password. It is served from the API
rather than `public/.well-known/` because Apple requires an exact path, a JSON
content type, and no redirect.

The app identifier is `<Team ID>.ws.three.app`, and the Team ID comes from
`APPLE_TEAM_ID` on the Cloud Run service. Until that is set the endpoint answers
`503 not_configured` on purpose: publishing an association for a team that
cannot sign anything fails silently on device, where links just keep opening in
Safari and nothing errors.

```bash
curl -sS -D- https://three.ws/.well-known/apple-app-site-association
```

The `applinks` components hand every path to the app except `/api/*` (OAuth and
x402 callbacks must finish in the browser that started them) and the `/embed*`
and `/widget*` entries (they exist to render inside someone else's page).

## What is missing

- **`APPLE_TEAM_ID`**, which needs an Apple Developer Program account enrolled
  as an organization. Apple only permits wallet functionality from organization
  accounts, and that enrollment needs a legal entity and a D-U-N-S number.
- **Push notifications.** The entitlement, background mode and plugin are in
  place; the APNs key, device-token endpoint and send path are not, and are
  absent rather than stubbed.
- **Listing screenshots**, which have to be captured on a real device. The icon
  and launch images are generated from the brand mark (`npm run ios:icons`) and
  a guard keeps them from drifting (`npm run check:ios-icons`).
- **The App Review posture on crypto surfaces**, which is a product decision
  and not a code one, and which costs a session handoff rather than a config
  flag: `SFSafariViewController` does not share the app WebView's cookie jar, so
  a surface routed to Safari arrives signed out. Written up in
  [`ios/docs/REVIEW-RISK.md`](../ios/docs/REVIEW-RISK.md).
- **Service workers**, which `WKWebView` runs only for app-bound domains. The
  app declares none, so the site's offline caching and share-target worker do
  not run inside it; the native offline screen covers the case that matters.
  Same doc has the trade.

## Related

- [three.ws on Solana Seeker](./seeker-app.md): the Android app
- [`ios/README.md`](../ios/README.md): building and shipping this one
- [`STRUCTURE.md`](../STRUCTURE.md): where every surface lives
