# Coin Clash: token-gated community warfare

Coin Clash turns every coin community into an army. Hold the coin, sign a wallet challenge to enlist, and rally for your faction in timed battles: the side that taps hardest before the round ends wins. Factions and their social stats come from real communities, enlistment is gated on a live on-chain holding, and battle power is persisted and settled on a deterministic global clock. It is an early demo of a bigger community-warfare idea the platform is building for $THREE.

Page: [/clash](https://three.ws/clash)

API: `/api/clash/[action]` with `action` one of `state`, `enlist`, `enlist-verify`, `rally`, `leaderboard`.

## Why it exists

Coin communities already behave like tribes. Coin Clash gives that tribalism a game loop with real stakes of identity: you can only fight for a coin you actually hold, so rallying is a public act of conviction, and a community's showing on the board is a live measure of how many holders will show up. The token gate is a real balance read, not a client-side check, which makes it a working demonstration of the same "hold, do not just claim" primitive used across the platform (see [token-gated 3D embeds](./token-gated-3d-embeds.md) and [hold to access](./hold-to-access.md)). Effort wins, not market cap: a battle is decided by summed taps, so a smaller, more active army can beat a larger, quieter one.

## How it works

The page (`src/clash.js`) polls `GET /api/clash/state` every 5 seconds (paused while the tab is hidden) and renders the live bracket. There is no websocket; liveness is polling. All five actions route through a single handler, `api/clash/[action].js`, backed by the engine in `api/_lib/clash.js` and an Upstash Redis store (`api/_lib/clash-store.js`) with an in-process fallback.

**Factions.** Every community loaded from CoinCommunities becomes a faction, ranked strongest-first by member count and capped at `MAX_FACTIONS`. If the community source is unconfigured the API returns `503 cc_unconfigured` and the page shows a designed "temporarily unavailable" state and stops polling.

**Rounds (epochs).** Battles run on a deterministic global clock: `epoch = floor(now / EPOCH_MS)` with `EPOCH_MS` defaulting to 1 hour. Every serverless instance agrees on the current round without coordination. Matchmaking rotates the member-ranked pool by an epoch-derived hash (so the top seed does not always meet the second) and folds it into adjacent pairs; an odd count gives the lowest seed a bye. The previous round is settled lazily on each `state` read (claimed once via a Redis `SET NX`, so it is idempotent and needs no cron): faction powers are re-read, the bracket is recomputed from the power-ranked pool (so final pairings can differ from the member-ranked view shown live), and each battle is decided on raw power (higher wins, equal draws, both-zero writes no record). Win, loss, draw, and lifetime power fold into a permanent `clash:record` hash.

**Momentum.** Each faction carries a bounded vigor bonus between 1.0 and 1.5, blended from social recency, member mass, and a positive price move. The price move is measured from the platform's own samples: each `state` read refreshes a faction's spot price at most once a minute (shared across the fleet through Redis, so an open tab polling every 5 seconds never re-prices anything), and each snapshot keeps a baseline that rolls forward once a day, so the move a faction is credited for spans at most 24 hours. Prices come from Jupiter with the pump.fun bonding curve as failover. Missing signals contribute nothing and never block a rally: a mint nothing can price simply fights on its social signals.

## Token-gating and enlistment

Enlisting is a three-step gate, Solana only:

1. **Challenge.** `POST /api/clash/enlist` with `{ token, wallet }` returns a stateless, HMAC-signed message bound to that exact wallet and faction, valid for 5 minutes.
2. **Signature.** The wallet (Phantom via `window.solana`) signs the message; `POST /api/clash/enlist-verify` re-checks the challenge is un-tampered and fresh, then verifies the signature against the claimed wallet. A bad signature returns `401 bad_signature`.
3. **Holding.** The server reads the wallet's live on-chain balance (`getBalances`, Helius DAS with public-RPC failover) and confirms it holds the faction coin. The threshold is any strictly positive balance; there is no USD minimum (the USD figure is display-only, priced via the pump.fun bonding curve so even a fresh coin shows a real number). A non-holder gets `{ eligible: false, reason: 'not_a_holder' }`.

On success the server mints a **war pass**: a compact HMAC-signed token carrying the wallet, mint, amount, and USD, valid for 30 minutes. The rally endpoint trusts this pass instead of re-reading the chain on every tap.

## Rallying

`POST /api/clash/rally` with `{ pass, taps }` spends taps as faction battle power. Taps are clamped to `MAX_TAPS_PER_RALLY` (50 per call). Power added is `max(1, round(taps * POWER_PER_TAP * momentum))` with `POWER_PER_TAP = 1`. A per-wallet, per-faction, per-round cap (`MAX_POWER_PER_WALLET_EPOCH`, default 5000) is reserved atomically in Redis, so a wallet cannot exceed its ceiling and the client stops tapping once capped. The client batches taps and flushes them (and flushes any buffered taps on page hide via `sendBeacon`), backing off and re-queuing on a 429.

The leaderboard (`GET /api/clash/leaderboard`) returns all-time faction records sorted by wins then lifetime power, with a per-faction win rate, and optionally a single faction's top-10 soldiers this round via `?faction=<mint>`.

## Walkthrough

1. Open [/clash](https://three.ws/clash). The Arena tab shows the current round's battles as tug-of-war bars, each side showing its army's power, momentum, member count, and war record; the header counts down to the round end.
2. Connect a Solana wallet and pick a faction whose coin you hold. Click Enlist; approve the message signature in Phantom.
3. If you hold the coin, a war pass is issued and the Rally dock opens. Tap the RALLY button to add power; watch your power, the cap bar, and your army's total climb.
4. When the round ends, the result folds into the War Records tab. Check the leaderboard to see which communities are winning and where yours ranks.

## Examples

Reads are public and IP rate-limited; the write actions require a real wallet and signature.

```bash
# The live bracket for the current round
curl 'https://three.ws/api/clash/state'

# All-time faction war records, plus one faction's top soldiers this round
curl 'https://three.ws/api/clash/leaderboard?faction=<MINT>'

# Step 1: request an enlist challenge for a faction
curl -X POST 'https://three.ws/api/clash/enlist' \
  -H 'content-type: application/json' \
  -d '{"token":"<FACTION_MINT>","wallet":"<YOUR_WALLET>"}'
```

The Coin Clash state and leaderboard are also exposed read-only over MCP through `@three-ws/clash-mcp` (`get_clash_state`, `get_clash_leaderboard`).

## States and limits

- **Auth.** Viewing needs no login. Enlisting requires a connected Solana wallet and a message signature; rallying requires a valid war pass.
- **Rate limits.** Enlist and enlist-verify are limited to 20 per 5 minutes per IP; rally is 40 per minute per wallet; state and leaderboard are 120 per minute per IP.
- **Pass expiry.** A war pass lives 30 minutes; after that rally returns `401 pass_invalid` and the client transparently re-enlists if the wallet is still connected. Switching wallets drops the enlistment and prompts a re-enlist.
- **Empty and degraded states.** Fewer than 2 active communities shows "No battles live right now" with a link to `/communities`; a bye faction is labeled. An unconfigured community source shows a temporarily-unavailable state and stops polling. A request that never reaches the server (offline, blocked fetch) surfaces as a named connection error, "Couldn't reach the battle server", instead of the browser's raw "Failed to fetch". A Redis outage degrades silently to per-instance tallies and still serves 200s.
- **Validation.** Taps must be a positive integer and are clamped to 50 per call. The ambient particle field is skipped under `prefers-reduced-motion`.

## Related

- [Token-gated 3D embeds](./token-gated-3d-embeds.md): the same real on-chain balance gate, applied to embeds
- [Hold to access](./hold-to-access.md): the platform's broader hold-do-not-spend membership thesis
- [The social layer](./social-layer.md): platform-wide feed, follows, and leaderboards
- [MCP tools](./mcp.md): the read-only Clash MCP server
- Pages: [/clash](https://three.ws/clash) · [/communities](https://three.ws/communities)
