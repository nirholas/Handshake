# Feature 17: live hosted show on a plaza stage inside /play

The platform already has Living Stages: an embodied AI host runs a real-time show with spatial voice, lip-sync, synced captions, an audience question queue, and a verified on-chain $THREE tip leaderboard where a tip pre-empts the host's next line in about a second. All of it works, and none of it is reachable from the world: `grep -r stage src/game/` finds zero references. Put a stage in the $THREE plaza and let the event crowd attend a show without leaving /play.

## Where the code lives

- Show engine (server): `multiplayer/src/rooms/StageRoom.js`, `multiplayer/src/stage-show.js` (the pure `ShowDirector` with beats OPENER, TIP_SHOUTOUT, ANSWER, BANTER, GAME), `multiplayer/src/stage-schemas.js`, `multiplayer/src/stage-registry.js`. Room registered as `stage_world` with `filterBy(['stageId'])` in `multiplayer/src/index.js`
- Show client (page-level, reuse it): `src/stage.js`, `src/stage-net.js`, `src/stage-element.js`, served at `pages/stage.html`
- Show API: `api/stage/index.js` (directory, create, golive, endshow, `nextShowAt` scheduling), `api/stage/host.js` (the host's words), `api/stage/tip.js` (on-chain verified, idempotent per signature); host voice via `api/tts/speak`
- The world to mount into: `src/game/coincommunities.js` (main scene), landmark placement precedent in `src/game/wheel-station.js` and `src/game/home-town.js`; server-validated landmark coordinates in `multiplayer/src/world-features.js`
- Multiplayer client for the world room: `src/game/community-net.js` (Colyseus `walk_world`); the stage join is a second, concurrent room connection

## What to build

1. **The stage landmark.** A real stage structure in the $THREE world plaza: platform, backdrop, marquee screen. The marquee shows the show state from `api/stage/index.js`: live now, next show time (`nextShowAt`), or a designed idle state. Register its footprint in `world-features.js` so the server can validate proximity.
2. **Proximity attendance.** Walking near the stage joins the coin's `stage_world` room alongside the existing `walk_world` connection (derive `stageId` from the mint deterministically). Reuse `stage-net.js` and the utterance rendering from the stage client rather than rewriting: the host avatar on stage speaks with TTS voice, lip-sync, and captions, synced across every attendee. Walking away leaves the stage room cleanly.
3. **Audience presence.** Attendees get the server-assigned ring seats StageRoom already deals out, rendered as marked spots in front of the stage; the question queue is reachable from the in-world chat bar while attending.
4. **Tips in-world.** A tip action at the stage that runs the existing `api/stage/tip.js` flow (this is an on-chain $THREE spend: render recipient, amount, and token and get the user's explicit confirmation before signing, every time). The tip leaderboard renders on the marquee, and a landed tip pre-empts the host beat exactly as it does on /stage.
5. **Cost discipline.** Everything here mounts lazily on first proximity and fully unmounts when the show is over and the player leaves. No stage room connection, no TTS fetches, no per-frame work for players who never approach. When no show exists and none is scheduled, the stage is a quiet decorated landmark, not an error.

## Verify

- Two browsers on `npm run dev` (multiplayer server running locally per `multiplayer/README.md` if present, else against the deployed room): create a show via `api/stage/index.js`, go live, and confirm both clients hear and read the same utterances at the stage, seats assigned, question queue round-trips.
- Tip path exercised end to end on a test amount with the confirmation gate shown; leaderboard updates; replaying the same signature does not double-count.
- Walk-away tears down the stage room connection (network tab shows the socket close); a player who never approaches the stage opens zero stage requests.
- `npm test` green.

## Report format

Files shipped, how `stageId` is derived, the join and teardown lifecycle in three sentences, what the marquee shows in each state, and the `data/changelog.json` entry.
