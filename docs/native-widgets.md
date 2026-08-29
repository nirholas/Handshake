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
storage. The token is accepted by exactly one endpoint, `GET /api/glance/mine`, and reads
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

Planned: a shared WidgetKit extension (a `TimelineProvider` that fetches
`/api/glance/mine?format=png` with a widget token stored in the keychain) and a small SwiftUI
host app that signs in and mints the token. macOS ships first because it can be distributed
outside the App Store; the iOS build is the same extension target and waits on an Apple
Developer account. The card, the token, and the endpoint are the ones above; nothing on the
server changes for either.

## The endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/glance/mine?format=png&size=small\|medium\|large&theme=dark\|light&scale=1\|2\|3` | The card bitmap for the caller (widget token as `Authorization: Bearer`, or the session cookie). Always `200`; the state is in `x-glance-state` and the tap target in `x-glance-url`. |
| `GET /api/glance/mine` | The same as JSON: `{ signedIn, state, card, notice, agents, … }`. |
| `POST /api/glance/token` | Mint a widget token (session, same-site). Returns the plaintext once plus `links.android`. |
| `GET /api/glance/token` | List the caller's live tokens. |
| `PATCH /api/glance/token` | Repoint a token at another owned agent. |
| `DELETE /api/glance/token?id=…` | Revoke a token. |
| `GET /api/glance/card?agent=…&format=png` | Any public agent's card as a bitmap, no auth. |

The wire format is pinned in [specs/GLANCE_CARD.md](../specs/GLANCE_CARD.md); the full endpoint
reference is in [api-reference.md](api-reference.md#glance-api).
