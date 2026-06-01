# Task 08 — Mainland mine interior

## Context

The world guide describes a mine entrance on the Mainland that leads to an
interior mining area dense with rocks and coal. Today Mainland has only a handful
of surface `rock`/`coal` nodes (`realms.js`), and there is no interior space.
Realm traversal + portals now exist (Task 01), so an interior is just another
realm reachable through an entrance tile.

## Goal

Add a mining interior reachable from a Mainland mine entrance: an enclosed cave
map rich in rock and coal nodes, with a return portal to the Mainland entrance.

## What to build

1. **Define the interior realm** in `realms.js` (e.g. `mine`): an enclosed cave
   grid, `safe: true` (no PvP/death — it is a Mainland-side resource area unless
   you intentionally make it dangerous; default safe), walled `blocked` regions
   forming cave corridors, a spawn at the entrance, and a dense set of `rock` and
   `coal` nodes. No bank/fountain. A return portal to the Mainland mine entrance.
2. **Mainland entrance.** Add a portal rectangle on Mainland (the mine entrance
   tile) with `to: 'mine'` and matching return coordinates, mirroring the existing
   portal pattern. Register the `mine` realm/room in `index.js` (Task 01 pattern).
3. **Visuals.** Give the interior a cave look in the client (`iso-game.js`
   `_buildRealm` reads the layout; darker ground/walls, rock-textured blocks).
   Keep it readable and performant.
4. **Balance.** Tune node counts and respawn timers so the mine is a meaningfully
   better mining spot than the surface without trivializing progression.

## Definition of done

- Walking onto the Mainland mine entrance transports the player into the cave
  interior; the return portal brings them back to the entrance tile.
- The interior has working rock/coal nodes (pickaxe gathers them, mining XP
  granted) and renders as a distinct cave space. No console errors.
- Players in the mine are isolated from the surface (separate room/instance).

## Dependencies

Requires Task 01 (multi-realm traversal + portals). Uses the existing gathering
system unchanged.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
