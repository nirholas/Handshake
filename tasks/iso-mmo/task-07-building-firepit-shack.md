# Task 07 — Building: firepit, shack & /pickup

## Context

There is no building system. Players gather `wood`, `stone`, and `coal` but have
nothing to spend them on beyond the bank. The world has a fountain for healing
but no player-placed structures. Movement is tile-stepped and the client already
has a scene object group for dynamic world objects.

## Goal

A complete placement system for two structures, plus pickup:
- **Firepit** — costs 20 stone + 20 coal + 50 wood, lasts ~30s, heals players who
  stand adjacent (like the fountain), then decays. Placeable in allowed realms.
- **Shack** — costs 500 wood + 200 stone, Whisperwood only, one per player,
  decorative landmark (no internal storage), persistent until picked up.
- **/pickup** — removes a structure you own, freeing the shack's one-per-player
  slot for re-placement.

## What to build

1. **Schema.** Add a `Structure` schema (`id`, `kind: 'firepit'|'shack'`, `owner`,
   `ownerName`, `tx`, `ty`, `expiresAt` (0 = permanent), optional `locked`) and a
   `structures` `MapSchema` on `GameState`. Structures occupy/are solid on their
   tile (factor into `_isWalkable`).
2. **Placement handler.** `onMessage('build', { kind, tx, ty })`: validate alive;
   target tile is in-bounds, walkable, adjacent to the player, and not on a
   portal/bank/fountain/resource tile; the realm allows that structure (shack →
   Whisperwood only; firepit → allowed realms); the player owns < the cap (shack
   one-per-player across realms); and the player has the exact material cost.
   Deduct materials atomically, create the structure, set `expiresAt` for firepit.
3. **Firepit healing + decay.** In `_tick`, heal players adjacent to any firepit
   (reuse the fountain heal logic), and delete firepits past `expiresAt`.
4. **Pickup + lock.** Implement `/pickup` (see Task 13 command routing, but the
   server action lives here): list/remove structures the caller owns; picking up
   a shack frees the slot. Implement `/lock` and `/unlock` to toggle a structure's
   `locked` flag so it ignores stray clicks.
5. **Client build mode.** Add a build menu (from the hotbar/`B` key) listing
   buildable structures with their costs and whether the player can afford them.
   Entering build mode shows a ghost preview that snaps to tiles and turns
   red/green for invalid/valid placement; left-click places (sends `build`),
   right-click cancels; movement clicks are suppressed until exit. Render
   firepits (with a real countdown ring from `expiresAt`) and shacks in the
   object group. Designed empty/affordability states ("Need 200 more wood").

## Definition of done

- A firepit can be built only when you have 20 stone + 20 coal + 50 wood; it
  heals adjacent players and disappears after its lifetime.
- A shack can be built only in Whisperwood, one per player; building a second is
  rejected until the first is picked up; `/pickup` frees the slot.
- `/lock`/`/unlock` protect structures from mis-clicks. Materials are deducted
  exactly (no negative balances, no free builds). No console errors.

## Dependencies

Requires Task 01 (realm rules per structure). `/pickup` `/lock` `/unlock` routing
comes from Task 13; implement the server-side actions here and expose them.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
