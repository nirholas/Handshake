# Port Checklist — bring `/walk` + `world.three.ws` systems into `/play`

> Companion to [W00-program-overview.md](W00-program-overview.md). This is the concrete,
> dependency-ordered work list for closing the gap between `/play` (the isometric Coin
> Communities plaza) and the two richer surfaces we already run: `/walk` (in-repo three.js +
> Rapier + Colyseus) and `world.three.ws` (hosted Hyperfy).
>
> **Reuse-first is mandatory.** Almost everything below already exists in the repo and is
> wired into `/walk` only — or is built but orphaned. The job is to *lift and wire*, not
> reinvent. Do not switch engines. Do not build a second world client.

---

## Ground truth (verified in-repo, 2026-06-11)

- `/play` = [src/game/coincommunities.js](../../../src/game/coincommunities.js) (2289 LOC).
  Renders a **flat `PlaneGeometry` plaza**, `WORLD_RADIUS = 58`
  ([coincommunities.js:59](../../../src/game/coincommunities.js#L59)), a **single fixed
  `PerspectiveCamera`** ([:413](../../../src/game/coincommunities.js#L413)), and **zero
  physics** (`grep` for `rapier|PhysicsWorld` → 0 hits).
- `/walk` = [src/walk.js](../../../src/walk.js) (3696 LOC). Has Rapier physics, heightfield
  terrain, a 4-mode camera system, friends/presence, and AR.
- **Both `/play` and `/walk` already join the SAME authoritative room** — `walk_world`
  (`WalkRoom`). `/play` via [community-net.js](../../../src/game/community-net.js), `/walk`
  via [walk-net.js](../../../src/walk-net.js). **Multiplayer is NOT a gap** — the netcode is
  shared. Every item below is a **client-side render/physics/UX** port.
- The server already carries vehicle constants (`VEHICLE_WORLD_RADIUS_M`, max-step, max-speed)
  in [WalkRoom.js](../../../multiplayer/src/rooms/WalkRoom.js) — driving is partly server-ready.

### Already-in-repo assets to lift (do not rewrite)

> **Re-verified 2026-07-10.** The table below was accurate at the 2026-06-11 ground-truth
> pass but drifted as later sessions shipped Phase 1/2 and quietly wired the three
> "orphaned" modules without updating this row. Trust `grep`, not this table, when in doubt
> — that drift is exactly what sent an earlier session in this program down a dead-end
> re-research path before it re-verified importers directly.

| System | File | Status today |
|---|---|---|
| Rapier wrapper + kinematic character controller | [src/physics/physics-world.js](../../../src/physics/physics-world.js) | **wired into `/play`** (Phase 1, `_initPhysics()` in `coincommunities.js`) |
| Heightfield terrain (shared mesh + collider source) | [src/game/terrain.js](../../../src/game/terrain.js) | **superseded in `/play`** by the district's static-box colliders (see Phase 1 note) — `/walk` still uses the heightfield directly |
| 4-mode camera (follow/cinematic/firstperson/topdown) | [src/walk.js:466-520](../../../src/walk.js#L466-L520) | **wired into `/play`** (`_camModes`, `C` cycles) — still inline in both files, never extracted to a shared module |
| Friends / presence panel | [src/game/friends-panel.js](../../../src/game/friends-panel.js) | **wired into `/play`** 2026-07-10 (P4.2 — see below) + `/walk` + `friends.js` |
| Client vehicle manager (Rapier raycast vehicle) | [src/game/vehicles.js](../../../src/game/vehicles.js) | **wired into `/play`** (Phase 2, `VehicleManager` import in `coincommunities.js`) |
| Day/night cycle | [src/game/day-night.js](../../../src/game/day-night.js) | **wired into `/play`** (imported by `src/agent-screen-world.js`, driven by `src/shared/world-clock.js`) |
| Activities/minigame loop | [src/game/play-activities.js](../../../src/game/play-activities.js) | **wired into `/play`** (P4.1 — `PlayActivities` constructed, ticked, disposed in `coincommunities.js`; F-key chop/mine/cook/pickupRod) |
| Generic world persistence (Postgres index + R2 blob) | [api/world/[action].js](../../../api/world/[action].js), `api/_lib/world-store.js` | live API, **`/play` still doesn't use it** — real gap, see P3.1 |

---

## Phase 1 — Physical world foundation (unblocks the most; do first) — SHIPPED 2026-07-08

Maps to **W01**. Goal: `/play` stops being a flat clamped disc and becomes a real 3D space
with gravity, collision, a drivable district, and a free camera. Pure lift from `/walk`.

- [x] **P1.1 — Mount `PhysicsWorld` in `coincommunities.js`.** Done, with one adaptation: by
  the time this landed, `district.js` + `world-zones.js` already existed (built in an earlier
  session, tagged "W01" in their own headers, but never wired in) as the intended drivable-city
  answer for this brief — so physics mounts a flat `addGround()` + the district's building
  colliders (`addStaticBox` per `district.colliders`) rather than a second heightfield. Rapier
  boots once in the constructor (`_initPhysics()`, memoized like `/walk`'s `initRapier()`), the
  kinematic character controller persists across coin switches, `_stepLocal` feeds it
  camera-relative displacement + integrated gravity every frame, and `physics.step(dt)` runs
  right after in `_loop()` (move-before-step, per physics-world.js's contract). Falls back to
  the old direct-mutation path until Rapier's WASM resolves.
- [x] **P1.2 — Real ground collision for the plaza+district.** Superseded by the district
  answer above: `terrain.js`'s rolling-hill heightfield is still `/walk`'s ground (unchanged);
  `/play`'s Downtown plaza + district streets are flat by design (asphalt/sidewalks), so a flat
  `addGround()` matches the rendered geometry exactly instead of fighting it with hills.
- [x] **P1.3 — Raise/replace the 58 m clamp.** Movement now clamps to the square
  `WORLD_BOUND`/`DISTRICT` from [world-zones.js](../../../src/game/world-zones.js)
  (`clampToBounds`, half=200) instead of the old `WORLD_RADIUS` disc (58, kept only as the
  Downtown plaza's *visual* radius for dressing/build-placement/NPC-roam, unrelated to movement
  now). This already matches `WalkRoom`'s own `WORLD_HALF_M`/`WORLD_BOUND_M` server clamp
  one-for-one — no server change needed.
- [x] **P1.4 — Extract the camera-mode system into a shared module.** Done as
  [src/game/camera-modes.js](../../../src/game/camera-modes.js): `CAMERA_MODES`,
  `CAMERA_MODE_LABELS`, `CAMERA_MODE_FOV`, the pure `computeCameraForMode()` math, and a
  `createCameraModeController()` stateful wrapper (cycling, localStorage persistence, cross-fade
  transition). Fully wired into `coincommunities.js` (press **C** to cycle; 'follow' reproduces
  the original fixed orbit exactly). `walk.js` was intentionally left on its own inline
  controller wiring (haptics/session-save/DOM-indicator are walk-specific) — a follow-up can
  point it at the shared constants/math if it's worth the risk on that much larger file.
- [x] **P1.5 — Wire the orphaned day/night cycle.** `createDayNightCycle(env, district)` now
  runs every frame in `_tickEnv`, driven by the same deterministic `worldClock(Date.now())`
  used by `/agent-screen`'s ambient stage — zero network sync, every client agrees on the sky.
  `district.setNight(k)` brings up building windows + streetlamps at dusk for free (the hook
  was already built into `day-night.js`, just never called).

**Phase 1 done when:** an avatar in `/play` is stopped by real colliders (not a disc clamp) —
verified end-to-end against a local Colyseus room: a district building blocks a straight-line
walk a few metres short of its wall — can switch all four camera modes (verified via keyboard +
screenshot), the world has a day/night sky driving real light/fog values, and every client in a
`?coin=` world computes the identical district + sky from the same seed/clock. Real Rapier +
real district + real day/night — no mocks. Next: **W02** (vehicles) can now assume a live
`PhysicsWorld` + character controller + district colliders to enter/exit a car against.

---

## Phase 2 — Vehicles & driving — SHIPPED 2026-07-08

Maps to **W02**. Depends on Phase 1 (needs the Rapier world + terrain colliders).

- [x] **P2.1 — Wire the orphaned client `VehicleManager`.**
  [src/game/vehicles.js](../../../src/game/vehicles.js) is imported and instantiated in
  `coincommunities.js` (`this.vehicles = new VehicleManager({ host: this })`); it spawns the
  server-seeded fleet (`VEHICLE_SPAWNS` in `multiplayer/src/vehicles.js` — 6 cars across 4 types:
  coupe/sedan/pickup/buggy) and gates enter/exit on `VEHICLE_ENTER_RANGE_M` proximity, contextual
  **F** to take the wheel / tap-to-enter on touch.
- [x] **P2.2 — Network vehicle state through `WalkRoom`.** `WalkRoom.js` seeds the fleet
  (`_seedVehicles`), handles `venter`/`vexit`/`vsync` (rate-limited via the same `_actionOk` gate
  every other handler uses, teleport/speed-hack clamped in `_applyVehicleTransform`), and the
  `Vehicle` schema (`multiplayer/src/schemas.js`) auto-replicates to every `/play` client via
  `CommunityNet` (`vehicleAdd`/`vehicleChange`/`vehicleRemove`/`vehicle` ack events). Remote
  vehicles render + interpolate via [src/game/vehicle-mesh.js](../../../src/game/vehicle-mesh.js).
- [x] **P2.3 — Driving camera + HUD.** The follow camera (P1.4's camera-modes module) hands off
  to a chase view on entry (`camDist` pulled out to 11m+) and re-centers behind the car's heading
  each frame; a dedicated speedometer + Exit button + touch pedal/steering cluster
  (`.veh-hud`/`.veh-speedo` in `vehicles.js`) shows live km/h and brake-light state. This is a
  self-contained overlay rather than a merge into `WorldHudSystem`
  ([src/game/hud/world-hud.js](../../../src/game/hud/world-hud.js)) — functionally complete, but
  folding it into that shared system remains a legitimate follow-up if the HUD grows more panels.

**Real bug found + fixed during verification:** the raycast vehicle controller
(`createVehicle` in [src/physics/physics-world.js](../../../src/physics/physics-world.js)) was
correct, but 3 of the 4 vehicle types' `suspension.rest` values in
[multiplayer/src/vehicles.js](../../../multiplayer/src/vehicles.js) left too little clearance
between the chassis collider and the wheel-contact line for their chassis height — the hull
itself rested on/against the ground and its own friction pinned the car almost dead still
regardless of engine force (sedan and pickup: ~0.00 m/s after 3s of full throttle even at 10x
their spec'd engine force; coupe: crawled at 0.6 m/s). Root-caused with a standalone real-Rapier
repro (no browser, no game loop — immune to frame-rate starvation) at
[scripts/tmp-verify-w02-physics-core.mjs](../../../scripts/tmp-verify-w02-physics-core.mjs).
Fixed by raising `suspension.rest` (coupe 0.32→0.4, sedan 0.36→0.5, pickup 0.42→0.6; buggy was
already fine at 0.46) — all four types now accelerate, steer, and are stopped by real wall
collision correctly.

**Phase 2 done when:** a player walks up to a car, presses to enter, drives it across terrain
with collision, a second browser sees the car move smoothly, and exit returns to on-foot. —
**Verified for real, twice:**
1. A standalone real-Rapier physics repro (no browser/network — immune to shared-box CPU
   contention): [scripts/tmp-verify-w02-physics-core.mjs](../../../scripts/tmp-verify-w02-physics-core.mjs)
   — real acceleration on open ground, a real wall stopping the car (not tunnelling, not a
   bounds-clamp teleport), real steering-induced lateral displacement, and the handbrake
   arresting speed. All passing against the production `createVehicle`/`vehicleSpec` code.
2. A full two-Chromium-context Playwright run against a live Vite dev server + a freshly-started
   Colyseus `WalkRoom` (no mocked physics, no mocked network):
   [scripts/tmp-verify-w02-vehicles.mjs](../../../scripts/tmp-verify-w02-vehicles.mjs) — Player A
   joins, Rapier boots, the 6-vehicle fleet syncs, A walks to a parked car under real on-foot
   Rapier movement, presses F, the server grants the seat, the driving HUD appears, Player B's
   independent client sees the `driver` field flip to A's sessionId and sees the car's replicated
   mesh actually move in lock-step with A's throttle input, A exits, and B sees it parked again —
   zero console errors/warnings on either client. (Environment note: this shared box runs many
   concurrent agent build/dev/test processes — load average routinely exceeds its core count —
   which starves headless Chromium's frame rate; the script's wall-clock timeouts were widened
   accordingly. This affects wall-clock budget only, not the pass/fail physics or networking
   assertions.)

---

## W04 — Economy & money — SHIPPED 2026-07-08

Maps to [W04-economy-and-money.md](W04-economy-and-money.md) (brief written alongside this
change — the file didn't exist yet when this work started). Independent of Phases 1–2 above
(no vehicle/physics dependency) — cash, a bank/ATM, general-store vendors, and the `$THREE`
boutique bridge.

- [x] **General store.** `WalkRoom` now handles `storeReq`/`storeBuy`/`storeSell` against the
  already-built price tables in `multiplayer/src/shop.js` (found labeled "(W04)" but never
  wired). A "General Store" NPC sits at each `vendor` spawn point `world-zones.js` had reserved;
  walk up, press E, buy tools/consumables with cash or sell gathered goods — every trade priced
  and validated server-side, never a client-supplied number.
- [x] **Bank/ATM.** `WalkRoom` now handles `bank` (deposit/withdraw), calling `economy.js`'s
  already-built `bankTransfer()` (found with a `// W04 extends` comment, never called from
  anywhere). A "Bank Teller" NPC sits at a new `atm` spawn point on the Downtown plaza. Banked
  cash survives a death drop — the risk/reward point of using it.
- [x] **`$THREE` bridge (the boutique).** Premium in-game cosmetics
  (`multiplayer/src/cosmetics-catalog.js`) unlock via a real on-chain `$THREE` payment: the
  player's connected Solana wallet signs one transaction
  (`multiplayer/src/game-token.js#buildTokenPurchase`, found in a section literally headed
  "generic fixed-amount purchases (W04 $THREE boutique)" and never called), split between the
  holder-rewards pool and the treasury; the server re-reads the **confirmed** transaction from
  RPC (`verifyTokenPurchase`) before granting anything. Wired into the wardrobe panel's
  previously-inert "Locked" cards (`play-systems.js`) rather than a new NPC — a shop for what
  you're already wearing.
- [x] **Evaluated and deliberately not reused:** the separate R21–25 avatar-shop/x402 rail
  (`api/_lib/cosmetics.js` / `cosmetics-economy.js` / `api/x402/cosmetic-purchase.js`) sells a
  different catalog in USDC for a standalone character-creator surface — see the brief's "Ground
  truth" section for why building a second on-chain path on top of it would have been the
  parallel payment stack the program overview warns against.

**Done when:** a player walks to the general store, buys and sells for real cash (server-echoed
purse), walks to the ATM, deposits/withdraws (server-echoed bank balance), and can spend a real,
on-chain `$THREE` payment on a premium cosmetic that appears equipped moments later. Verified
end to end — real Rapier-driven walk-up, a real freshly-started `WalkRoom`, real server-side
cash mutations, and a real devnet Solana settlement (mint, airdrop, sign, broadcast, RPC
re-verify) for the on-chain leg; see the brief for the exact verification runs.

---

## W03 — Character & avatar customization — SHIPPED 2026-07-08

Maps to **W03** (avatar creator + selfie→3D + wardrobe). No dependency on W01/W02. Unlike
W01/W02, no `Wxx` brief file existed yet when this pass started — the program README/W00
referenced `W03-character-avatar-customization.md` but it was never written. Filed as
[W03-character-avatar-customization.md](W03-character-avatar-customization.md) as part of this
pass, documenting the (extensive) reused infra below plus what was actually added.

**Ground truth found (most of this brief already existed and was already wired into `/play`):**
the lobby's full **Create your avatar** flow (design-from-scratch/selfie via `AvatarCreator` +
the real Avaturn selfie→3D SDK, `.glb` upload, or the full Avatar Studio sculptor — see
`src/game/coincommunities-ui.js` `_openCreate()`), a real x402-settled **cosmetics shop**
(`cosmetics-shop.js` → `/api/cosmetics/catalog` → `/api/x402/cosmetic-purchase`), and a real
server-authoritative **wardrobe/equip** system (`cosmetics-wardrobe.js` →
`WalkRoom` `equip-cosmetic` → persisted profile) were all already shipped, all real (no
mocks), and already reachable from the HUD.

**Real gap found and closed:** cosmetics customization existed only behind a HUD menu button —
no physical presence in the world, unlike every other economy interaction in `/play` (which is
NPC-fronted).

- [x] **Boutique NPCs.** `src/game/npc/npc-catalog.js` now seats **Roux · Tailor**
  (`boutique-se`, opens the Shop) and **Nell · Fitting Room** (`boutique-nw`, opens the
  Wardrobe) via `spawnsOfType('boutique')` — no hardcoded duplicate coordinates. `world-zones.js`
  had already reserved the original `vendor-ne`/`vendor-sw` stalls for this kind of thing
  ("consumed by economy/shop briefs"), but the concurrent W04 pass claimed those two for its
  general-store clerks — resolved by giving the boutique its own `type: 'boutique'` pair,
  mirrored onto the plaza's other diagonal (`(44,44)`/`(-44,-44)`) so nothing stands on top of
  anything else. Both NPCs use the same data-driven `Npc`/`WorldLife` engine every other
  townsperson uses (proximity prompt, press E, `onInteract`) — zero new wiring beyond the
  catalog entries.
- [x] **`world.openShop`/`world.openWardrobe` callbacks.** `coincommunities.js` passes these
  into the `WorldLife` `world` config (bound to the existing `_toggleShop()`/`_toggleWardrobe()`
  methods the HUD buttons already call), so the boutique NPCs and the HUD open the identical
  real panels — one system, two entry points.
- [x] **Docs.** [docs/character-studio.md](../../../docs/character-studio.md) gained a
  "Character customization in `/play` (World Online)" section mapping the full flow (lobby
  creation → shop → wardrobe → boutique NPCs) for a reader with zero prior context — this area
  had no `/play`-specific documentation before.

**Gaps identified but intentionally NOT closed this pass (documented, not silently dropped):**
- Premium cosmetics remain USDC-only on this rail, deliberately separate from the in-world cash
  economy and from W04's own on-chain `$THREE` boutique bridge (see the W04 entry above) — three
  distinct currencies already exist by design; unifying them is a product decision above this
  brief's scope, not an oversight.
- Deep body/face/hair sliders (Avatar Studio) are reachable only via "Advanced studio" in a new
  tab, not embedded in the `/play` canvas — a deliberate choice (a heavy sculpting iframe
  competing with the game's WebGL canvas for GPU/CPU is a worse experience than a tab hop), not
  an oversight. Revisit only if there's a concrete UX complaint.
- The lobby's selfie flow (Avaturn SDK, fast/stylized/game-ready) is intentionally lighter than
  the standalone `/create/selfie` pipeline (photorealistic, 3-shot guided capture) — different
  products for different needs (fast in-game vs. photorealistic showcase), not a regression.

**W03 done when:** a new player can design or scan an avatar into `/play` with zero sign-in
friction, and once in the world can walk up to a physical storefront (not just a menu) to
browse and equip real, server-persisted cosmetics. **Verified for real** against a local Vite
dev server + a freshly-started Colyseus `WalkRoom` (no mocked physics, no mocked catalog, no
mocked SDK) with Playwright:
[scripts/tmp-verify-w03-boutique.mjs](../../../scripts/tmp-verify-w03-boutique.mjs) — the lobby's
"Design your avatar" card opens `AvatarCreator`, which fires a real network request to
`avaturn.*` (the SDK is genuinely wired, not a stub); the player joins the `$THREE` world over a
real Colyseus session; both boutique NPCs are present in `worldLife.npcs`; real on-foot
Rapier-driven movement (camera-relative WASD, ~62 m) reaches Roux · Tailor, the "E · Browse the
wardrobe" prompt appears, pressing E opens the real `CosmeticsShop` panel rendering real catalog
cards fetched from `/api/cosmetics/catalog`; the Fitting Room leg confirms Nell opens the real
`CosmeticsWardrobe` panel via the identical `onInteract` → `world.openWardrobe()` path — zero
unexpected console errors/warnings.

## W07 — Combat & weapons — SHIPPED 2026-07-08

Maps to [W07-combat-and-weapons.md](W07-combat-and-weapons.md). Depends on W01 (physics,
district bounds). Independent of W02–W06.

- [x] **Mob AI + PvE.** `multiplayer/src/combat-handlers.js` (new) seeds a difficulty
  gradient of roaming mobs into the three named `DANGER_ZONES` and ticks their AI every
  200ms — idle, chase, or swing at the nearest live player, clamped so a chase never
  leaves its home zone (the town stays lawful by construction). Killing one grants
  XP/gold and spills a lootable tombstone.
- [x] **`attack`/`loot` intents wired into `WalkRoom`.** Both were fully designed
  (`combat.js`, `items.js` WEAPONS/MOB_STATS/LOOT_TABLES, `world-features.js`
  DANGER_ZONES) and completely unreachable — `grep` for the combat helpers in
  `WalkRoom.js` hit only the import line. `registerCombatHandlers`/`seedMobs`/
  `tickMobs`/`tickHeat` now wire it in, mirroring `activities.js`'s split exactly.
- [x] **Safe/danger zone gating, for real.** Attacking is rejected server-side outside a
  `DANGER_ZONES` circle — not just visually signposted.
- [x] **Wanted/heat meter.** PvP raises the attacker's heat (`combat.addHeat`), decaying
  faster in town; the public star count rides on `Player.heat` (already in schemas.js,
  never populated before this).
- [x] **Death, tombstones, respawn.** A kill (mob or player) calls `killPlayer`:
  `dropCarried` spills a tombstone, `player.dead=true` flags the downed state on the
  shared schema (a `move` from a dead player is now rejected server-side — a real bug
  found while wiring this in), and a 5.5s timer respawns at `SPAWN_POINT` via
  `reviveProfile`.
- [x] **Client vitals HUD.** `src/game/hud/world-hud.js` — fully built, dormant, never
  imported — is now mounted by the new `src/game/combat-system.js`, feeding
  `setHealth`/`setArmor`/`setWanted` (this brief) and `setCash`/`setBanked`/minimap
  viewer (closing the same dormant-HUD gap for W04's money readout as a side effect).
- [x] **Mob rendering reuses W08's already-built (but dormant) `MobSystem`.** `src/game/npc/mobs.js`
  was already written against a `window.twsCombat` contract ("when W07 ships, mobs light
  up with zero changes here" — confirmed true). Rather than ship a second, competing mob
  renderer, `combat-system.js` **is** that contract: it installs `window.twsCombat` before
  `WorldLife` constructs `MobSystem` and feeds it this module's own per-frame-interpolated,
  server-authoritative positions. `MOB_TINT` in `mobs.js` gained the real W07 kinds
  (goblin/ogre/troll/dummy) alongside its original placeholders.
- [x] **Tombstones, danger-zone ground, hit feedback, death overlay, wanted nameplate
  badge.** All new in `combat-system.js` + a small `RemotePlayer` extension in
  `coincommunities.js` (a downed peer tilts flat and dims — an honest static pose, not a
  fabricated ragdoll; a wanted peer's nameplate carries a star badge).

**Real gap found and closed in passing:** `src/game/items.js` (client display/glyph
registry) was missing `bat`/`pistol`/`bow`/`ammo`/`arrow`/`vest` — the server already had
icons for all of them; the client would have rendered a bare first-letter fallback.

**Phase done when:** a player equips a weapon, walks into a named danger zone (attacking
is rejected outside one), kills a PvE mob and loots its tombstone, damages a second
player (raising wanted heat, visible on both the HUD and the victim's nameplate), and a
kill drops the victim's carried valuables + auto-respawns them in town at full health —
all real Rapier-driven movement, a real freshly-started `WalkRoom`, zero mocked combat
math. Verified end-to-end with two independent Chromium contexts against a live server:
[scripts/tmp-verify-w07-combat.mjs](../../../scripts/tmp-verify-w07-combat.mjs).

---

---

## Phase 3 — Persistent, buildable world (the Hyperfy parity items)

Maps to **W01 persistence + Hyperfy's build/upload/persistence model**. These are the things
`world.three.ws` has that neither `/play` nor `/walk` fully has yet.

- [ ] **P3.1 — Persist the coin-world build through the existing world store.** `/play` already
  has limited prop building (`WorldObjects`/`PropGhost`, capped to 12 m). Route saves/loads
  through the live [api/world/[action].js](../../../api/world/[action].js) +
  `api/_lib/world-store.js` (Postgres index + R2 blob, optimistic-concurrency etags), keyed by
  coin mint as `worldId`. This is the Hyperfy "save every 30s" pattern, already half-built here.
- [ ] **P3.2 — Lift the build-radius cap.** With persistence + permissions
  (`world-store.canWriteWorld`), expand beyond the 12 m `clearMaxRadius`
  ([coincommunities.js:298](../../../src/game/coincommunities.js#L298)) so holders can build a
  real place, governed by the per-world permission model rather than a hard cap.
- [ ] **P3.3 — Player asset uploads (GLB).** Hyperfy lets players upload GLB/VRM. We already
  have [src/game/avatar-upload.js](../../../src/game/avatar-upload.js) and an R2 pipeline —
  extend it to world props, size-limited like Hyperfy's `PUBLIC_MAX_UPLOAD_SIZE`. Validate and
  sanitize server-side before serving.
- [ ] **P3.4 — (stretch) VRM avatar support.** Hyperfy is VRM-native; we're GLB-native. Evaluate
  adding a VRM loader path alongside GLB in the avatar pipeline. Lower priority — only if a
  clear holder demand exists. Do **not** block Phases 1–2 on it.

**Phase 3 done when:** a holder builds in their coin world, reloads the page, and the build is
still there; a second visitor sees the same persisted build; permissions stop non-owners from
overwriting it.

---

## Phase 4 — Living-world & social parity

Maps to **W08/W09**. `/play` already has NPCs (`WorldLife`), voice, cosmetics — these add the
`/walk` social surface and the orphaned activities loop.

- [x] **P4.1 — Wire the orphaned activities/minigame loop.** SHIPPED (undated — found already
  complete 2026-07-10). `PlayActivities` is constructed/ticked/disposed in `coincommunities.js`
  and bound to the `F` key (chop/mine/cook/pickupRod), sharing the vehicle-interact/fish
  priority chain.
- [x] **P4.2 — Port the friends/presence panel.** SHIPPED 2026-07-10. `FriendsPanel` mounts in a
  right-docked drawer (`_openFriends`/`_closeFriends` in `coincommunities.js`), toggled by the
  `J` hotkey or the HUD `Friends` button (unread badge, `aria-expanded`), closed with `Esc`.
  The real gap this closed: `community-net.js` never carried a signed presence ticket into the
  `walk_world` join and never forwarded the server's `social` message — so every `/play` player
  showed **Offline** to their friends and live DMs were silently dropped, even though the panel
  itself and the server-side `socialHub` registration were both already built. Fixed at the net
  layer (`getPresence` option + `social` → `_emit`), not just the UI. See
  `tests/play-friends-presence.test.js` for the regression coverage.
- [x] **P4.3 — Minimap.** SHIPPED (undated — found already complete 2026-07-10).
  `WorldHudSystem` (`src/game/hud/world-hud.js`) owns a rotating `Minimap`
  (`src/game/hud/minimap.js`) with compass + live blips, range widening while driving.

---

## Cross-cutting rules (from CLAUDE.md — apply to every item)

- **No mocks, no stubs, no TODOs, no fake loading.** Real Rapier, real terrain, real
  `walk_world` netcode, real R2/Postgres persistence.
- **$THREE is the only coin.** Worlds are keyed by arbitrary user-supplied mints at runtime
  (the generic plumbing exception) — never hardcode or surface any non-`$THREE` mint.
- **Every state designed:** loading skeleton, empty world, physics-init failure, asset-upload
  rejection, save conflict (409 etag) — all handled and actionable.
- **Definition of done per item:** `npm run dev`, exercise in a real browser at 320/768/1440,
  zero console errors, Network tab shows real `walk_world` + `api/world` traffic, `npm test`
  green, `git diff` self-reviewed.
- **Changelog:** each phase that ships a user-visible change gets a `data/changelog.json` entry
  (tags: `feature`/`improvement`), per CLAUDE.md.

## Suggested order

`P1.1 → P1.2 → P1.3 → P1.4 → P1.5` (foundation) → `P2.x` (vehicles) → `P3.1 → P3.2 → P3.3`
(persistence/build) → `P4.x` (social). All of Phase 1, 2, and 4 are now shipped (see the
checkboxes above) — **Phase 3 (persistence/build parity) is the only remaining phase** and the
next place to pick up this program.
