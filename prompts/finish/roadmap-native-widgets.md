# RM-WIDGETS: Native widgets, the agent on the home screen and the desktop

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/roadmap-native-widgets.md`".
It is complete on its own. Also read `prompts/finish/roadmap-00-README.md` and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end with a question, a plan you did not execute, or "should I proceed?".
2. Additive only. `ws.three.app` is a signed, published-track Android artifact and the PWA
   manifest is live for every installed user. Nothing here may change how the existing TWA
   boots, how the share target behaves, or how the service worker serves the offline shell.
3. CLAUDE.md hard rules: no mocks, no fake data, no TODO comments, no commented-out code, no
   em-dash or en-dash characters. Stage explicit paths only.
4. Every widget renders real data for a real signed-in account or it renders the signed-out
   card. There is no sample agent and no placeholder avatar.

## What this is, and what it is not

**Not this:** the embeddable web widgets at `/widgets` and `/studio` (`docs/widgets.md`,
`docs/widget-studio.md`). Those put a live WebGL agent inside someone else's web page.

**This:** operating system widget surfaces. The Android home screen, the Windows 11 widgets
board, and the macOS and iOS widget galleries. None of them can run WebGL, none of them can run
our viewer, and all of them refresh on a schedule the OS controls rather than on a page load.
So every one of them is fed the same thing: a small, cacheable, server-rendered card.

## What already exists (verified 2026-08-28, re-verify before acting)

- **The Android app is real and signed.** `ws.three.app`, a Trusted Web Activity built by
  `solana-mobile/scripts/build-apk.sh`, versionCode 1, targetSdk 36, 4.1 MB. Digital Asset
  Links verify against the live release key: `https://three.ws/.well-known/assetlinks.json`
  and Google's `statements:list` both return `98:0A:1A:AB:...:11:13:D7`. Deep links,
  long-press shortcuts (Create / Discover / My agents) and the Android share sheet target are
  registered and were exercised on a Pixel 7 emulator. Packaging and release: `solana-mobile/README.md`.
- **A real server-side renderer.** `POST /api/render/avatar-clip` returns a posed,
  camera-orbited PNG of any GLB (pose preset, orbit in degrees, background color, up to
  2048 px) through the same headless chromium pipeline the OG cards use;
  `POST /api/render/glb` is the plain variant. `api/_lib/render-clip.js` is the core.
  There is no reason to build a second renderer for widgets.
- **Avatar thumbnails already have a storage discipline.** `docs/avatar-thumbnails.md`: a
  `thumbnail_key` is only persisted after the object behind it is confirmed to exist in R2.
  Widget cards obey the same rule, for the same reason.
- **The PWA is installable and its service worker is extensible.** `vite.config.js` builds the
  web manifest and a workbox `generateSW` service worker that already `importScripts`
  `/push-sw.js` and `/share-target-sw.js`. A widget lane is another script in that list, not a
  switch to `injectManifest`.

## Task 1: one widget card endpoint, two encodings

Build `api/widget/card.js` served at `GET /api/widget/card`. This is the single source every
platform reads.

- **Auth:** an opaque, revocable, per-account widget token, not the session cookie. A home
  screen widget outlives a session and a Windows widget is fetched by the OS, not the browser.
  Mint it at `POST /api/widget/token` for a signed-in account, store the hash, and let the
  account revoke it from the dashboard. Treat the token as a bearer credential in a query
  parameter: scope it to read-only widget data and nothing else.
- **Response, `?format=png`:** the card as an image, sized by `?size=small|medium|large`.
  Composed from the account's primary agent: the avatar render from `render-clip`, the agent
  name, and one live number. Cache it in R2 under the same confirm-before-persist rule as
  thumbnails, and serve `cache-control: public, max-age=900`.
- **Response, `?format=json`:** the same fields as data, for the Windows Adaptive Card and for
  any future surface. This is the contract; write it into `specs/` because native shells that
  ship through app stores cannot be redeployed in step with the server.
- **Signed out, and empty states:** an account with no agent gets a card that says how to make
  one, not a blank frame. A revoked token gets a card that says to re-link, never a 401 image
  the OS renders as a grey box.
- **The one live number** is the first real decision in this work order. It has to be worth a
  home screen slot and it has to be true: pick from the agent's recent activity, its earnings,
  or its reputation, take whichever the platform can compute cheaply and correctly for every
  account, and record the choice and the alternatives in your report.

## Task 2: Android home screen widget

The TWA project is regenerated from `twa/twa-manifest.json` by `bubblewrap update` on every
build, so anything native must be applied as an overlay AFTER that step and BEFORE
`bubblewrap build`. That ordering is the whole trick.

1. Add `solana-mobile/android-overlay/` holding the native sources: an `AppWidgetProvider`,
   its `RemoteViews` layouts in three sizes, the widget info XML, and the manifest fragment.
2. Teach `solana-mobile/scripts/build-apk.sh` to copy the overlay into the generated project
   and merge the provider declaration into `AndroidManifest.xml` between `update` and `build`.
   A missing overlay must fail the build loudly, never silently ship a widget-less APK that
   the listing claims has one.
3. Refresh with `WorkManager` on a battery-aware periodic schedule, not `AlarmManager`. Fetch
   `/api/widget/card?format=png`, write it to internal storage, and update the `RemoteViews`.
   No network means the last cached card stays on screen with its timestamp, never a spinner
   and never a broken image.
4. Tapping the widget opens the TWA at the deep link for that agent. Tapping a quick action
   opens `/create` or `/my-agents`. Both already resolve inside the app because Digital Asset
   Links verify.
5. Bump `appVersionCode` in `twa/twa-manifest.json`, rebuild, and verify on the Pixel 7
   emulator recipe in `solana-mobile/README.md`: add the widget from the picker, confirm it
   refreshes without opening the app, force stop the app and confirm the widget survives,
   reboot the emulator and confirm it comes back, then toggle airplane mode and confirm the
   cached card holds.
6. Update `solana-mobile/docs/CHECKLIST.md` and `docs/seeker-app.md`, and add the widget to
   `publish/listing/new-in-version.txt` only once it is verified on a device.

## Task 3: Windows 11 widget, through the PWA

Windows 11 renders widgets for installed PWAs from the `widgets` member of the web manifest,
driven by Adaptive Card templates and service worker events. No store submission and no native
shell, which is why it ships second and not fourth.

1. Add the `widgets` member to the manifest block in `vite.config.js`, next to `share_target`.
2. Add `public/widget-sw.js` and register it in the existing `workbox.importScripts` list.
   Handle `widgetinstall`, `widgetresume`, `widgetuninstall` and `widgetclick`: on install and
   resume, fetch `/api/widget/card?format=json` and call `widgets.updateByInstanceId`; on
   click, open the matching route.
3. Ship the Adaptive Card template and its data binding as real files under `public/widgets/`,
   version them, and keep the template's fields identical to the JSON contract from Task 1.
4. Verify on Windows 11 with the PWA installed from Edge: the widget appears in the widgets
   board picker, populates with the real account's data, refreshes, and its click targets land
   on the right routes.

## Task 4: Apple platforms, macOS first

macOS and iOS share one WidgetKit extension, and both need a host app, which is the reason this
is last. macOS first because it can be distributed outside the App Store while the iOS build
waits on review.

1. A minimal SwiftUI host app that signs in and stores the widget token in the keychain, plus a
   WidgetKit extension with a `TimelineProvider` that fetches `/api/widget/card?format=png`.
2. A menu bar companion on macOS, since that is the surface people actually keep.
3. The iOS build is the same extension target against the same host app, submitted once an
   Apple Developer account exists. State plainly in your report if that account is the blocker.

## Definition of done

- `GET /api/widget/card` returns a real card for a real account in both encodings, documented
  in `docs/api-reference.md`, with the JSON contract in `specs/`.
- The Android widget is in a signed APK, verified on the emulator against all five checks in
  Task 2 step 5.
- The Windows widget is live in the manifest and verified in the widgets board.
- `docs/native-widgets.md` exists and explains, for a reader with no context, what the widget
  shows, how to add it on each platform, and how to revoke its token.
- `STRUCTURE.md` has a row for the widget surface, `data/pages.json` has any new public route,
  and `data/changelog.json` has an entry per release.
- `npm run gate` and `npm run check:rules -- --paths <your files>` are green.
