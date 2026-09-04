# RM-WIDGETS: Native widgets, the agent on the home screen and the desktop

**Status 2026-09-04: all four tasks are built, and the endpoints, the Apple
hand-off and the Windows manifest are re-verified live. This file stays because
two Definition of done lines cannot be closed from this machine** (one needs a
Windows 11 machine, one needs an Apple Developer account), and the campaign's
rule is to leave a work order in place until every line of it passes. The
Windows worker also carries a 2026-09-04 fix that has to ship before the board
check is worth running. Read "What remains", not the history above it.

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Also read `prompts/finish/roadmap-00-README.md` and `CLAUDE.md`.

## What shipped

The card is one server-rendered bitmap plus a small JSON contract, and every
platform is a rendering job against it. Product documentation:
[`docs/native-widgets.md`](../../docs/native-widgets.md). Wire format:
[`specs/GLANCE_CARD.md`](../../specs/GLANCE_CARD.md).

| Task | Where it lives | State |
| --- | --- | --- |
| 1. The card endpoint, two encodings | `api/glance/card.js`, `api/glance/mine.js`, `api/glance/token.js`, `api/glance/template.js` | Live in production. Verified 2026-09-03: `mine?format=png` answers `200 image/png` unauthenticated with `x-glance-state: signed-out`, `token` answers `401` with no session, and a real mint on the QA account fetched every size, theme and scale. |
| 2. Android home screen widget | `solana-mobile/android-overlay/`, applied by `scripts/apply-overlay.mjs` inside `build-apk.sh` | In a signed APK (1.1.0, versionCode 2). All five emulator checks recorded in `solana-mobile/docs/CHECKLIST.md` section 7b. |
| 3. Windows 11 widget | `widgets` member in `vite.config.js`, `public/glance-sw.js`, `api/glance/template.js` | Live: production `manifest.webmanifest` carries the member and `/glance-sw.js` serves 200. |
| 4. macOS and iOS WidgetKit | `apple/` (shared `GlanceKit/`, extension `GlanceWidget/`, Mac app `macos/`), plus a `GlanceWidgetExtension` target in `ios/native/App/App.xcodeproj` | Written, wired, and guarded by `npm run check:apple-widget`. Not built: no Mac, and no signing identity. |

The one live number is **moves in the last 24 hours**, computed from the agent's
own action log. The alternatives considered were earnings (empty for most
accounts, so most widgets would read zero) and reputation (moves too slowly to
be worth a home screen slot).

## What remains

Neither line is code, and neither can be closed from this machine.

1. **"The Windows widget is live in the manifest and verified in the widgets
   board."** The manifest half is verified in production. The in-board half
   needs a Windows 11 machine with the PWA installed from Edge: open the board
   with `Win + W`, **Add widgets**, pick **Agent glance**, confirm it populates
   with the signed-in account's real card, refreshes, and that its click targets
   land on the right routes. Owner, or anyone with a Windows 11 machine.

   **Do that check against a deploy that carries 2026-09-04's worker fix, not
   against what is live now.** Reading the board's contract against the
   [Microsoft widget docs](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/widgets)
   found three defects that would each have failed this check on its own, none
   of them visible from Linux: `msAcTemplate` is the URL of the Adaptive Card
   and the worker has to fetch it, but the worker was sending the host that URL
   as a string where the card belonged, so a pinned slot had nothing to draw;
   nothing ever registered the periodic sync, so the advertised 15 minute
   refresh was never scheduled; and a slot pinned before the worker activated
   stayed empty until the board next resumed it. All three are fixed in
   `public/glance-sw.js` and pinned by `tests/glance-sw.test.js`, and the fix
   reaches the board only on the next production deploy.
2. **Signing and shipping the two Apple binaries.** An Apple Developer account
   is the blocker for both halves, not just the App Store one: the Mac app needs
   a Developer ID certificate and the iOS extension needs App Store signing.
   This is owner action 17 in
   [`production-100-OWNER-ACTIONS.md`](production-100-OWNER-ACTIONS.md). Once the
   account exists, `apple/README.md` is the whole build recipe, and the emulator
   or device pass is the same five checks the Android widget went through.

The `?platform=` parameter that points an unlinked Apple widget at the Apple
hand-off rather than the Android one has since shipped: verified live
2026-09-04, `mine?platform=ios` and `platform=macos` answer
`linkUrl=https://three.ws/glance?link=apple` and everything else answers
`link=android`.

## Retire this prompt when those two lines pass

1. Verify each line against actual output in front of you. Never claim a line
   you did not verify.
2. Record the outcome in `production-100-00-INDEX.md` and
   `roadmap-00-README.md`.
3. Commit with explicit paths and a subject that describes the diff, and delete
   this prompt file in that same commit:

       git rm prompts/finish/roadmap-native-widgets.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.
