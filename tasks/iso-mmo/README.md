# Isometric MMO — Build Tasks

This directory holds self-contained build prompts for the tile-based isometric
multiplayer game served at `/play`. Each `task-NN-*.md` is an independent,
end-to-end feature spec. Hand any one to an engineer (or agent) and it should be
buildable to completion without further context.

## The codebase you are working in

**Authoritative game server** — Colyseus rooms (standalone Node process, not Vercel):
- `multiplayer/src/rooms/GameRoom.js` — the room: validates every client intent, owns all state.
- `multiplayer/src/rooms/realms.js` — realm/map definitions + geometry helpers (`inBounds`, `isBlocked`, `portalAt`, `inRect`, `realmLayout`).
- `multiplayer/src/schemas/game.js` — `@colyseus/schema` state (`GameState`, `GamePlayer`, `Slot`, `ResourceNode`, `Mob`, `Tombstone`).
- `multiplayer/src/index.js` — server entry; registers rooms (`game_mainland`, `walk_world`).

**Game client** — vanilla JS + Three.js, built by Vite:
- `src/game/iso-game.js` — renderer, HUD, input, scene build (`_buildRealm`), message handlers.
- `src/game/game-net.js` — Colyseus client connection + message bus (`net.on(...)`, `net.send(...)`).
- `src/game/iso-game.css` — game UI styles.
- `public/play.html` / `dist/play.html` — the `/play` entry document.

**Wallet / Solana** — `src/wallet-auth.js`, `src/wallet.js`, `src/solana.js`.

**Backend HTTP** — Vercel functions in `api/` (use for persistence, token quotes,
payment verification — anything that is not a live WebSocket concern).

## Current baseline (already built — do not rebuild)

Single realm only (Mainland). Working: click-to-walk movement with server-side
walkability validation, camera zoom/rotate, 24-slot inventory + 6-slot hotbar
with drag/swap/stack-to-999, resource gathering (tree/axe, rock/pickaxe, coal),
melee combat vs. mobs, training dummies, skill XP + leveling (cap 99), fountain
healing + passive regen, 48-slot bank, gold awarded on kills.

Key constants in `GameRoom.js`: `INV_SIZE=24`, `HOTBAR_SIZE=6`, `BANK_SIZE=48`,
`MAX_STACK=999`. Skills: `combat`, `woodcutting`, `mining`, `fishing`, `cooking`.

## Engineering standards (apply to EVERY task)

These are non-negotiable and override any urge to cut corners:

1. **Real data and real integrations only.** No mocks, no fake/sample arrays, no
   stubbed responses, no `setTimeout` fake progress. Wire real RPC, real APIs,
   real on-chain calls, real persistence.
2. **Server-authoritative.** The client sends intent; the server validates
   everything (bounds, adjacency, ownership, cooldowns, rate limits, balances)
   before mutating state. Never trust a client payload.
3. **Wire it end-to-end.** Schema → server handler → network message → client
   handler → rendered UI → user-reachable control. A feature with no way to
   reach it in the UI is not done. No dead buttons, no orphan handlers.
4. **Every state is designed.** Loading, empty, error, populated, overflow. Tell
   the user what to do next; never show a blank void or an unexplained failure.
5. **No TODOs, no stubs, no commented-out code, no `throw "not implemented"`.**
   If you write it, finish it.
6. **Match existing patterns.** Follow the rate-limit, cooldown, `priv`-map,
   `clean()`, `_addItem`, `_adjacent`, and message-naming conventions already in
   `GameRoom.js`. Follow `iso-game.js` conventions for scene groups and HUD.
7. **Persistence-aware.** Anything the player earns or changes must survive a
   disconnect once Task 16 (persistence) lands. Until then, write through the
   same save interface that task defines — do not bake in in-memory-only assumptions.
8. **Verify before claiming done.** Run the server + client, exercise the feature
   in a browser, confirm no console errors and real network traffic. State
   explicitly what you verified.

## Build order (dependencies)

Foundations first — several tasks unblock the rest:

- **Task 01 (realm traversal)** unblocks 02, 03, 04, 05, 06, 08, 22, 23.
- **Task 16 (persistence)** unblocks/needed-by 10, 12, 15, 17, 19, 20, 21, 23.
- **Task 17 (wallet auth)** unblocks 18; **Task 18 (token)** unblocks 19, 20.

| #  | Task | Depends on |
|----|------|-----------|
| 01 | Multi-realm support & portal traversal | — |
| 02 | Player death & tombstone death-bags | 01 |
| 03 | Mob AI: roam, aggro, chase, contact damage | 01 |
| 04 | PvP combat & safe-zone enforcement | 01, 03 |
| 05 | Fishing | 01 |
| 06 | Cooking & edible food healing | 01, 05 |
| 07 | Building: firepit, shack & /pickup | 01 |
| 08 | Mainland mine interior | 01 |
| 09 | Mob loot drops & mounts | 02, 03 |
| 10 | Quests: tutorial & daily quests | 16 |
| 11 | Skills panel UI & progression feedback | — |
| 12 | Hotbar number keys & rebindable keybindings | 16 |
| 13 | Chat slash commands | 14 |
| 14 | World chat: rate limit, length cap, mute | — |
| 15 | Friends: requests, presence, direct messages | 16, 17 |
| 16 | Account-keyed player persistence | 17 (account id) |
| 17 | Wallet sign-in & token-balance gate | — |
| 18 | On-chain token: treasury, burn, USD pricing | 17 |
| 19 | Spinner wheel | 18 |
| 20 | Marketplace: gold & gold-for-token listings | 16, 18 |
| 21 | Cosmetics shop | 16 |
| 22 | Additional realms & Arena (rollers, level-gated cave) | 01 |
| 23 | Multi-server world instances | 16 |
