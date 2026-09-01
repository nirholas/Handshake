# Feature 23: the signature wall, a permanent artifact of the event

Events end; walls remember. Give the $THREE world a signature wall near spawn where every attendee can leave their name and a short line, rendered as graffiti everyone sees, persisted forever. It costs visitors ten seconds, gives them ownership of the space, and becomes the artifact the community links back to after the event.

## Where the code lives

- Persistence precedents: the per-world build doc behind `src/game/world-persist.js` (`api/world/[action].js` over `api/_lib/world-store.js`: a Postgres `world_docs` index row is always the source of truth, large docs offload to an R2 blob, and writes carry an etag with 409 on conflict; the browser only writes when no `walk_world` room is authoritative), Upstash Redis behind `api/play/builds.js` (`api/_lib/builds-store.js`); pick the store that fits an append-only list of small records and state why
- Canvas-rendered world screens: `src/game/screen-texture.js` (shared quality pattern), `src/game/chart-screen.js`, `src/game/x402-jumbotron.js` and the marquee in `src/game/plaza-stage.js` as CanvasTexture precedents; the war portal's board in `src/game/war-portal.js` is the precedent for a screen that fetches nothing until a player is within reading range
- Interaction and placement: landmark precedent in `src/game/wheel-station.js`; the contextual F interaction chain in `src/game/coincommunities.js`
- Safety: the slur gate in `multiplayer/src/rooms/WalkRoom.js` and `multiplayer/src/display-name-safety.js` (reuse the same filters server-side on the write path)
- Identity: the play pass from `src/game/play-auth.js` distinguishes signed-in wallets from guests

## What to build

1. **The wall.** A physical wall near spawn, textured by a CanvasTexture that composites signatures as varied graffiti (a few fonts, sizes, rotations, ink colors seeded per signature so the wall looks organic, not like a spreadsheet). A counter shows how many have signed.
2. **Signing.** Walk up, F to sign: name (prefilled from the player's display name) plus an optional line capped around 80 characters. Signed-in wallets sign once ever (idempotent server-side by wallet); guests sign once per session with a nudge that signing in makes it permanent. The new signature appears on the wall with a small ink-splash moment, visible to everyone in the room.
3. **The write path.** One `api/` handler validating length, running the same name-safety and slur filters the chat uses, rate-limited, storing display text only (never wallet addresses in the rendered record). Include a simple owner-only removal path (by signature id) for moderation; document the curl in the pack's runbook file.
4. **Overflow by design.** The wall must look good at 10 signatures and at 5,000: batch signatures into pages the texture cycles through slowly, or grow tiles smaller as density rises; either way the newest signatures get a period of prominence. State the chosen approach. The texture redraw must be incremental or throttled, never a full redraw per new signature at event rates.
5. **The artifact.** A public read endpoint plus a shareable rendering: an OG-card style image of the wall (precedent: `api/og-leaderboard.js`) so "we signed it" can be posted after the event.

## Verify

- Two browsers on `npm run dev`: sign in one, watch it land live in the other and survive both reloads. Second signing attempt on the same wallet is refused with designed feedback.
- Filter path proven: a slur in the message is rejected server-side; markup in the message renders inert (it is untrusted display text, never HTML).
- Load a seeded wall of several thousand signatures: texture stays sharp, frame time flat, memory stable.
- `npm test` green with tests on the write handler (validation, idempotency, rate limit).

## Report format

Files shipped, the store chosen and why, the overflow design in two sentences, the moderation curl, the artifact URL shape, and the `data/changelog.json` entry.
