# Task 09 — Mob loot drops & mounts

## Context

When a mob dies in `_handleAttack`, the player gets gold + combat XP and the mob
respawns — but no items drop. The world guide says mobs occasionally drop
**mounts**, which players can ride for faster movement and leave with a
`/dismount` command. There is currently no loot table, no mount item, and no
mounted-movement system. Tasks 02/03/04 left a clean "mob death" hook.

## Goal

A loot system that drops items (notably mounts) from mob kills on a rolled
chance, plus a mount system: equip a mount to move faster, and dismount on
command.

## What to build

1. **Loot tables.** Add a data-driven drop table keyed by mob `kind` (e.g.
   goblin/ogre have a small mount-drop chance plus any other intended drops).
   Roll on mob death (both PvE and, if applicable, the mob-death hook from Task
   03). Award items via `_addItem`; if the inventory is full, drop the loot into a
   ground bag (reuse the Task 02 tombstone/bag mechanics) rather than vanishing.
2. **Mount item + state.** Define mount items in the item registry (Task 06).
   Add player mount state (e.g. `mounted` flag / `mount` id on `GamePlayer`).
   Equipping/using a mount item from the hotbar mounts the player.
3. **Mounted movement.** While mounted, increase effective movement speed. Since
   movement is tile-stepped and server-validated, implement speed as a reduced
   step cooldown / higher step rate-limit headroom for mounted players — keep it
   server-authoritative (no client-claimed speed). Decide and document whether
   gathering/combat are restricted while mounted.
4. **/dismount.** Wire the `/dismount` command (routing from Task 13; action
   here): clear mount state and return to normal speed. Also auto-dismount on
   death.
5. **Client.** Render the mount under/around the avatar when mounted, animate
   faster locomotion, and show a mount indicator in the HUD. A kill that drops a
   mount shows a celebratory, honest notice ("The ogre dropped a mount!"). Mount
   from the hotbar; `/dismount` (or a HUD button) to get off.

## Definition of done

- Killing mobs occasionally yields real drops per the table; mounts can be
  obtained, equipped, and ridden for visibly faster travel; `/dismount` works and
  death auto-dismounts.
- Loot never silently disappears on a full inventory (it bags on the ground).
- Speed is enforced server-side. No console errors.

## Dependencies

Requires Task 03 (mob death hook) and Task 02 (ground-bag mechanics for overflow
loot). Uses the item registry from Task 06. `/dismount` routing from Task 13.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
