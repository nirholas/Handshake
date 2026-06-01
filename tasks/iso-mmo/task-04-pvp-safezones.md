# Task 04 — PvP combat & safe-zone enforcement

## Context

`_handleAttack` in `GameRoom.js` only resolves attacks against mobs
(`state.mobs.get(...)`). There is no player-vs-player combat. Realms carry the
rules already: `realms.js` marks `pvp: true` on Wilderness (with a southern
`safeCamp` rectangle that disables PvP) and `pvp: false` on Mainland,
Whisperwood, and Pond. The `inRect` helper exists for safe-camp tests.

## Goal

Allow players to attack other players, but only where the realm rules permit:
PvP enabled realms outside any safe camp. Safe realms and safe camps fully
prevent player damage.

## What to build

1. **Target resolution.** Extend the attack path to accept a player target
   (e.g. `attack` payload distinguishes `{ kind: 'mob'|'player', id }`, or add a
   parallel `attackPlayer` message). Resolve the target player from
   `state.players`.
2. **PvP gating (server-authoritative).** Permit a player hit only when ALL hold:
   - `this.realm.pvp === true`.
   - Neither attacker nor target is inside `this.realm.safeCamp`
     (`inRect(safeCamp, tx, ty)`), and the realm is not `safe`.
   - Attacker and target are adjacent (`_adjacent`), both alive, not the same
     player, and the attack cooldown is ready.
   Reject (with a client `notice`) in all other cases — including any attempt to
   hit a player on Mainland/Whisperwood/Pond.
3. **Damage + death.** Apply damage using the existing damage formula (combat
   level + sword bonus + variance). On HP 0, call `_killPlayer` (Task 02) so the
   victim drops a tombstone in danger realms. Award the killer appropriately
   (define and document: e.g. combat XP; decide whether gold/loot transfers —
   keep it consistent with the tombstone model so loot flows through the bag, not
   a direct steal).
4. **Anti-abuse.** Keep PvP under the same attack rate limit/cooldown as PvE.
   Prevent spawn-camping basics: brief post-respawn protection (a short
   invulnerability window where the player cannot deal or take player damage).
5. **Client.** Make other players targetable (click) only where PvP is legal;
   show a clear affordance (e.g. hostile cursor / outline) when over an
   attackable player and a "safe zone" indicator where PvP is disabled. Floating
   damage numbers and HP bars for the involved players. A killfeed/notice on a
   PvP kill.

## Definition of done

- Two sessions can fight in Wilderness outside the camp; neither can damage the
  other inside the camp or in any safe realm (server rejects it, not just UI).
- A PvP death drops the victim's tombstone (Task 02) and applies the documented
  reward to the killer. Respawn protection prevents instant re-kills.
- No way to bypass the gate from a crafted client payload. No console errors.

## Dependencies

Requires Task 01 (realm flags/rooms) and Task 02 (`_killPlayer`/tombstones).
Shares the damage model with Task 03.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
