# Task 01 — Multi-realm support & portal traversal

## Context

The game server only ever runs one map. `multiplayer/src/rooms/GameRoom.js`
hardcodes `const MAINLAND = REALMS.mainland` and binds all geometry helpers to
it. `multiplayer/src/index.js` registers a single room `game_mainland`. Yet
`multiplayer/src/rooms/realms.js` already fully defines four realms — `mainland`,
`wilderness`, `whisperwood`, `pond` — each with `spawn`, `safe`/`pvp`/`danger`
flags, `blocked`, `bankZone`, `fountain`, `nodes`, `mobs`, `fishing`, `cooking`,
`safeCamp`, and `portals` with `{x0,y0,x1,y1,to,toTx,toTy}` destinations. There is
a `portalAt(realm, tx, ty)` helper and a `realmLayout(realm)` serializer, but
**nothing calls them** and players can never leave Mainland.

Note: `GameRoom.onJoin` hand-builds the `realm` client message and omits
`fishing`, `cooking`, `safeCamp`, and `portals`. The client (`iso-game.js`
`_buildRealm`) already reads `layout.fishing`, `layout.cooking`, and
`layout.portals` — so it renders portals but the server never sends them.

## Goal

Make the game multi-realm. Players step onto a portal tile and arrive in the
destination realm at its `toTx,toTy`, with the world (nodes, mobs, geometry,
flags) fully swapped, and `safe`/`pvp`/`danger` rules applied per realm.

## What to build

1. **Parameterize `GameRoom` by realm.** Accept a realm name via room options /
   definition (e.g. `onCreate(options)` reads `options.realm`, default
   `mainland`). Replace the `MAINLAND` constant with `this.realm = REALMS[name]`
   and rebind `isBlocked`/`inBounds`/spawn/fountain/bankZone to it. `_seedWorld`,
   `onJoin`, healing, and respawn must all use `this.realm`.
2. **Register every realm.** In `index.js`, register a room per realm
   (`game_mainland`, `game_wilderness`, `game_whisperwood`, `game_pond`) or one
   `game` definition filtered by `realm` so each realm is its own instance.
   Players in different realms must not see or affect each other.
3. **Send the full layout on join.** Replace the hand-built `realm` message with
   `realmLayout(this.realm)` so `fishing`, `cooking`, `safeCamp`, `portals`,
   `safe`, `pvp`, `danger` all reach the client.
4. **Portal detection on movement.** In `_handleStep`, after a valid step, call
   `portalAt(this.realm, p.tx, p.ty)`. If a portal is hit, transition the player:
   - Carry the player's full state (inventory, hotbar, gold, skills/XP, bank,
     hp, cosmetic) to the destination realm room. Use Colyseus seat reservation
     (`matchMaker.reserveSeatFor`) and send the client a `transfer` message with
     the destination room id + reservation + spawn tile, OR consolidate realms
     into one room that swaps the player's active realm + reseeds their view.
     Pick one approach and implement it completely — state must not be lost.
   - On arrival the player spawns at `toTx,toTy` of the destination realm.
5. **Client transition.** `iso-game.js` / `game-net.js`: handle the `transfer`
   message by reconnecting/rejoining the destination room (or rebuilding the
   realm if single-room), preserving the camera and avatar. No flfrom-scratch
   reload, no flash of the wrong map. Show a brief, designed transition (fade or
   portal flash) — real, not a fake timer.
6. **Per-realm rules wired now** (deeper behavior is owned by later tasks, but
   the flags must be respected and readable): expose `realm.safe/pvp/danger` to
   the systems that need them; ensure Mainland/Whisperwood/Pond stay safe and
   Wilderness is danger+pvp outside its `safeCamp`.

## Definition of done

- Walking onto each Mainland portal tile lands you in Wilderness / Whisperwood /
  Pond at the correct return tile, and the reverse portals bring you back.
- Inventory, hotbar, gold, skills, bank, hp, and avatar are identical before and
  after a transition (verified by inspection).
- Players in different realms are isolated (two browser sessions confirm it).
- Client renders each realm's geometry, fishing/cooking tiles, safe camp, and
  portals from the server-sent layout. No console errors.
- HUD realm label updates to the destination realm name.

## Dependencies & follow-ons

Foundation task — unblocks 02, 03, 04, 05, 06, 08, 22, 23. Additional realm data
(Wilderness North/East, Arena) is added in Task 22 once traversal exists.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
