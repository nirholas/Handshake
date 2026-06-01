# Task 03 — Mob AI: roam, aggro, chase, contact damage

## Context

Mobs are static targets. `realms.js` defines mobs with `roam` and `aggro` flags
(Wilderness has goblins/ogre with `roam: true, aggro: true`; Mainland has
training dummies with both `false`). The `Mob` schema (`game.js`) has an
`aggroId` field ("session id of the player this mob is chasing"). But
`GameRoom._tick` only handles mob respawn — **mobs never move, never aggro, and
never damage players.** Combat is one-directional (player hits mob).

## Goal

Give mobs server-authoritative behavior: roamers wander, aggressive mobs detect
nearby players, chase them, and deal contact damage during a hit window —
feeding the death/tombstone system (Task 02). Dummies stay inert for practice.

## What to build

1. **Carry behavior flags into state.** When seeding (`_seedWorld`), persist each
   mob's `roam`/`aggro` (off-schema in a server-side map, or add fields) plus a
   spawn/home tile for leashing. Add tuning constants (aggro radius, leash
   radius, move interval, contact damage, attack cooldown, mob HP regen).
2. **Mob simulation in `_tick`** (or a dedicated faster mob tick):
   - **Roam:** idle mobs with `roam` occasionally step to a random adjacent
     walkable tile within a leash radius of home. Reuse the same walkability
     rules as players (`inBounds`, `isBlocked`, node/mob/player occupancy).
   - **Aggro acquisition:** an `aggro` mob with no target scans for the nearest
     living, non-dead player within aggro radius and in the same realm; set
     `aggroId`. Respect safe zones — a mob must not enter or aggro inside a
     `safeCamp` (`inRect`) or in a `safe` realm.
   - **Chase:** a mob with an `aggroId` steps one tile toward that player each
     move tick (greedy pathing around obstacles). Drop aggro and return home if
     the player dies, leaves the realm, enters the safe camp, or exceeds the
     leash radius.
   - **Contact damage:** when adjacent to its target and its attack cooldown is
     ready, deal damage to the player (`p.hp -= dmg`, clamp at 0). If HP hits 0,
     call `_killPlayer` (Task 02). Set a `hitTs`-style marker so the client can
     flash the player.
3. **Mount/loot drops** are owned by Task 09 — leave a clean hook on mob death.
4. **Client.** Mobs already render and tween position from synced `tx/ty`;
   confirm chasing reads smoothly. Show a damage flash + floating damage number
   when the local player is hit, and an aggro indicator on hostile mobs.
   Player HP bar reflects incoming damage in real time.

## Definition of done

- Goblins/ogre in Wilderness wander, notice a nearby player, chase, and deal
  damage; standing in the safe camp stops them at the fence.
- Training dummies on Mainland never move or attack.
- A player can be killed by mobs, triggering Task 02 death/tombstone in danger
  realms. Movement remains smooth; no teleporting mobs; no console errors.
- Mob CPU cost is bounded (no O(players×mobs) blowups per frame — scans run on
  the sim tick, not the patch rate).

## Dependencies

Requires Task 01 (realms). Calls `_killPlayer` from Task 02. Leaves the kill hook
for Task 09 (loot/mounts).

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
