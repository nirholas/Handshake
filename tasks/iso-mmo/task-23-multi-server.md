# Task 23 — Multi-server world instances

## Context

The server runs as a single set of realm instances. The world guide describes two
selectable world instances ("Server 1" and "Server 2") on the same host: a player
picks one at login, their items and gold are shared between them (account-scoped),
but players on one server cannot see players on the other. `multiplayer/src/index.js`
already supports horizontal scaling via Redis driver + presence when `REDIS_URI`
is set, and Colyseus room filtering (`filterBy`) is already used for `walk_world`.

## Goal

Let players choose between two (or N) independent world instances at login.
Instances are fully isolated for presence/visibility but share one account-scoped
profile, so progression is identical regardless of which server you join.

## What to build

1. **Server dimension on rooms.** Add a `server` (instance) key to game room
   matchmaking — e.g. `filterBy(['realm', 'server'])` so each (realm, server)
   pair is its own room and players only ever match within their chosen server.
   Mirror the existing `walk_world` filtering pattern.
2. **Login selection.** On `/play` (after wallet sign-in, Task 17), present a
   server picker showing the available instances with live population counts
   (real, from presence/matchmaking — not faked). The choice is passed as a join
   option and pins all of that session's realm rooms to the chosen server.
3. **Shared account profile.** Because persistence (Task 16) is account-scoped,
   the same profile loads on either server — items, gold, skills, bank, etc. are
   identical. Verify a player can earn on Server 1, switch to Server 2, and see
   the same inventory. Guard against the same account being live on both servers
   simultaneously in a way that could clobber the profile (single active session
   per account, per Task 16 integrity rule).
4. **Isolation.** Players on different servers never appear in each other's
   realms, chat (Task 14), or `/who` (Task 13). Presence/friends (Task 15) should
   still show a friend's online status and which server+realm they're on.
5. **Population display + balancing.** Show real per-server population at the
   picker; optionally recommend the less-full server. No fake numbers.

## Definition of done

- The login picker lists the servers with real population counts; choosing one
  pins the session to it.
- Two sessions on different servers cannot see or interact with each other in any
  realm/chat/who, but the SAME account on either server has identical progression.
- Friends presence reflects which server+realm a friend is on. No profile
  clobbering across servers. No console errors.

## Dependencies

Requires Task 16 (account-scoped persistence + single-active-session rule) and
Task 17 (account identity). Uses the Redis driver/presence + `filterBy` infra
already present in `index.js`. Interacts with Tasks 13/14/15 for isolation.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
