# Feature 22: projector mode, the world on the venue's big screen

Tomorrow there is a physical room with a big screen. The best thing that screen can show is the live world itself: the crowd, the stage, the jumbotrons, with event branding over it. Today the closest thing is zen mode plus the cinematic camera, which still spawns a visible player and shows player-grade UI. Build a real broadcast view.

## Where the code lives

- URL params: parsing in `src/game/coincommunities.js` and the canonicalisation in `enter()`, where the `history.replaceState` rewrite rebuilds the query from scratch with exactly `coin`, `name`, `symbol`, `image`, `tier` (holders worlds) and `ui`. Any new param MUST be added there or it is dropped on entry: this is the known trap
- Cameras: `src/game/camera-modes.js` (cinematic mode exists) and `src/game/hud/camera-rig.js` (it now honors `prefers-reduced-motion`, suppressing shake and the speed FOV kick; the director rotation must respect the same switch, since a venue machine may have it set)
- Zen and embed precedents: `ui=hidden` and `bg=transparent` handling in `src/game/coincommunities.js`
- Server join: `multiplayer/src/rooms/WalkRoom.js` join options (there is no `spectator` option yet; every join spawns a visible player); the client sends them from `src/game/community-net.js`
- Event state: `public/event.json` via `src/game/event-countdown.js` and the shared `src/shared/event-config.js` reader (between events the file holds an explicit no-event state, `id: null`, which must render as the no-event overlay, not as an error); the go-live moments in `src/game/meetup-event.js` and `fireworks.js` are the shots worth cutting to; live activity if Feature 15 lands; invite QR if Feature 16 lands (`qrcode` is already a dependency)

## What to build

1. **`?director=1`.** A new param (added to the canonical allowlist) that enters the world as a spectator: no avatar spawned, not counted in minigames or crowd logic, invisible to players. This needs a server-honored `spectator` join option in `WalkRoom` so it is real, not a hidden local avatar other clients still receive.
2. **Auto-director camera.** A shot rotation across the world's actual points of interest (spawn plaza crowd, chart jumbotron, dance floor, the stage if Feature 17 landed, wherever player density is highest right now): slow dollies and orbits, cut every 15 to 30 seconds, never clipping through geometry (reuse the collision-aware rig). Player density should genuinely influence shot choice; an empty corner is not a shot.
3. **Broadcast overlay.** A clean lower-third: event name and LIVE or countdown state from `event.json`, world name and symbol, live online count, and, if available, the activity ticker rows and an invite QR in a corner. Typography at projector scale (readable from the back of a room), on brand, no player HUD anywhere.
4. **Unattended resilience.** This screen runs for hours with nobody at the keyboard: reconnect forever with backoff (never surface a terminal error card; show a quiet "reconnecting" state over the last frame), request a wake lock, hide the cursor after idle, and auto-recover from WebGL context loss by reloading itself.
5. **Performance headroom.** Target the venue machine, not a phone: full render scale, but keep the overlay out of the render loop and DOM-stable. A dropped frame on the big screen is visible to a whole room.

## Verify

- `npm run dev` with two normal players plus one director tab: the director is invisible in both player clients and absent from the online count seen in-world (or counted separately; decide and state it), shots rotate across occupied areas, overlay states correct for upcoming, live, and no-event.
- Kill the network for 30 seconds: quiet recovery, no error card. Simulate context loss (`WEBGL_lose_context`): the view comes back without a human touching it.
- One-hour soak: stable memory, no DOM growth. `npm test` green.

## Report format

Files shipped, the exact URL to put on the venue machine, the spectator join contract, the shot list logic in three sentences, soak results, and the `data/changelog.json` entry.
