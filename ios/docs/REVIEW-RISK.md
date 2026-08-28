# App Review risk for three.ws on iOS

Written before submission, from Apple's published App Review Guidelines. Every
claim here is about a rule, not a prediction; where a rule is ambiguous that is
said plainly. Re-read it before changing anything in `capacitor.config.ts`, the
entitlements, or the crypto surfaces, because those are the three places where a
small change flips a version-1 approval into a rejection.

The short version: **the code is not the long pole. The account type and the
crypto surfaces are.**

## 1. Guideline 3.1.5(b) and 3.1.1: crypto. The real gate.

Apple's rules for cryptocurrency, in the order they bite:

**Wallets are organization-only.** Apps may facilitate virtual currency storage
"provided they are offered by developers enrolled as an organization." three.ws
gives every agent a wallet and every user a way to hold and move value, so an
**Individual** Apple Developer account cannot ship it. Enrolling as an
organization requires a legal entity and a D-U-N-S number, and the D-U-N-S
lookup or request is the step that most often takes a week or more. **Start this
before anything else; nothing downstream can be compressed to make up for it.**

**Exchange functionality is licensing-gated.** Apps may facilitate
cryptocurrency transactions "on an approved exchange, provided they are offered
only in countries or regions where the app has appropriate licensing and
permissions." three.ws's swap, trade and pump.fun launch surfaces are the
exposure here. Submitting version 1 with in-app token launching and trading
invites a rejection that asks for licensing documentation we do not have.

**Unlocking features with crypto is prohibited.** Anything on the platform where
paying in $THREE, USDC or an x402 call unlocks app functionality collides with
3.1.1: digital content and features consumed in the app must use in-app
purchase. Reading data, viewing holdings and viewing an agent's on-chain history
are fine. Buying a generation credit with USDC inside the app is not.

**What that implies for version 1.** Ship the creation and spatial product, and
route the value-moving surfaces to Safari rather than removing them:

| Ships in the app | Opens in Safari |
|---|---|
| `/create`, the forge, avatar and model generation | `/trade`, swaps, bridges |
| `/ar`, `/ar/studio`, `/irl`, the viewer, Quick Look | pump.fun launching |
| Agent profiles, `/marketplace` browsing, `/community`, `/feed` | Buying credits or paid generations |
| Talk mode, animation, rigging, exports | Wallet funding and withdrawal |
| Read-only wallet and portfolio views | x402 payment flows |

**This is not a one-line change, and the reason matters.**
`src/native-bridge.js` already sends every *off-site* link to an in-app Safari
sheet, so routing a same-origin surface there looks like adding five paths to a
list. It is not: `SFSafariViewController` runs on Safari's cookie jar, and the
session cookie that authenticates the visitor was set in the app's `WKWebView`,
which does not share it. Route `/pay` to the sheet as it stands and the visitor
arrives signed out, on a page that exists to spend their money.

Doing it properly needs a session handoff: the app mints a short-lived,
single-use code against the live session and the Safari URL carries it, which
the site exchanges for a cookie on first load. The closest existing thing is
`POST /api/auth/extension-token` ([`../../api/auth/extension-token.js`](../../api/auth/extension-token.js)),
which solves the same shape of problem for the browser extension but mints a
scoped Bearer token, and a Bearer token cannot authenticate a page load. So this
is a real, small feature, not a config flag. Size it before promising a date.

The surfaces the list should hold, read off `data/pages.json` rather than
guessed: `/launch`, `/launcher` and `/pumpfun` (they mint and trade),
`/pay` and `/payments` (they spend). Deliberately NOT `/wallet` or
`/agent-wallet`: Apple permits wallet storage and viewing from an organization
account, and pushing the two most-used surfaces out to Safari would cost far
more than it buys. Also not `/agent-trade`, `/coin3d`, `/launch-studio` or
`/pay/simulator`, which read as transactional and are a visualisation, a
visualisation, a catalogue and a dry run.

## 2. Guideline 4.2: minimum functionality.

A WebView pointed at a website is rejected as "a bookmark." The mitigation is
that the app does things the website cannot, and that they are visible in the
first minute of use. What is already in place:

- Camera, microphone, photo library, location and motion, each behind a real
  system permission prompt with a real usage string.
- The native share sheet, replacing a Web Share API that does not exist in
  WKWebView.
- Universal links: a shared `/viewer` or `/irl/s/` link opens the app.
- Wallet deep links back into the app via `threews://`.
- A designed offline screen that recovers on its own.
- Haptics.

That is a defensible 4.2 position and not a certain one. The two additions that
move it from defensible to comfortable, in order of effect per unit of work:

1. **A Share Extension.** Share a photo from Photos or a GLB from Files
   straight into avatar creation. The Android app already has this through the
   web manifest `share_target`; iOS needs a real extension target. It is the
   single most convincing "this is an app" feature available here.
2. **A WidgetKit widget.** Your agents on the home screen, refreshed from the
   API. Nothing about it is possible on the web.

Push notifications count for 4.2 as well and are half-wired (entitlement and
background mode present, APNs key and token endpoint absent).

Edge-swipe back navigation, added in `MainViewController.swift`, is not a 4.2
credit on its own, but its absence is a reliable rejection *and* a reliable
one-star review: `WKWebView` ships with the gesture off and iOS has no back
button, so without it a visitor who follows one link has no way out of the app
except killing it.

## 3. Guideline 5.1.1: permissions and account deletion.

- Every usage string in `Info.plist` says what the data is for in the user's
  terms. Requesting a permission the app never uses is itself a rejection, so
  do not add usage strings speculatively.
- **Account deletion must be reachable in-app.** Apps that support account
  creation must offer account deletion. Verify the existing account settings
  path exposes it before submitting; this one is checked mechanically by
  reviewers and is a common, avoidable rejection.
- Sign in with Apple is required only if the app offers third-party social
  login as the *only* sign-in option. Confirm which providers the login sheet
  offers before assuming it is not needed.

## 4. Guideline 2.5.1 and 4.7: WebView posture.

`limitsNavigationsToAppBoundDomains` is `false` in `capacitor.config.ts`,
which is required because the app navigates to wallet and OAuth domains.
`server.allowNavigation` is restricted to three.ws hosts, so anything else goes
through the Safari sheet rather than the app's WebView. Keep it that way:
running third-party sign-in inside an embedded WebView is both a review problem
and a security one.

## 5. Service workers are off, and that is the current trade.

`limitsNavigationsToAppBoundDomains` is `false`, and `WKWebView` only runs
service workers for **app-bound domains**. So inside the app the site's service
worker never registers: no workbox precache, no offline page from
`public/offline.html`, no `share_target` interception. That is why the app
carries its own native offline screen (`shell/offline.html`, wired as
`server.errorPath`) rather than relying on the web one.

Flipping it is tempting and should not be done blind. Declaring
`WKAppBoundDomains` in `Info.plist` and setting the flag `true` would restore
service workers, and the app already keeps in-WebView navigation to three.ws
hosts with everything else going to the Safari sheet, so the restriction is
close to what the app does anyway. But the limit is ten domains, it cannot be
changed after install without an app update, and app-bound mode also constrains
the JavaScript-injection APIs that Capacitor's own bridge depends on. If it is
wrong, the app does not degrade: it does not work at all. Test it on a real
device before it ships, not after.

## 6. What is not a risk here.

- **AR.** ARKit Quick Look and WebXR usage are ordinary and uncontroversial.
- **User-generated 3D content.** Standard UGC moderation expectations apply
  (report, block, terms), and the platform already has moderation surfaces.
- **Export compliance.** `ITSAppUsesNonExemptEncryption` is `false` in
  `Info.plist`: HTTPS and platform crypto only, which is the exempt case.
