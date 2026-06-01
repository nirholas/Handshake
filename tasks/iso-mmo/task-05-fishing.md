# Task 05 — Fishing

## Context

The `fishing` skill exists on `GamePlayer` (`game.js`) and `realms.js` defines
`fishing` tiles (shoreline coordinates) on Whisperwood and Pond, serialized to
the client via `realmLayout`. The client `_buildRealm` already paints fishing
spots. A `rod` tool is in the starter kit and `STACKABLE` already includes
`'fish'`. **But there is no fishing handler** — no way to cast, no catch roll, no
fish item awarded, and `priv.xp` doesn't even track `fishing` consistently
(`onJoin` seeds `xp: { woodcutting, mining, fishing, combat }` — confirm fishing
and add cooking where missing). Fishing XP is never granted anywhere.

## Goal

A complete fishing loop: equip the rod, stand next to fishable water, cast, and —
after a real per-cast resolution — receive raw fish and fishing XP, scaled by
skill and spot quality.

## What to build

1. **Cast handler.** `onMessage('fish', ...)`: validate the player is alive, the
   `rod` is on the active hotbar slot, the player is adjacent to a `fishing` tile
   of the current realm, and a fishing cooldown has elapsed. Rate-limit it
   (reuse the `gather` bucket pattern or add a `fish` limit).
2. **Catch resolution.** Roll success against fishing skill + spot quality (define
   a clear curve — higher skill = higher catch rate and/or better yield). On
   success, `_addItem(p, 'fish', n)` (respect full-inventory leftover) and
   `_grantXp(sessionId, p, 'fishing', amount)`. On a miss, give a small XP trickle
   or none, and a "the fish got away" notice. Apply a per-cast cooldown so casting
   has cadence (real async resolution on the sim/cooldown clock — no fake timer).
3. **Spot quality.** Allow tuning per realm/tile (e.g. Pond's open water richer
   than Whisperwood ponds). Keep data in `realms.js` if it needs to vary.
4. **Client.** When the rod is equipped and the player clicks an adjacent fishing
   tile, send `fish` and show a cast animation/line + bobber, then resolve to a
   caught-fish toast or a miss toast. Disable casting (with a hint) when no rod is
   equipped or not adjacent to water. Update the fishing skill display on level-up.

## Definition of done

- Equipping the rod and clicking adjacent water in Whisperwood/Pond yields raw
  fish over repeated casts, with fishing XP and visible level-ups.
- Casting is rejected (with a helpful notice) without a rod, away from water, or
  when the inventory is full. Catch rate visibly improves as fishing level rises.
- No console errors; server validates every cast (no client-claimed catches).

## Dependencies

Requires Task 01 (realm layout incl. fishing tiles delivered to client). Feeds
Task 06 (cooking consumes raw fish).

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
