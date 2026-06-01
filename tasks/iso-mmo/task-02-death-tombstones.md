# Task 02 — Player death & tombstone death-bags

## Context

`multiplayer/src/schemas/game.js` already defines a `Tombstone` schema
(`id`, `owner`, `ownerName`, `tx`, `ty`, `items: [Slot]`, `expiresAt`) and
`GameState.tombstones` is a `MapSchema`. `GamePlayer` has `dead` and `respawnAt`
fields. The simulation tick in `GameRoom._tick` already respawns a dead player
(`if (p.dead) { ... p.dead = false; ... }`). **But nothing ever sets
`p.dead = true`** — there is no damage-to-players path and no tombstone is ever
created. Players are effectively immortal. Realms carry a `danger` flag
(`realms.js`): Wilderness is `danger: true`; Mainland/Whisperwood/Pond are not.

## Goal

When a player's HP reaches zero, they die: respawn at the realm's safe spawn
after a delay, and — only in `danger` realms — drop a tombstone holding part of
their inventory that they (and, after a grace window, anyone) can recover before
it expires.

## What to build

1. **Death trigger.** Add a `_killPlayer(p)` path invoked whenever player HP hits
   0 (from mob contact damage in Task 03, PvP in Task 04, or any future source).
   Set `p.dead = true`, `p.motion = 'idle'`, `p.respawnAt = now + RESPAWN_PLAYER_MS`,
   and broadcast a `died` notice to the client.
2. **Tombstone drop (danger realms only).** On death in a `danger` realm, move a
   defined subset of the player's items into a new `Tombstone` at the death tile:
   - Decide and document the drop rule (e.g. equipped tools kept, stackable
     resources and non-tool items dropped). Keep it deterministic and fair.
   - Populate `items`, `owner`, `ownerName`, `tx/ty`, and
     `expiresAt = now + TOMBSTONE_TTL_MS`. Insert into `state.tombstones`.
   - In safe realms, no tombstone is created and no items are lost.
3. **Per-realm isolation.** Because each realm is its own room (Task 01),
   tombstones already cannot collide across realms — confirm a death in one
   realm never affects another player's view elsewhere.
4. **Recovery.** Add an `onMessage('tombLoot', ...)` handler: validate the player
   is adjacent to the tombstone, then transfer items back into their inventory
   (`_addItem`, respecting full-inventory leftover). Enforce ownership: only the
   `owner` may loot until a grace window passes (`now > expiresAt - GRACE_MS`),
   after which anyone adjacent may loot. Remove the tombstone when empty.
5. **Expiry.** In `_tick`, delete tombstones past `expiresAt`.
6. **Client.** Render tombstones in the object group (`iso-game.js`) as a
   distinct mesh/marker with the owner name. Clicking an adjacent tombstone sends
   `tombLoot` and opens a small recovery panel showing its contents. Designed
   empty state ("This bag is empty") and a clear "expires in Xs" countdown driven
   by `expiresAt` (real value, not a fake timer). Death shows a respawn overlay
   with the real countdown to `respawnAt`.

## Definition of done

- Dying in Wilderness drops a tombstone with the correct items; dying in a safe
  realm does not.
- The owner can recover items by walking back and clicking; after the grace
  window others can; expired tombstones vanish server-side and client-side.
- Respawn returns the player to the realm spawn with full HP after the delay.
- Inventory math is exact (no item duplication or loss). No console errors.

## Dependencies

Requires Task 01 (realms + per-realm rooms). Damage sources that cause death are
delivered by Task 03 (mobs) and Task 04 (PvP); build death/tombstone mechanics so
those tasks only need to call `_killPlayer`.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
