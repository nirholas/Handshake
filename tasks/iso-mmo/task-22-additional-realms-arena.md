# Task 22 — Additional realms & Arena (rollers, level-gated cave)

## Context

`realms.js` defines four realms (mainland, wilderness, whisperwood, pond) and
Task 01 made traversal real. The world guide describes more areas not yet built:
- **Wilderness North** — a smaller northern area reached from the top of the main
  Wilderness; PvP across the whole map (no safe camp); lower mob density; a
  level-gated cave at the far north requiring high enough combat skill to enter.
- **Wilderness East** — a full-size wild area east of the main Wilderness, also
  reachable from the north edge of the Pond; PvP + mob danger like the Wilderness.
- **Arena** — a dedicated PvP scene reached from a Mainland arena plaza (with a
  small practice boxing ring on the Mainland itself); has moving floor "rollers"
  that push players, plus spectator seating.

## Goal

Add these realms with their distinguishing mechanics, fully connected to the
existing portal network and rule systems.

## What to build

1. **Wilderness North.** Define the realm (`pvp: true, danger: true`, no
   `safeCamp`, lower mob density). Add the portal pair connecting the top of the
   main Wilderness to its south return. At the far north, a **level-gated cave
   portal**: entry requires the player's combat level ≥ a threshold (use the Task
   11 helper); server rejects under-level entry with a clear notice. Build the
   cave as its own realm/instance beyond the gate.
2. **Wilderness East.** Define the realm (`pvp: true, danger: true`), with portal
   pairs to the east edge of the main Wilderness AND the north edge of the Pond
   (add the matching portals on those existing realms). Populate nodes/mobs to
   match Wilderness danger.
3. **Arena + boxing ring.** Add an arena plaza area on the Mainland (a small
   walkable boxing ring for practice — visual + tile region, no death risk) and a
   portal into the full **Arena** realm. The Arena is a PvP scene (`pvp: true`)
   with:
   - **Rollers** — tiles that, on the sim tick, push a standing player one tile in
     the roller's direction (server-authoritative, respecting walkability). Learn-
     the-flow movement, not teleporting.
   - Spectator/seating tiles (non-combat zones) and a south return strip to the
     Mainland plaza.
4. **Registration + client visuals.** Register all new realms/rooms (Task 01
   pattern in `index.js`). Give each a fitting look in `_buildRealm` (cave,
   wild-north, wild-east, arena with visible rollers + seating). Ensure portals
   render and the HUD realm label updates.

## Definition of done

- Wilderness North and East are reachable through real portals, enforce PvP+
  danger, and connect where the guide says (incl. Pond↔East).
- The northern cave rejects under-combat-level players and admits qualified ones.
- The Mainland boxing ring is walkable/safe; the Arena is reachable, PvP-enabled,
  and rollers push players server-side along their direction; the return strip
  works. No console errors.

## Dependencies

Requires Task 01 (traversal), Task 04 (PvP rules for the wild realms + arena),
Task 02/03 (death + mobs in the wild realms), and Task 11 (combat-level gate).

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
