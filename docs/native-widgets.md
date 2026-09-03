# Native widgets: your agent on the home screen

A three.ws agent earns a slot on your phone's home screen. The widget shows the agent's
avatar, its name, and one live number (how many moves it made today), and a tap opens the app
on that agent. The system refreshes it in the background about every 30 minutes; you never
have to open the app to see the number move.

This page covers the native, operating-system widgets. The embeddable web widgets that put a
live 3D agent inside a web page are a different product: see [widgets.md](widgets.md).

## What the widget shows

Every platform renders the same card, the [Glance card](glance.md):

- the agent's avatar thumbnail (or a generated monogram when the avatar is private),
- the agent's name and description,
- **Moves today**: the number of real actions the agent logged in the last 24 hours,
- this week's and all-time totals, and the agent's skill count,
- when it last acted, and a status dot (green: active today, amber: idle, grey: never acted).

No widget host on any platform can run WebGL, so the card is a bitmap the server renders
(`GET /api/glance/mine?format=png`) and the 3D avatar stays one tap away on the agent page.

## Android

Requires the three.ws Android app, version 1.1 or later ([seeker-app.md](seeker-app.md)).

1. Open [three.ws/glance](https://three.ws/glance) on the phone, signed in, and tap
   **Link this phone**. The page mints a widget token and hands it to the app; Android asks
   whether to add the widget to the home screen right away.
2. If you skipped that prompt: long-press the home screen, choose **Widgets**, find
   **three.ws**, and drag **Agent glance** out. It comes in 2x2 (the square card), 4x2 (the
   wide card), and 4x3 (the wide card with **Create** and **My agents** buttons). Resize it
   and it re-fetches the matching size.
3. The widget refreshes itself through WorkManager, on the battery-aware schedule Android
   grants background apps (about every 30 minutes, only with a network connection). Tapping
   the "Updated …" line refreshes on demand.

What happens when things go wrong is designed, not accidental:

| Situation | What the widget shows |
| --- | --- |
| Not linked yet | "Add your agent. Tap to link this widget to your three.ws account." The tap opens the link flow in the app. |
| Linked, first download pending | "Fetching your agent." It is replaced by the card as soon as the download lands. |
| Phone offline, or the server unreachable | The last card it downloaded, with "From 14:02 (offline). Tap to retry." It never shows a spinner or a broken image. |
| Account has no agent | A card that says so, and a tap that opens `/create`. |
| Token revoked from /glance | A "Widget unlinked" card whose tap re-opens the link flow. The app drops the dead token. |
| App force-stopped, or phone rebooted | The widget survives both: the bitmap is on disk, the schedule is WorkManager's, and both come back with the launcher. |

### Which agent it shows

Your first agent, unless the widget was linked while a different one of yours was selected on
`/glance`; that agent is then pinned to the token. Repoint a widget with
`PATCH /api/glance/token` (`{ "id": "<token id>", "agent": "<agent id>" }`) or relink it.

### Revoking a widget

Open [three.ws/glance](https://three.ws/glance) signed in and scroll to **Linked widgets**.
Every phone widget is listed by the label it was linked with, its token prefix, and when it
was last seen. **Revoke** invalidates that token; on its next refresh the widget shows the
"Widget unlinked" card. Nothing else about your account changes: the token could only ever
read your glance card.

### How the widget authenticates

A home screen widget outlives every browser session, and Android fetches it from an OS process
with no cookie jar, so it cannot use the session. Instead `/glance` mints a **widget token**
(`POST /api/glance/token`), a random 32-character credential prefixed `glw_`. The server stores
only its SHA-256; the plaintext travels once, inside a `threews://glance/link?token=…` deep
link that only the `ws.three.app` package can claim, and then lives in the app's private
storage. The Apple apps claim the same URL through the `threews` scheme and put the token in a
shared keychain group. The token is accepted by exactly one endpoint, `GET /api/glance/mine`, and reads
exactly one thing: the owner's card.

### For developers

The native sources live in [solana-mobile/android-overlay/](../solana-mobile/android-overlay/README.md)
and are laid over the Bubblewrap-generated project by `solana-mobile/scripts/apply-overlay.mjs`
during `build-apk.sh`. The emulator recipe for the five checks (add from the picker, refresh
without opening the app, survive force-stop, survive reboot, hold the cached card in airplane
mode) is in [solana-mobile/README.md](../solana-mobile/README.md#emulator-qa).

## Windows 11

Installs with the PWA, no store submission: open three.ws in Edge, install it, open the widgets
board (`Win + W`), **Add widgets**, pick **Agent glance**. It authenticates with your session and
refreshes every 15 minutes. Details in [glance.md](glance.md#on-the-windows-11-widgets-board).

## macOS and iOS

One WidgetKit extension serves both, in small, medium and large. It fetches the same
`/api/glance/mine?format=png` with the same kind of widget token, kept in the keychain and
shared with its host app.

### On a Mac

1. Install **three.ws Glance**, the small menu bar app that holds the token. It is a Developer
   ID build, so it does not go through the App Store.
2. Open [three.ws/glance](https://three.ws/glance) signed in, press **Link this device**, and
   let the app claim the link. If the browser is signed in on a different machine, copy the
   code the page shows and paste it into the app instead.
3. Click the date in the menu bar to open Notification Centre, scroll to **Edit Widgets**, find
   **three.ws Glance**, and drag **Agent glance** out.

The menu bar item shows the same card, and carries **Open my agent**, **Refresh now** and
**Unlink this Mac**.

### On an iPhone or iPad

Requires the three.ws iOS app on iOS 17 or later ([ios-app.md](ios-app.md)). Link it exactly
the same way from [three.ws/glance](https://three.ws/glance), then long-press the home screen,
tap **Edit**, tap **Add Widget**, and pick **three.ws**.

### What it does

The system refreshes it on its own timeline; the widget asks for about every half hour, and 15
minutes after a refresh that failed. With no network it draws the last card it downloaded with
"From 14:02 (offline)" under it, never a spinner and never a broken image. It follows the
reader's appearance: each refresh fetches the card in both themes, so a Mac in light mode gets
a light card. Tapping it opens the agent, on the phone in the app and on a Mac in the browser.

The states are the ones in the Android table above, and they come from the same server. The two
extra ones are local: a device with no token yet says "Add your agent", and a device that has a
token but has not finished its first download says "Fetching your agent".

### For developers

The sources are in [apple/](../apple/README.md): `apple/GlanceKit/` is shared, the extension is
`apple/GlanceWidget/`, the Mac app is generated from `apple/macos/project.yml` with XcodeGen,
and the iOS extension is a target in the committed Capacitor project. `npm run check:apple-widget`
verifies both projects and the wire contract without a Mac.

## The endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/glance/mine?format=png&size=small\|medium\|large&theme=dark\|light&scale=1\|2\|3&platform=android\|ios\|macos` | The card bitmap for the caller (widget token as `Authorization: Bearer`, or the session cookie). Always `200`; the state is in `x-glance-state` and the tap target in `x-glance-url`. `platform` only decides which hand-off an unlinked card's tap opens. |
| `GET /api/glance/mine` | The same as JSON: `{ signedIn, state, card, notice, agents, … }`. |
| `POST /api/glance/token` | Mint a widget token (session, same-site). Returns the plaintext once plus `links.android` and `links.apple`. |
| `GET /api/glance/token` | List the caller's live tokens. |
| `PATCH /api/glance/token` | Repoint a token at another owned agent. |
| `DELETE /api/glance/token?id=…` | Revoke a token. |
| `GET /api/glance/card?agent=…&format=png` | Any public agent's card as a bitmap, no auth. |

The wire format is pinned in [specs/GLANCE_CARD.md](../specs/GLANCE_CARD.md); the full endpoint
reference is in [api-reference.md](api-reference.md#glance-api).
