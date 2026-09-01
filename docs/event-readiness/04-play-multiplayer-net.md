# Audit 4: /play multiplayer, networking, and presence

The event means many strangers in one world at once. Connection handling has to be boring and invisible: join fast, never silently desync, recover from every drop.

## Where the code lives

- Net layer and server URL: `src/game/community-net.js` (defaultServerUrl is documented in `pages/play.html`)
- World boot: `src/game/coincommunities.js`
- Voice: `src/game/voice-chat.js`
- Ambient population (client-side, non-networked): `src/game/ambient-crowd.js`
- Friends/presence: `src/game/friends-panel.js`
- Persistence: `src/game/world-persist.js`

## What to audit

1. **Join path.** Time from page load to seeing other players. Any handshake failure must surface a designed, actionable error (what happened + retry button), never an empty world that looks single-player when it silently failed.
2. **Reconnect.** Kill the socket mid-session (devtools offline toggle, 10s, then online). The client must reconnect automatically, resync player positions, and show a subtle "reconnecting" indicator while it does. State after resync must match the server (no ghost players, no duplicated self). Note `community-net.js` already reconnects with backoff: the attempt counter resets on every successful join, so `MAX_RECONNECT_ATTEMPTS` (14, about 11 minutes with the once-a-minute tail) bounds one outage and rides out a server redeploy before parking on `offline` with the manual `retry()`; a holder-gate refusal from `onAuth` is terminal and routes back to the gate instead of looping. A failed connect logs at info through the gated logger, not as a console warning. The boot watchdog in `pages/play.html` deliberately ignores a WebSocket-shaped rejection, so a flaky reconnect never trips the "could not load the world" card.
3. **Backgrounding.** Switch tabs for 2 minutes and come back. Mobile Safari will have frozen the socket: same reconnect path must handle it.
4. **Two-client consistency.** Open two browser contexts in the same coin world. Movement, chat, and emotes must appear on the other client within a human-imperceptible delay. Check name labels, avatar appearance, and cosmetics sync both ways.
5. **Chat hygiene.** Long messages wrap, links do not inject HTML (verify escaping), spam has some throttle, and the log does not grow unbounded in memory.
6. **Voice.** `voice-chat.js` is surfaced (lazy-imported by `coincommunities.js` behind the HUD voice button), so test the full path: permission prompt, mute state visible to others, teardown on leave. Two hardening points to keep intact: a denied mic closes the `AudioContext` it just opened (browsers cap concurrent contexts, so leaking one per refusal made voice permanently unopenable), and an already-connected peer holds two ranks of hysteresis past `MAX_VOICE_PEERS` before it is dropped, so a crowd cannot churn WebRTC handshakes frame to frame. If it is broken and unfixable today, hide the entry point rather than shipping a dead button.
7. **Scale behavior.** Simulate a crowded room (multiple headless Playwright contexts, or whatever the net layer allows). Watch for O(n^2) update patterns and per-player DOM label churn.
8. **Mobile memory.** A phone that runs out of memory does not throw a JS error: the browser kills the tab, the socket dies mid-session, and the page reloads. In the server log that reads as a join followed by a leave a few seconds later, over and over, which looks like a networking bug and is not one. Watch the bytes, not the console. `scripts/play-mobile-repro.mjs` drives a phone-emulated /play session and prints every download attributed to the code that asked for it (`ENGINE=chromium node scripts/play-mobile-repro.mjs https://three.ws/play 120000`). Anything that loads community-uploaded models must work to a budget: the gallery is uncapped and single avatars there reach 24 MB. `src/game/ambient-crowd.js` holds the reference implementation (per-model cap, per-visit download cap, load-once-and-clone, release on leave).

## Verify

- Scripted two-context Playwright run joins the canonical $THREE world (URL in `docs/event-readiness/README.md`), exchanges chat, survives a forced disconnect, and asserts resync. Keep the script in `scripts/`.
- Zero console errors across the run.
- `npm test` stays green.

## Report format

Each failure mode tested and its result (pass / fixed / cannot-fix-with-reason). State the server-side capacity assumption you tested against so the event-day runbook (prompt 10) can pre-scale it.
