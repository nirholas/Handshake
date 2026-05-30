# three.ws — 3D World Build Plan (25 parallel agent tasks)

Goal: turn the 3D world into a Minecraft/Roblox-class multiplayer experience for a
large audience, built on what already exists. Four epics + a foundation layer.

**The big unlock:** a full authoritative MMO RPG already exists on the server
(`multiplayer/src/rooms/GameRoom.js`) with a finished client network bridge
(`src/game/game-net.js`) — gathering, mining, fishing, cooking, combat, 5 skills
(1–99), 24-slot inventory + 6-slot hotbar + 48-slot bank, 4 realms with portals,
mobs, gold, death/tombstones. **Nothing renders it.** `/play` currently loads the
*social* walkaround (`src/game/coincommunities.js` → `community-net.js` → `WalkRoom`).
Several tasks below just finish wiring a game you already built.

---

## How to run these

Each task below is a **self-contained prompt** — paste one into a fresh agent chat
in this repo. Every agent must read and obey `CLAUDE.md` (no mocks, real APIs, wire
completely, design every state, run the dev server, run the completionist audit).

**Dependency waves** (run all tasks in a wave in parallel; finish a wave before the next):

- **Wave 0 — Foundations:** T1, T2, T3
- **Wave 1 — RPG scene + Building server + Voice infra + Economy model:** T4, T5, T6, T11, T12, T17, T21
- **Wave 2 — RPG systems + Building client + Voice client + Economy endpoints:** T7, T8, T9, T13, T14, T15, T18, T19, T22
- **Wave 3 — Polish + integration:** T10, T16, T20, T23, T24, T25

Shared protocol facts (give these to any multiplayer task):
- Client bridge `src/game/game-net.js` (class `GameNet`) — methods `step(tx,ty,yaw)`,
  `gather(id)`, `attack(id)`, `invMove(from,to)`, `equip(slot)`, `bankOpen()`,
  `bankDeposit(i,qty)`, `bankWithdraw(i,qty)`; events `status`, `realm`, `notice`,
  `bank`, plus Colyseus `getStateCallbacks` for `state.players/nodes/mobs/tombstones`.
- Server room `multiplayer/src/rooms/GameRoom.js`, schemas `multiplayer/src/schemas/game.js`,
  realm definitions `multiplayer/src/rooms/realms.js`. Room name `game_mainland`. 15Hz patch, 50 max clients.
- Social room: `multiplayer/src/rooms/WalkRoom.js` + `src/game/community-net.js`. The
  social 3D renderer to mirror is `src/game/coincommunities.js`; free-movement reference is `src/walk.js`.
- Server URL resolution: `<meta name="game-server">` in the page, else `wss://<host>:2567`.
- Persistence primitives: `api/_lib/r2.js` (object storage), `api/_lib/db.js` (Postgres `sql`).
- x402 payment reference: `api/x402/dance-tip.js` + `src/club.js` (the only proven money-in-3D flow).
- Voice infra: `agent-voice-chat/` (LiveKit/WebRTC, standalone — not yet wired to worlds).

---

# Wave 0 — Foundations

## T1 — Deploy the multiplayer server to Cloud Run and wire the client

Context: The Colyseus server in `multiplayer/` is not deployed anywhere reachable; the
`game-server` meta tag is empty so the client falls back to `wss://three.ws:2567`
(dead) → `ERR_CONNECTION_TIMED_OUT`. A ready deploy script exists at
`multiplayer/deploy-cloudrun.sh` (correct flags: `--no-cpu-throttling`, single
instance, session affinity, timeout 3600).

Build:
- Run `multiplayer/deploy-cloudrun.sh` against the GCP project (requires `gcloud auth login`
  + `gcloud config set project ...` first; ask the user to authenticate if not).
- Map a stable custom domain `mp.three.ws` to the Cloud Run service (domain mapping or a
  serverless NEG behind an HTTPS LB). The server's `verifyClient` already allows `*.three.ws`.
- Set `<meta name="game-server" content="wss://mp.three.ws">` in BOTH `pages/play.html`
  and (`walk-server`) `pages/walk.html`. Rebuild.
- Verify: `curl https://mp.three.ws/health` returns `{ok:true}`; open `/play`, confirm the
  WebSocket connects (no timeouts) and the `[community-net]` status goes `online`.

Done when: `/play` and `/walk` connect to a live server over `wss://mp.three.ws`, health
check passes, and the console shows no connection errors.

## T2 — Isometric/3D game scene skeleton (the RPG front door)

Context: `src/game/game-net.js` (class `GameNet`, room `game_mainland`) is a complete
client bridge with NO 3D scene consuming it. Build the scene that renders `GameRoom`
state, mirroring the structure of `src/game/coincommunities.js` (renderer, camera,
lights, RAF loop, lobby→world phases) but driven by `GameNet` instead of `CommunityNet`.

Build:
- New `src/game/iso-game.js`: Three.js scene (WebGLRenderer, isometric-ish camera,
  hemisphere+directional lights, RAF loop), a `GameNet` instance, and a clean phase model
  (lobby → connecting → in-world → offline). Reuse `AnimationManager` (`src/animation-manager.js`).
- Render the local player rig (GLB avatar via the existing `resolveAvatarUrl`/`buildAvatar`
  helpers — extract/share them from coincommunities.js rather than copy-pasting).
- Subscribe to `GameNet` events (`realm`, `notice`, `bank`, `status`) and state callbacks
  for `players`. Leave nodes/mobs/inventory rendering to T4–T9 (stub clean extension points).
- Add a route + entry: decide whether this is a new page (`pages/game.html` → `iso-game.js`)
  or a mode toggle inside `/play`. Pick one, wire it, make it reachable from navigation.
- Designed loading + offline + empty states. No console errors.

Done when: visiting the new scene connects to `game_mainland`, renders the local avatar on
a placeholder ground, shows other connected players moving, and exposes documented hooks
(`renderNodes`, `renderMobs`, `bindInventory`, etc.) for the RPG-system tasks.

## T3 — Per-world persistence service

Context: World/game state is currently ephemeral. Building (T11–T16) and the economy
(T21–T25) need durable per-world storage keyed by coin mint (or realm id).

Build:
- A generic persistence API under `api/world/` (e.g. `api/world/[action].js`) backed by
  `api/_lib/r2.js` and/or `api/_lib/db.js`: `load(worldId)` and `save(worldId, doc)` with
  size limits, schema versioning, optimistic concurrency (etag/updatedAt), and auth so only
  permitted writers can save (see T16 for permission model — expose a hook).
- Decide storage: R2 for large blob docs (placed objects), Postgres for indexed/queried
  data (ownership, passes). Document the split in the file header.
- A small server-side client `multiplayer/src/persistence.js` so Colyseus rooms can
  load on `onCreate` and debounce-save on change.

Done when: a room can persist and restore an arbitrary JSON world doc across restarts;
load/save are covered by a unit test in `tests/`; unauthorized writes are rejected.

---

# Wave 1–3 — Epic A: Surface the RPG in /play

## T4 — Tilemap + realm renderer

Depends: T2. Files: `src/game/iso-game.js`, read `multiplayer/src/rooms/realms.js`.
Build: render each realm from the `realm` layout event — ground tiles, blocked zones
(bank, fountain, water), portals (visual + label), safe-zone vs danger-zone tinting.
Use instanced meshes for tiles (perf). Handle realm-switch (clear + rebuild) when the
player takes a portal. Done when: all 4 realms (Mainland, Wilderness, Whisperwood, Pond)
render correctly with portals visible and the bank/fountain/water footprints match the server grid.

## T5 — Local movement (tile-step pathing + click-to-move)

Depends: T2, T4. Build: click-to-move pathfinding on the walkable grid (A* or BFS over
realm walkability), sending one `step(tx,ty,yaw)` per tile via `GameNet`; also WASD/arrow
tile stepping and mobile tap. Smooth visual interpolation between tiles + facing yaw.
Respect server rejections (snap back). Done when: the local avatar paths around obstacles
to a clicked tile, animates walk/idle, and never desyncs from the server position.

## T6 — Remote players rendering + interpolation

Depends: T2. Build: a `RemotePlayer` for `game_mainland` (mirror the one in
coincommunities.js): GLB avatar, animation state from `motion`, position lerp between tile
updates, floating nameplate, HP indication. Add/remove on state callbacks. Done when:
multiple browser tabs see each other move/animate smoothly with correct names.

## T7 — Resource nodes + gathering

Depends: T4, T6. Build: render `state.nodes` (trees, rocks, coal, fishing spots, cooking
spots) with depleted/respawning visual states. Click a node → `gather(id)`; show progress,
tool requirement, cooldown, and floating "+1 wood / +5 xp" feedback from `notice` events.
Done when: gathering each node type works end-to-end with correct tool gating, depletion,
respawn, and inventory updates reflected in the UI.

## T8 — Combat: mobs, attacking, death

Depends: T4, T6. Build: render `state.mobs` (dummy/goblin/ogre) with idle/aggro states and
HP bars; click → `attack(id)`; show damage numbers, gold drops, and `state.tombstones` on
death. Handle local-player death (danger realms) + 4s respawn + tombstone loot pickup.
Done when: a full combat loop (engage → damage → kill → loot → xp/gold) works and deaths
drop/recover a tombstone correctly.

## T9 — Inventory, hotbar & bank UI

Depends: T2, T7. Build: a polished DOM/canvas UI for the 24-slot inventory, 6-slot hotbar,
and 48-slot bank. Drag-and-drop via `invMove(from,to)`, equip via `equip(slot)`, deposit/
withdraw via `bankDeposit/bankWithdraw` (bank opens on `bankOpen` near the bank tile). Item
icons, stack counts, tooltips, empty/full states. Done when: all inventory/hotbar/bank
operations round-trip to the server, with hover/active/focus states and keyboard support.

## T10 — Skills HUD + leveling feedback

Depends: T7, T8. Build: a skills panel (Woodcutting, Mining, Fishing, Cooking, Combat) with
live levels from peer state, an XP/level-up toast with FX, and a compact always-on HUD
(current HP, gold, active skill). Use the existing 1–99 curve. Done when: gaining XP shows
progress, hitting a new level fires a celebratory toast, and the HUD reflects live stats.

---

# Epic B: Building / UGC ("every coin is a buildable world")

## T11 — Server: authoritative placement

Depends: T3. Files: new `multiplayer/src/rooms/*` + `multiplayer/src/schemas/*`. Build:
add placement to the world (either extend `WalkRoom` or a dedicated `BuildRoom`): a
schema map of placed objects `{id, catalogId, x, y, z, rotY, scale, ownerId}`, with
`place`, `move`, `remove` messages. Server validates catalog id (allowlist), grid snap,
bounds, max-objects-per-world, and per-player rate limits. Broadcast deltas. Done when:
placements sync live across clients with full server-side validation and anti-grief limits.

## T12 — Server: per-coin world persistence of builds

Depends: T3, T11. Build: load placed objects on room create and debounce-save on change
via the T3 persistence service, keyed by coin mint. Snapshot/restore so a coin world's
build survives restarts and re-joins. Done when: building in a coin world, leaving, and
rejoining (or restarting the server) restores the exact build.

## T13 — Client: build mode + placement controls

Depends: T2 (or social scene), T11. Build: a build-mode toggle; a ghost/preview of the
selected object that snaps to the grid; place (`place`), rotate, scale, move (`move`),
delete (`remove`); undo/redo. Raycast to ground/surfaces. Touch + desktop. Done when:
a user can place, rotate, move, and delete objects with smooth previews and the changes
appear instantly for everyone in the world.

## T14 — Client: building palette UI

Depends: T13, T15. Build: a categorized, searchable palette of placeable props/blocks with
thumbnails, recent/favorites, and a count of remaining placements. Keyboard shortcuts to
cycle categories. Designed empty/loading states. Done when: selecting from the palette sets
the active object for T13's placement and the palette is fully navigable by mouse, touch, and keyboard.

## T15 — Prop/block asset catalog

Depends: none (can start early). Build: a curated catalog (`src/game/build-catalog.js` +
assets under `public/build/`) of optimized GLB props/blocks (nature, structures, furniture,
decor) with ids, categories, thumbnails, and collision/footprint metadata. Keep total
download lazy/paged. Done when: ≥40 catalog items load on demand with thumbnails, and the
catalog is the single source consumed by T11 (allowlist), T13, and T14.

## T16 — Build permissions + live collaboration

Depends: T11, T12. Build: a permission model — who may build in a given coin world (e.g.
coin holders above a threshold, an owner allowlist, or open) — enforced server-side and
reflected in the client (build button disabled with a reason if not permitted). Live
multi-user editing with per-object ownership and conflict handling. Done when: permissions
are enforced authoritatively, unauthorized users can't place, and two permitted users can
build together in real time without conflicts.

---

# Epic C: Proximity voice + spatial chat

## T17 — Voice room token API

Depends: none (needs LiveKit creds). Files: new `api/voice/*`, reference `agent-voice-chat/`.
Build: an endpoint that issues short-lived LiveKit access tokens scoped to a per-world room
(room id = coin mint / realm id), with identity = the player's session id and metadata for
display name. Server-side key handling (never expose the LiveKit secret). Rate-limited.
Done when: a client can request a token and join the correct world voice room; tokens
expire; secrets stay server-side.

## T18 — Client voice manager

Depends: T17, a live multiplayer scene (T2 or social). Build: `src/game/voice-net.js` — join
the world's LiveKit room, capture mic, publish/subscribe to peer audio, handle join/leave,
device errors, and permissions (mic prompt). Tie LiveKit participant identity to the
multiplayer player id so audio can be spatialized in T19. Done when: two users in the same
world can hear each other, with graceful handling of denied mic / no device.

## T19 — Spatial audio falloff

Depends: T18, T6 (player positions). Build: position each remote participant's audio in 3D
using avatar positions (WebAudio PannerNode or LiveKit spatial API): distance-based volume
falloff + stereo panning, updated each frame. Tunable max-distance. Done when: voices get
louder/quieter and pan as avatars move toward/away from each other.

## T20 — Voice UI

Depends: T18. Build: mute/unmute, push-to-talk, output volume, and per-speaker indicators
(a ring/pulse on the speaking avatar's nameplate + a roster of who's talking). Persist mute
preference. Done when: every voice control works with hover/active/focus states and speaking
indicators track actual audio activity.

---

# Epic D: On-chain creator economy

## T21 — Item/cosmetic data model + ownership ledger

Depends: T3. Files: `api/_lib/db.js` (migrations), new `api/economy/*`. Build: schemas for
sellable items (cosmetics, build packs, world passes) and an ownership ledger (wallet ↔
item, with mint/tx provenance). Indexed queries: "what does wallet X own?", "who owns world
pass for coin Y?". Done when: items and ownership are modeled, migrated, and queryable, with
a unit test covering grant/revoke/lookup.

## T22 — x402 purchase endpoints

Depends: T21. Files: new `api/x402/buy-item.js`, reference `api/x402/dance-tip.js` +
`src/club.js`. Build: x402-paid endpoints to purchase a cosmetic / build pack / world pass
in USDC; on settlement, write ownership (T21) and split payout to the creator's wallet.
Idempotent on tx; receipt feed. Done when: a real USDC purchase grants ownership and pays
the creator, verified on-chain, with no double-grant on retries.

## T23 — In-world marketplace UI

Depends: T21, T22. Build: a marketplace panel (browse by category, price in USDC, preview
3D item, buy via the x402 flow, "owned" badges). Designed loading/empty/error/sold-out
states. Done when: a user can browse, preview, and buy an item end-to-end and immediately
see it as owned.

## T24 — World access passes

Depends: T21, T22, T16. Build: gate entry to premium/holder coin worlds behind a pass
(free for holders, or purchasable); check ownership on world join (server-side), with a
clear paywall + buy flow on the client and a creator revenue split. Done when: a gated
world rejects non-pass-holders with a buy prompt and admits holders/buyers, and revenue
routes to the creator.

## T25 — Cosmetics equip pipeline

Depends: T21, Epic A or social avatars. Build: wire owned cosmetics into the avatar — the
`cosmetic` field already exists in `GamePlayer` (schema/game.js) but is unused. Equip/unequip
owned cosmetics (reuse `src/agent-accessories.js` accessory compositing), sync the equipped
look to peers, and reflect it in both the RPG scene and the social walkaround. Done when:
buying a cosmetic and equipping it changes the avatar for the owner and all nearby players.

---

## Notes for the orchestrator
- T15 and T17 have no internal deps — start them in Wave 0 alongside T1–T3 if you have agents free.
- Extract shared avatar helpers (`resolveAvatarUrl`, `buildAvatar`, `RemotePlayer`) into a
  shared module during T2 so the RPG scene, social scene, and cosmetics all reuse one path.
- Every agent: run `npm run dev`, exercise in a browser, run the **completionist** subagent on
  changed files, and confirm no console errors before reporting done (per CLAUDE.md).
- Push only on explicit approval, to BOTH remotes (`threeD` then `threews`).
</content>
</invoke>
