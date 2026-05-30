# three.ws — 3D World "Make It Fun" Roadmap (25 agent tasks)

Goal: turn the existing 3D worlds from a pretty hangout into a place with things to **do**
together — Roblox-style social play + mini-games + avatar economy, plus rendering the
already-built Kintara RPG, plus a Minecraft-style shared sandbox.

## How to run this

Each numbered item below is a **self-contained prompt** — paste it into a fresh agent chat.
The repo's `CLAUDE.md` (quality bar, no-mocks, definition-of-done, push-to-both-remotes) loads
automatically in every chat, so the prompts stay focused on spec + files.

**Respect the waves.** Tasks in the same wave touch different files and can run in parallel.
Later waves depend on earlier ones (noted per task). Do NOT run two tasks that edit the same
file in parallel — they'll conflict on merge.

Key existing files (for reference, don't make agents re-discover these):
- `/play` scene: `src/game/coincommunities.js`, `coincommunities-ui.js`, `coincommunities.css`
- `/play` net client: `src/game/community-net.js`
- Server: `multiplayer/src/rooms/WalkRoom.js`, `multiplayer/src/schemas.js`
- RPG server (done, unrendered): `multiplayer/src/rooms/GameRoom.js`, `multiplayer/src/schemas/game.js`, `multiplayer/src/rooms/realms.js`; client net `src/game/game-net.js`
- Avatars/anim: `src/animation-manager.js`, `public/animations/manifest.json` (70 clips)
- Accessory GLBs (unwired): `public/accessories/` (hats, glasses, earrings)
- Payments: `api/x402/`, `agent-payments-sdk/`, `solana-agent-sdk/`

---

## WAVE 0 — Shared foundation (run first, sequentially; everything else builds on these)

### Task 1 — Server: generic world-object state sync
Extend the multiplayer server so worlds can hold shared, networked **objects** (not just players):
balls, thrown props, placed build pieces, pickups. In `multiplayer/src/schemas.js` add a
`WorldObject` schema (`id, type, x, y, z, yaw, scale, ownerId, vx, vy, vz, kind, ts`) and a
`objects: MapSchema<WorldObject>` on the world state. In `multiplayer/src/rooms/WalkRoom.js` add
message handlers `obj:spawn`, `obj:update`, `obj:remove` with per-client rate limits (match the
existing chat/emote limiter style) and the same avatar-style anti-cheat bounds (clamp to world
radius, cap object count per room ~200, cap per-player ~30). Server is authoritative for object
lifetime and cleanup on owner disconnect. Keep it generic — the `kind` string lets later features
(ball, confetti, block, prop) reuse one channel. Document the protocol in a top comment.
**Done:** schema compiles, room handlers rate-limited and bounded, no client changes needed yet,
existing /play and /walk still connect and behave identically.

### Task 2 — Client: WorldObjects manager for /play
Build a client manager that mirrors Task 1's `objects` map into the 3D scene. New module
`src/game/world-objects.js` exporting a `WorldObjects` class: subscribe to `community-net`
add/change/remove for objects, instantiate a Three.js node per object (primitive mesh or GLB by
`kind`), interpolate position/rotation each frame (reuse the `REMOTE_LERP` interpolation pattern
from `RemotePlayer` in `coincommunities.js`), and dispose cleanly. Wire it into `CoinCommunities`'
loop and net events. Add `community-net.js` methods `spawnObject/updateObject/removeObject`
mirroring its existing `sendChat/sendEmote`. Provide a tiny `kind` registry so later tasks register
their own mesh factory without editing this file.
**Depends on:** Task 1. **Done:** objects spawned via net appear, interpolate, and clean up for all
clients; manager is feature-agnostic.

### Task 3 — Cosmetics rig: wire the accessory GLBs to avatars
The GLBs in `public/accessories/` (baseball/beanie/cowboy hats, round/shades glasses, hoop/stud
earrings) are unused. Build attachment so a player can wear them. In the avatar build path
(`buildAvatar` / `RemotePlayer` in `coincommunities.js`), after the GLB loads, find the head bone
and parent attachment points; add `equipCosmetic(slot, url)` / `unequip(slot)` that loads and
parents an accessory GLB with a per-slot offset table (hat = top of head, glasses = eyes, earrings
= ears). Add a `cosmetics` string field to the player schema (`multiplayer/src/schemas.js`,
comma-separated slot:url) and sync it like `avatar`; apply remote players' cosmetics on add/change.
Add a `community-net` `setCosmetics()` send. Whitelist accessory URLs server-side like avatars.
**Done:** equipping a hat shows it on your head AND on everyone else's view of you, persists through
the session, survives avatar swaps.

---

## WAVE 1 — Social playground (parallel after Wave 0; each is its own feature)

### Task 4 — Emoji & confetti reactions
Add lightweight broadcast reactions to `/play`. A reaction bar (extend the emote tray in
`coincommunities-ui.js`) with ~6 emoji (🎉😂🔥❤️👏🤔). Clicking sends a `reaction` over
`community-net` (new server broadcast in `WalkRoom.js`, 500ms cooldown). On receipt, spawn a
floating-rising-fading emoji sprite above the sender's avatar (reuse the screen-projection logic in
`_updateLabels`) plus a small confetti particle burst for 🎉. Pure visual, no object persistence
needed (broadcast, not state). Designed empty/loading/active states, hover/active on buttons.
**Done:** reactions pop above the right avatar for everyone, feel snappy, no jank with 10+ at once.

### Task 5 — Kickable physics ball
Spawn a shared beach ball in `/play` that players kick by walking into it. Use Wave-0 object sync
(`kind:'ball'`) with the SERVER owning simple physics: on collision intent from a client
(`ball:kick` with impulse direction from player velocity), the server applies velocity, integrates
with friction + world-radius bounce, and streams position via the objects map. Register a ball mesh
factory in the WorldObjects `kind` registry (Task 2). One ball per room, auto-respawns at center if
it leaves bounds or on room start.
**Depends on:** Tasks 1, 2. **Done:** any player can kick it, all clients see the same trajectory,
it settles realistically and never desyncs badly.

### Task 6 — Dance floor zone
Add a circular "dance floor" pad near (but not on) the totem in `/play`: emissive animated tiles +
pulsing lights. When a player stands on it, auto-suggest dance emotes; add a "🪩 Dance" button that
triggers a synchronized dance — everyone on the floor crossfades to the same dance clip on a shared
beat (broadcast a `floor:beat` tick from the server every N seconds so dances line up). Use clips
already in the manifest (`av-dance-shuffle`, `av-rap-dance`, `av-headbang`, `dance`).
**Done:** standing on the floor + pressing dance syncs your avatar with others on the floor; lights
react; leaving the floor returns you to idle.

### Task 7 — Mini-game: King of the Totem
A round-based game in `/play`: hold the area at the base of the totem to score. Server tracks who is
inside the king-zone radius and awards points/sec to the sole occupant (contested = no points),
running 90-second rounds with a winner announce + confetti. Add server state (`game:king` round
timer, scores per player) and broadcasts; client HUD shows a round timer, live scoreboard, your
score, and a winner banner. Reuse the reaction confetti from Task 4 if present, else a simple burst.
**Done:** round starts/ends on a timer, scoring is correct and contested-aware, HUD is clear, winner
is celebrated, works with 2+ players.

### Task 8 — Mini-game: Tag
"It"-tag in `/play`. Add an `it` boolean (+ `itSince`) to the player schema; one random player
becomes "it" when ≥2 players are present. Walking adjacent to another player transfers "it" (server
validates proximity + a 2s tag-back immunity). "It" has a visible marker (red glow ring under the
avatar + a 🏃 over the head). HUD shows who's it and a "you're it!" alert. Track per-session
time-as-it for a lightweight leaderboard.
**Done:** it transfers correctly on contact with immunity, the marker is obvious to everyone, fun
with 3+ players, no exploit to tag from across the map.

### Task 9 — Emote wheel (expose all 70 animations)
Replace/augment the 6-button emote tray with a radial emote wheel (hold a key / long-press to open,
move to select, release to play) exposing categories from `public/animations/manifest.json` (dances,
flips, poses, combat, social). Lazy-load clips on first use (the manager already supports this).
Keyboard + touch + gamepad-friendly, with category arcs and labels/icons. Keep the existing quick
tray for the top 6.
**Done:** wheel opens smoothly, all manifest emotes are reachable and categorized, selection plays
and broadcasts via the existing emote path, accessible (keyboard + screen-reader labels).

---

## WAVE 2 — Render the Kintara RPG (mostly sequential; this is the big one)

> The server (`GameRoom.js`), schema (`schemas/game.js`), realms (`realms.js`), and client net
> (`game-net.js`) are COMPLETE. These tasks build the missing 3D client. Do them in order.

### Task 10 — Kintara scene scaffold + tile renderer
Create the entry: `pages/game.html` + `src/game/kintara.js` (mirror how `play.html` →
`coincommunities.js` is wired). Connect via `GameNet` (`src/game/game-net.js`) to `GameRoom`. Set up
a Three.js scene with an **orthographic isometric** camera (rotatable yaw, fixed pitch ~35°), and on
the `realm` message render the tile grid: floor tiles, blocked/water tiles, zone tints
(safe/PvP/danger), bank zone, fishing/cooking tiles, fountain. Reuse the renderer/lighting/loop
structure from `coincommunities.js`. No players/nodes yet.
**Done:** entering loads a realm and draws its grid correctly with zones visually distinct; camera
orbits/zooms; matches the realm data in `realms.js`.

### Task 11 — Kintara players: avatars on the tile grid
Render local + remote players from `GamePlayer` state. Reuse the avatar rig + AnimationManager from
`coincommunities.js` (`buildAvatar`, `RemotePlayer` interpolation). Convert tile coords (`tx,ty`) →
world position, animate tile-stepped movement (smooth glide between adjacent tiles), drive
idle/walk/run motion states, render name labels (reuse the projected-label system) and HP bars.
Send `step` intents from WASD/click-to-move respecting the server's 8-way adjacency.
**Depends on:** Task 10. **Done:** you and others walk the grid smoothly, animations match motion,
names + HP show, movement is server-validated (no teleport).

### Task 12 — Resource nodes + gathering
Render `ResourceNode` state (trees, rocks, coal) as meshes on their tiles; show depleted/respawning
states. Wire the `gather` intent: walk adjacent + click a node to harvest (server gates on
tool+skill). Add harvest feedback — swing animation, a glow/particle on hit, an item-gained toast,
and node depletion/respawn visuals.
**Depends on:** Task 11. **Done:** gathering works end-to-end against the server (wood/stone/coal),
respects tool/skill gates, feels responsive with clear feedback.

### Task 13 — Combat + mobs
Render `Mob` state (training dummy, goblin, ogre) with HP bars, idle/roam animation, aggro, hit
flashes, death + respawn. Wire the `attack` intent (sword equipped + adjacent). Add hit feedback
(damage numbers, flash, knockback tween), death VFX, and your own death/respawn handling. Respect
PvP/safe zones from realm data.
**Depends on:** Task 11. **Done:** combat loop works vs mobs, HP/damage/death/respawn all sync,
zones enforced, feels punchy.

### Task 14 — Inventory + hotbar + bank UI
Build the RPG UI chrome (new `src/game/kintara-ui.js`, styled to match the `cc-*` token system):
24-slot backpack with drag-reorder (`invMove`), 6-slot hotbar with equip (`equip`/`activeSlot`),
item tooltips/icons/stack counts, and the bank window (`bankOpen`/`bankDeposit`/`bankWithdraw`) that
opens near the Mainland bank zone. All wired to `GameNet`.
**Depends on:** Tasks 12, 13 (so there are items to hold). **Done:** drag/drop, equip, and banking
all work against the server with correct state; polished, keyboard-navigable, designed empty states.

### Task 15 — Skills HUD + XP/level feedback
A skills panel (combat, woodcutting, mining, fishing, cooking) showing level + XP progress from
player state, with level-up celebration VFX/sound and floating XP toasts on each gather/kill. Fishing
(cast at fishing tiles) and cooking (at the roast pit) action UIs — the server logic exists; add the
client interactions + a small timing element to make them feel like mini-games.
**Depends on:** Tasks 12, 13. **Done:** levels/XP display live, level-ups feel rewarding, fishing &
cooking are playable and fun, all server-validated.

### Task 16 — Realm portals + travel + minimap
Render portals as meshes at their tiles; walking into one triggers the realm transition (re-render
via Task 10's path) with a transition wipe. Add a minimap (top-down of the current realm with
players/nodes/portals) and a zone banner ("⚔️ Wilderness — PvP"). Add a discovery/world-select entry
so players can find Kintara from the site.
**Depends on:** Task 10. **Done:** travel between all 4 realms works smoothly, minimap is accurate,
zones are clearly communicated, Kintara is reachable from navigation.

---

## WAVE 3 — Sandbox building (Minecraft-style; depends on Wave 0 object sync)

### Task 17 — Persistence layer for world objects
Make placed objects durable per coin world. Add a storage-backed API/worker (use the existing
`api/`/`workers/` patterns and whatever KV/DB the repo already uses — inspect, don't invent a new
provider) keyed by coin mint. `GameRoom`/`WalkRoom` loads saved objects on room create and persists
on `obj:spawn/update/remove` (debounced). Real backend, no in-memory-only.
**Depends on:** Task 1. **Done:** placing objects, leaving, and re-entering a coin world shows the
same build; persistence survives server restart.

### Task 18 — Build mode + placement UI
A "Build" toggle in `/play` that opens a palette of placeable props/blocks (start with a handful of
primitives + a few GLB props; reuse accessory/prop loading). Ghost-preview the piece at a snapped
position under the cursor/reticle, rotate with a key, place (sends `obj:spawn kind:'block'`), and
delete your own pieces. Clean enter/exit of build mode (movement vs build cursor).
**Depends on:** Tasks 1, 2. **Done:** you can place, rotate, and remove pieces; preview is clear;
placements appear for everyone via object sync; feels good on desktop + touch.

### Task 19 — Build netcode hardening + permissions + anti-grief
Server-side validation for builds in `WalkRoom.js`: ownership (only delete your own unless you're the
coin creator), per-player placement caps, rate limits, bounds, and a simple grief guard (no burying
spawn/totem, max density per tile). Add an admin/creator "clear area" for the coin owner.
**Depends on:** Tasks 17, 18. **Done:** griefing is bounded, ownership enforced, creator moderation
works, limits are clearly surfaced in the UI (no silent failures).

### Task 20 — Structures, snapping, and sharing
Level up building: a grid/snap system so blocks align into structures, a few composite pieces
(wall, floor, ramp, door), a copy/screenshot-a-build share action, and a small "featured builds"
surface per coin. Keep performance sane (instance/merge static blocks).
**Depends on:** Tasks 18, 19. **Done:** building structures is satisfying and snaps cleanly, large
builds stay performant, you can share a build, no console warnings.

---

## WAVE 4 — Avatar economy (depends on Task 3 cosmetics rig + x402 rails)

### Task 21 — Cosmetics catalog + shop UI
Define a cosmetics catalog (JSON/API) covering the accessory GLBs + a set of premium emotes/skins,
each with id, name, slot, price, rarity, preview image. Build a shop UI (matches `cc-*` tokens) to
browse, filter by rarity, and **preview cosmetics live on your own avatar** before buying. Owned vs
locked states.
**Depends on:** Task 3. **Done:** catalog loads from a real endpoint, live preview works on your
avatar, owned/locked states correct, polished empty/loading/error states.

### Task 22 — x402 purchase flow
Wire real purchases: buying a cosmetic triggers an x402 USDC payment (reuse `api/x402/` +
`agent-payments-sdk/`), and on success records ownership to the player's account/wallet. Real payment
rail — no fake "purchased" toasts. Handle pending/success/failure/insufficient-funds at the boundary.
**Depends on:** Task 21. **Done:** a real USDC payment unlocks the cosmetic, ownership persists,
all payment states are handled and surfaced honestly.

### Task 23 — Owned-cosmetics inventory + equip persistence
A "My Cosmetics" inventory of owned items; equipping persists to the account and re-applies on next
login and across worlds (/play and /walk). Ties the Task 3 rig to durable ownership rather than
session-only.
**Depends on:** Tasks 3, 22. **Done:** owned cosmetics persist across sessions and worlds, equip
state is restored on login, equipping is reflected to other players.

### Task 24 — Token-gated worlds
Let a coin's world optionally require holding $COIN to enter. Add a server-side balance check (via
`solana-agent-sdk/` / RPC) at join, a gating config per coin (creator-set threshold), and a clear
client gate screen ("Hold X $COIN to enter — buy here" linking the existing pump swap) for users who
don't qualify.
**Depends on:** existing Solana rails. **Done:** gating works against real on-chain balances, the gate
screen is helpful and actionable, non-gated worlds are unaffected.

### Task 25 — Creator revenue splits + economy polish
On cosmetic sales tied to a coin, split x402 revenue to the coin creator's wallet (configurable %),
with a creator earnings view in the dashboard. Add a platform-wide cosmetics leaderboard / "rarest
fits" flex surface to drive the Roblox-style status loop.
**Depends on:** Task 22. **Done:** revenue splits pay out for real, creators can see earnings, the
flex/leaderboard surface is live and links back into worlds.

---

## Suggested dispatch order

1. **Wave 0** (Tasks 1→2→3) — sequential, unblocks everything. ~3 chats.
2. **Wave 1** (Tasks 4–9) — parallel, 6 chats. Fastest visible fun.
3. **Wave 2** (Tasks 10→11→{12,13}→{14,15,16}) — the RPG, ~7 chats, mostly ordered.
4. **Wave 3** (Tasks 17→18→19→20) — building, 4 chats.
5. **Wave 4** (Tasks 21→22→{23,24,25}) — economy, 5 chats.

Total: 25. Within a wave, only parallelize tasks that don't edit the same file — Wave-1 tasks each
add their own modules but several touch `WalkRoom.js`/`coincommunities-ui.js`, so stagger those or
have one agent own the shared file per wave.
