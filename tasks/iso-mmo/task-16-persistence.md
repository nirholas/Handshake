# Task 16 — Account-keyed player persistence

## Context

All game state is in-memory and lost on disconnect. `GameRoom.onJoin` builds a
fresh `GamePlayer` every time (empty inventory + starter kit), and the per-player
`priv` map (XP, bank, cooldowns) is created on join and deleted on leave
(`onLeave`). Nothing is saved. The world guide promises that display name,
inventory, hotbar, bank, gold, skills, tutorial progress, daily quests, placed
structures, friends, cosmetics, and profile badge all save automatically. This
is the foundation the economy and social systems depend on.

## Goal

Persist each player's full progression keyed to their account so a returning
player resumes exactly where they left off, across realms and reconnects.

## What to build

1. **Account key.** Use the authenticated account id (wallet address from Task
   17) as the persistence key. Before auth lands, key on a stable id from the
   join handshake, but design the interface around the account id so Task 17 is a
   drop-in.
2. **Persistence store.** Choose and wire a real durable store reachable from the
   standalone multiplayer process (e.g. the same backend datastore the rest of
   the platform uses, exposed via `api/` endpoints the game server calls, or a
   direct DB/KV client). No local-only JSON files that die with the instance, no
   in-memory fakes. Must work across multiple server instances (Task 23).
3. **Persisted profile shape.** Define a single serializable profile:
   `name`, `inv`, `hotbar`, `activeSlot`, `bank`, `gold`, skill XP (all five,
   including `cooking`), `hp/maxHp`, `cosmetic`/equipped cosmetics + owned
   cosmetics (Task 21), placed structures (Task 07), tutorial completion + daily
   quest state + badges (Task 10), friends + mute list (Tasks 14/15), keybindings
   (Task 12), and current realm + tile (so they resume in place, or at a safe
   spawn if that realm is unsafe to resume into).
4. **Load on join / save on change.** On `onJoin`, load the profile (or create a
   new one with the starter kit on first ever login) and hydrate `GamePlayer` +
   `priv`. Save on meaningful mutations — debounced/throttled to avoid write
   storms (mirror the debounced-save pattern in `block-store.js` /
   `blockStore.flushAll()` used by `WalkRoom`), and flush on `onLeave`,
   `onDispose`, and server shutdown (`index.js` already calls
   `blockStore.flushAll()` on SIGTERM — hook the player store into the same path).
5. **Cross-realm continuity.** When a player transitions realms (Task 01), their
   profile follows; persistence is account-scoped, not room-scoped.
6. **Integrity.** Saves are atomic per account (no partial writes corrupting a
   profile). Concurrent logins of the same account are handled (reject the second,
   or hand off) so two sessions can't fork-and-clobber a profile.

## Definition of done

- Gather/earn/bank/level/build, disconnect, reconnect — everything is exactly as
  left, including across a server restart.
- A brand-new account starts with the correct starter kit; an existing account
  never gets reset.
- Saves are debounced under load and flushed on leave/shutdown; no write storms,
  no lost last-second changes. No console errors.

## Dependencies

Pairs with Task 17 (account id). Required by Tasks 10, 12, 14, 15, 19, 20, 21,
23. Reuse the `block-store.js` debounced-save + flush conventions.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
