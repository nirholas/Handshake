# W00 — World Online: program overview & shared architecture (READ FIRST)

> Every agent picking up a `Wxx` brief in this folder MUST read this file first. It is the
> shared context the individual briefs assume. Do not re-decide the stack, the coin rules,
> or the networking pattern — they are settled here.

---

## North Star

Turn `/play` from a charming 60-meter plaza into a **GTA Online–class, high-quality 3D
multiplayer world**: a persistent, drivable open world with a real in-game economy, jobs &
missions, activities/minigames, combat, deep avatar customization, and living NPCs — all
wallet-native to `$THREE`.

**Explicitly NOT isometric.** Kintara (kintara.gg) is the *feature* reference for the
economy/quest/loop ideas, but the *fidelity* bar is GTA Online / high-end third-person 3D.
We render full 3D avatars, third-person camera, real physics, real vehicles.

The quality bar from `CLAUDE.md` stands: ship complete, polished, real-data features that a
room of senior engineers would respect. No mocks, no stubs, no TODOs, no fake loading.

---

## Two existing assets you MUST mine before writing anything

1. **`world.three.ws`** — our own already-built, nicely-polished 3D world framework (hosted
   on Google Cloud). It is the single richest source of proven patterns we have. Before
   building any `Wxx` feature, **open `world.three.ws`, exercise the relevant system, read
   its client code (view-source / network tab / its served JS bundles), and PORT what
   already works** instead of reinventing it. If a system there is better than what `/play`
   has, lift it. Treat it as a first-class dependency, not inspiration.

2. **The in-repo `/play` + `/walk` foundation** — we already run the exact stack a
   GTA-style world needs, in production:
   - **Rendering:** three.js (GLTF/GLB avatars, instanced voxels, world env/biomes).
   - **Physics:** Rapier (`@dimforge/rapier3d`) — `/walk` already has a reusable
     `PhysicsWorld` + kinematic character controller + heightfield (see memory
     `walk-physics-rapier`). This is the base for character collision AND vehicles.
   - **Multiplayer:** Colyseus — `multiplayer/src/rooms/WalkRoom.js` is an authoritative
     room with per-coin world instances, movement validation, chat, emotes, voice (WebRTC),
     and an **off-schema economy** (fishing, inventory, XP). This is the spine everything
     networked hangs off.

**Reuse-first is a hard rule for this program.** We do not switch engines and we do not
build a second world client. We extend three.js + Rapier + Colyseus + the WalkRoom, and we
port from `world.three.ws`.

---

## Approved package allowlist (don't reinvent these)

Use these; do not hand-roll equivalents. Adding anything outside this list requires a one-line
justification in your brief's PR.

| Need | Package / repo | Notes |
|------|----------------|-------|
| Rendering | `three` | Already the foundation. |
| Physics (chars, vehicles, props) | `@dimforge/rapier3d` | Already in `/walk`. Has a built-in **raycast vehicle controller** — that is our driving model. |
| Authoritative multiplayer | `colyseus` / `@colyseus/schema` | Already in `multiplayer/`. Extend WalkRoom or add sibling rooms. |
| Fast world collision / raycast | `three-mesh-bvh` | For large static world meshes (streets, buildings). |
| NPC navigation | `three-pathfinding` (donmccurdy) | Navmesh for pedestrians, traffic, quest NPCs, mob AI. |
| Customizable full-body avatars | A third-party full-body avatar SDK + our existing GLB/VRM pipeline + `/scan` selfie→3D | We already load GLB/VRM and have a selfie→3D pipeline (memory `scan-to-3d-pipeline`). The SDK adds a wardrobe. |
| Character animation | three.js `AnimationMixer` + Mixamo clips (already wired in `avatar-rig.js`) | Reuse the emote/anim manifest system. |
| Reference architecture (vehicles + ECS netcode) | [iErcann/Notblox](https://github.com/iErcann/Notblox) | three.js + Node + Rapier + ECS, cars/city/players, GTA/Roblox-like. **Read it for patterns; do not fork wholesale.** |

We deliberately do NOT adopt a different engine (PlayCanvas, Babylon, Needle, Hyperfy, etc.).
We already have a working three.js+Rapier+Colyseus world; switching engines would be exactly
the wheel-reinvention the user asked us to avoid.

---

## The networking pattern every gameplay feature follows (off-schema economy)

This is how `/play` already does fishing/inventory/XP, and how EVERY new server-authoritative
mechanic in this program must be built. Do not invent a second pattern.

- **Synced world state** (positions, blocks, who's present) lives in the Colyseus
  `WalkState` schema and auto-replicates to all clients.
- **Private/per-player state** (inventory, cash, XP, quests, vehicle ownership) lives
  **off-schema** in server-side `Map`s on the room (`this.econ`, etc.), persisted per-account
  (wallet when the gate is on, else guest id). Peers never see it.
- **Flow:** client sends an intent message (`this.net.send('mine')`) → server handler
  validates (tool/range/cooldown/space) → rolls authoritatively → mutates off-schema state →
  replies to that one client with targeted `notice` / `inv` / `xpgain` / `levelup` messages →
  client renders toast + HUD. **The client is pure UI; the server is the authority.**
- **Template to copy:** `multiplayer/src/rooms/WalkRoom.js` `_handleFish` (the canonical
  example) + `multiplayer/src/economy.js` + `multiplayer/src/items.js` +
  `multiplayer/src/world-features.js`, and the client side in `src/game/play-systems.js`.

Each brief that adds a mechanic must: add world feature(s)/spawn data, add the server
message handler(s), add item/data tables, add client UI + 3D feedback, and persist.

**Anti-cheat baseline:** never trust a client-sent position, balance, hit, or reward. Validate
range, cooldown, ownership, and inventory space server-side every time. Rate-limit every new
message type like the existing handlers do.

---

## The world structure we're building on

- One **mainland** + one isolated world instance **per `$THREE`/coin community** (and a
  gated **Holders** tier per coin). Keep this model. "Districts" within a world are zones,
  not new Colyseus rooms, unless a brief says otherwise.
- The flagship `$THREE` town is the showcase world — land new flagship features there first
  (e.g. the Agent Exchange NPCs already live only there).
- Builds persist per-world via `blockStore` (Redis/memory). Any new persistent world state
  (vehicles parked, properties owned, quest progress) follows the same per-world/per-account
  persistence discipline.

---

## Coin rule — absolute (from CLAUDE.md)

**`$THREE` is the ONLY coin. CA `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`.** Never name,
add, or reference any other token anywhere — not even ones we've launched. In-game spendable
currency is **"cash"/"gold"** (a game resource, not a token) — that's fine and encouraged. The
only on-chain token that may ever appear is `$THREE`. Test/fixture mints use `$THREE` or an
obviously-synthetic placeholder.

---

## Definition of done (applies to every brief)

Inherit the full `CLAUDE.md` "Definition of done" + "Self-review protocol". In addition:

- Dev server run, feature exercised in a real browser, **no console errors/warnings**.
- Server-authoritative: cheating the mechanic from the client console fails.
- Every new networked action is rate-limited and validated server-side.
- Reuses `world.three.ws` patterns and the existing off-schema architecture — reviewer can
  see what was ported vs newly written, and why anything new was necessary.
- Loading/empty/error/populated states all designed; mobile (touch/joystick) works.
- Run the **completionist** subagent over changed files; fix everything it flags.
- Do not push unless the user asks; when they do, `git push threews main` — the only push
  target per CLAUDE.md. Never push/pull/fetch/merge `threeD` (retired mirror, diverged history).

---

## Brief index & dependency order

Build roughly in this order; later briefs assume earlier foundations.

| Brief | Feature | Depends on |
|-------|---------|------------|
| **W01** | Open-world foundation (drivable streamed world, physics, day/night) | — |
| **W02** | Vehicles & driving (Rapier raycast vehicle, enter/exit, networked) | W01 |
| **W03** | Character & avatar customization (avatar creator + selfie→3D + wardrobe) | — |
| **W04** | Economy & money (cash, bank/ATM, sell/buy vendors, `$THREE` sink/faucet) | — |
| **W05** | Jobs, missions & heists (data-driven quest engine, solo + co-op) | W04 |
| **W06** | Activities & minigames (gather/craft loop, races, arcade) | W04 (W02 for races) |
| **W07** | Combat & weapons (server-authoritative, health/armor, wanted, safe zones) | W01 |
| **W08** | NPCs & world life (vendors, traffic, pedestrians, quest-givers, mob AI) | W01 |
| **W09** | Social & crews (crews, friend instances, profiles, minimap/waypoints) | — |
| **W10** | HUD, interaction menu & game-feel polish (GTA-style HUD, cameras) | W01 |

Each `Wxx` file is self-contained enough for one agent to own end-to-end, but all share this
overview. When in doubt, re-read this file.
