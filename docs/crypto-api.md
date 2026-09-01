# Crypto Data API

The three.ws **Crypto Data API** is a free, keyless bundle of read-only crypto
endpoints built for AI agents. No account, no API key, no payment — just HTTP
GET, rate-limited to 60 requests per minute per IP. Each endpoint answers one
question an autonomous agent has mid-task, from real on-chain and pump.fun data
(no mocks).

Base URL: `https://three.ws`

> This bundle is the free loss-leader tier. Paid, deeper analytics live behind
> the x402 rail (see [`/.well-known/x402.json`](https://three.ws/.well-known/x402.json)).

---

## Discover the whole bundle in one call

The API is self-describing. An agent (or a human wiring one up) hits **one URL**
to learn every endpoint, its inputs and outputs, and a live example — no need to
read this page first.

| Discovery endpoint | Returns |
|--------------------|---------|
| [`GET /api/crypto`](https://three.ws/api/crypto) | The catalog: `{ name, free, keyless, version, endpoints[], docs, openapi, ts }`. Send `Accept: text/html` for a browsable page, anything else for JSON. |
| [`GET /api/crypto/openapi.json`](https://three.ws/api/crypto/openapi.json) | A real **OpenAPI 3.1** document generated from the same catalog — point Swagger UI, `openapi-generator`, or a framework's OpenAPI tool loader at it to get typed clients / callable tools for free. |

Both are generated from the catalog, so they can never drift from the live
endpoints — a new endpoint appears in both the moment it ships. Zero endpoints is
a valid state (empty `endpoints[]` + a "coming soon" note), never an error.

```bash
# One call, the whole map — pipe into jq to list paths
curl -s https://three.ws/api/crypto | jq '.endpoints[] | {method, path, title}'

# Generate a typed client from the spec
curl -s https://three.ws/api/crypto/openapi.json -o crypto.openapi.json
```

### Endpoints

Every endpoint is free, keyless, `GET` (a couple also accept `POST`), and rate-
limited per IP. This table is the canonical index; each endpoint's full contract
is documented in its section below and machine-readable in the OpenAPI doc.

| Endpoint | Verb(s) | What it answers |
|----------|---------|-----------------|
| [`/api/crypto/airdrops`](https://three.ws/api/crypto/airdrops) | `GET` | Which airdrops a wallet is on track for - its real on-chain activity scored against the live registry, with met/missing criteria per airdrop. |
| [`/api/crypto/bonding`](https://three.ws/api/crypto/bonding) | `GET` | Where a pump.fun token sits on its bonding curve — % to graduation, SOL in the curve, and whether it has migrated to an AMM. |
| [`/api/crypto/holders`](https://three.ws/api/crypto/holders) | `GET` | Holder distribution for a Solana token — top wallets with % of supply, cumulative top-10 share, and a documented concentration verdict. |
| [`/api/crypto/launches`](https://three.ws/api/crypto/launches) | `GET` | The freshest pump.fun launches, newest first — age, market cap, bonding-curve progress, dev wallet — with `minMarketCap` / `maxAgeMin` filters built for polling agents. |
| [`/api/crypto/portfolio`](https://three.ws/api/crypto/portfolio) | `GET` | A wallet read shaped for a portfolio view - stable/major/other split, top-asset allocation, per-token 24h change, and an aggregate 24h move that states its own coverage. |
| [`/api/crypto/security`](https://three.ws/api/crypto/security) | `GET` | Pre-trade rug check for a Solana token — authority, concentration, liquidity, mutability, and LP-custody facts composed into a deterministic riskLevel. |
| [`/api/crypto/symbol`](https://three.ws/api/crypto/symbol) | `GET` · `POST` | Whether up to 20 candidate tickers are taken — exact and fuzzy (look-alike) collisions across live registries. |
| [`/api/crypto/token`](https://three.ws/api/crypto/token) | `GET` | The current market state of any token by contract address — price, 24 h change, market cap, FDV, liquidity, volume, and venue link in one call. |
| [`/api/crypto/trending`](https://three.ws/api/crypto/trending) | `GET` | Solana tokens ranked by momentum (volume + buy pressure + spike + short-window price change) fused across sources. |
| [`/api/crypto/wallet`](https://three.ws/api/crypto/wallet) | `GET` | A wallet's native balance, every token it holds, and a rough USD valuation — keyless on Solana. |
| [`/api/crypto/whales`](https://three.ws/api/crypto/whales) | `GET` | Large buys on pump.fun for a token or market-wide, with a deterministic bullish/bearish/neutral buy-pressure signal. |

> Building an endpoint for this bundle? Drop a self-describing descriptor file in
> `api/_lib/crypto-catalog/` (`{ slug, method(s), path, title, summary,
> inputSchema, outputSchema, example }`) — the index and OpenAPI doc pick it up
> automatically, and it lists in the table above on the next deploy.

---

## `GET /api/crypto/launches` — Live pump.fun launches

**Use-case.** A sniper/discovery agent wants the freshest pump.fun launches with
enough signal to filter on the spot: name, symbol, mint, **age**, current
**market cap**, **bonding-curve progress**, and the **dev wallet**. New mints
appear every few seconds; a free live feed is exactly what such an agent polls.
Feed the interesting mints to [`/api/crypto/bonding`](#get-apicryptobonding--bonding-curve--graduation-status)
to watch their curve and [`/api/crypto/whales`](#get-apicryptowhales--whale--large-buy-activity)
to watch the money.

`bondingProgressPct` here is computed by the **same shared curve math** as
`/api/crypto/bonding` ([`api/_lib/pump-bonding.js`](../api/_lib/pump-bonding.js)),
so the two endpoints can never disagree about a coin's progress.

### Request

| Param | Type | Notes |
|-------|------|-------|
| `limit` | integer | How many launches to return, newest first. Default `20`, values above `100` are capped (not an error). |
| `minMarketCap` | number | Optional. Only launches at or above this USD market cap. Coins whose cap is unknown are dropped, never guessed. |
| `maxAgeMin` | number | Optional. Only launches at most this many minutes old. |

### Response

```json
{
  "launches": [
    {
      "mint": "THREEsynthetic111111111111111111111111111111",
      "name": "Example Launch",
      "symbol": "EXMPL",
      "createdAt": "2026-07-07T02:29:41.000Z",
      "ageMinutes": 0.2,
      "marketCapUsd": 1180.09,
      "bondingProgressPct": 0.13,
      "graduated": false,
      "dev": "THREEsyntheticDev11111111111111111111111111",
      "url": "https://pump.fun/coin/THREEsynthetic111111111111111111111111111111",
      "imageUrl": "https://ipfs.io/ipfs/…"
    }
  ],
  "count": 1,
  "ts": "2026-07-07T02:29:55.000Z",
  "source": "pumpfun"
}
```

- **`ageMinutes`** — one decimal, so a 30-second-old launch reads `0.5`, not `0` or `1`.
- **`bondingProgressPct`** — `0`–`100` share of the curve bought out; `100` (with
  `graduated: true`) for a coin that already left the curve.
- **`dev`** — the creator wallet, for dev-reputation filtering.
- Unresolvable fields are `null`, never omitted, never faked.

### States

- **Launches found** → `200`, sorted newest first, filters applied.
- **Nothing matches the filters** → `200` with `launches: [], count: 0` and a
  `note` saying which knobs to relax — an empty sweep is a valid answer, not an error.
- **pump.fun feed momentarily unreachable** → `200` with `launches: []` and
  `source: "pumpfun:unavailable"` + a retry note. A polling agent treats it as
  "nothing this sweep". Never `500`.
- **Malformed `limit` / `minMarketCap` / `maxAgeMin`** → `400` with a clear message.
- **Rate-limited** → `429` with `RateLimit-*` + `Retry-After` headers.

### Examples

```bash
# The 5 freshest launches
curl "https://three.ws/api/crypto/launches?limit=5"

# Snipe filter: under 30 minutes old AND already at $5k+ market cap
curl "https://three.ws/api/crypto/launches?maxAgeMin=30&minMarketCap=5000" \
  | jq '.launches[] | {symbol, ageMinutes, marketCapUsd, bondingProgressPct}'
```

---

## `GET /api/crypto/bonding` — Bonding-curve / graduation status

**Use-case.** An agent holding or watching a pump.fun token needs to know exactly
where it is on the bonding curve — **% to graduation**, how much SOL is in the
curve, and whether it has already **migrated** to Raydium / PumpSwap. Timing
entries and exits around graduation is a core meme-trading move: a coin at 95% is
minutes from a supply/liquidity regime change; one that already graduated no longer
trades on the curve at all. Without this an agent would have to fetch the curve
account over RPC and do the reserve math itself — here it's one keyless GET.

Pair it with [`/api/crypto/launches`](https://three.ws/api/crypto/launches) to
discover fresh mints, then poll `bonding` on the ones worth watching.

### Request

| Param  | Type   | Notes |
|--------|--------|-------|
| `mint` | string | pump.fun token mint (base58 Solana address). Required. |

### Response

On-curve token (still filling the bonding curve):

```json
{
  "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
  "onCurve": true,
  "bondingProgressPct": 70.67,
  "solInCurve": 32.81,
  "tokensRemaining": 232581073.73,
  "marketCapUsd": 10095.72,
  "graduated": false,
  "migratedTo": null,
  "ts": "2026-07-07T00:00:00.000Z",
  "source": "pumpfun"
}
```

Graduated token (left the curve for an AMM):

```json
{
  "mint": "THREEsynthetic1111111111111111111111111111",
  "onCurve": false,
  "bondingProgressPct": 100,
  "solInCurve": null,
  "tokensRemaining": null,
  "marketCapUsd": 424807497.98,
  "graduated": true,
  "migratedTo": "pumpswap",
  "ts": "2026-07-07T00:00:00.000Z",
  "source": "pumpfun"
}
```

- **`onCurve`** — `true` while the token is still on the bonding curve; `false`
  once it has graduated.
- **`bondingProgressPct`** — `0`–`100`, the share of the curve's token float that
  has been bought out (`0` at launch, `100` once graduated). The math is the share
  of the curve's initial 793.1M-token float still unsold — the same `bondingProgressPct`
  the Oracle coin page uses, shared from
  [`api/_lib/pump-bonding.js`](../api/_lib/pump-bonding.js).
- **`solInCurve`** — real SOL reserves currently in the curve; `null` once graduated.
- **`tokensRemaining`** — tokens still buyable on the curve; `null` once graduated.
- **`graduated`** — `true` once the curve completed and the token migrated to an AMM.
- **`migratedTo`** — `"raydium"` or `"pumpswap"` for a graduated token; `null` while
  still on the curve.

### States

- **On the curve** → `200` with live `bondingProgressPct` / `solInCurve` /
  `tokensRemaining`.
- **Already graduated** → `200` with `graduated: true`, `migratedTo` set, and the
  curve fields `null` / final (`bondingProgressPct: 100`).
- **Not a pump.fun mint** (never launched on pump.fun, or an externally-indexed
  token like WSOL/USDC) → `400 not_pumpfun_mint` with a pointer to
  `/api/crypto/launches`.
- **Missing / non-base58 `mint`** → `400 missing_mint` / `400 invalid_mint` with a
  clear message.
- **pump.fun feed unavailable** → `503 upstream_unavailable` + `Retry-After`. Never `500`.
- **Rate-limited** → `429` with `RateLimit-*` + `Retry-After` headers.

### Examples

```bash
# How close is this token to graduating?
curl "https://three.ws/api/crypto/bonding?mint=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"

# Has it already migrated to an AMM?
curl "https://three.ws/api/crypto/bonding?mint=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" | jq '{graduated, migratedTo}'
```

---

## `GET /api/crypto/whales` — Whale / large-buy activity

**Use-case.** A trading or sniper agent, mid-decision, needs to know whether big
money is moving into a token — or the pump.fun market broadly — *before* it
commits. A whale already in means price impact is ahead; no whales means the book
is thin. This endpoint is a free, high-signal read of large buys.

### Request

| Param    | Type   | Default | Notes |
|----------|--------|---------|-------|
| `mint`   | string | —       | Optional base58 Solana mint. **Present** → whale buys of that token. **Omitted** → top whale wallets active across pump.fun. |
| `minSol` | number | `5`     | Minimum SOL in a single buy to qualify as a whale (floored at `0.1`). |
| `limit`  | int    | `10`    | Rows to return (max `25`). |

### Response

```json
{
  "scope": "token",
  "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
  "minSol": 5,
  "whales": [
    {
      "wallet": "AbcDEF12345GHJKLMNopqrstuvwxyZabcdefghijk1",
      "solMoved": 12.4,
      "txHash": "5xTr4nSacT1oNsigNaTuReExampLe…",
      "ts": "2026-07-07T00:00:00.000Z"
    }
  ],
  "whaleCount": 1,
  "totalSolMoved": 12.4,
  "signal": "bullish",
  "ts": "2026-07-07T00:00:00.000Z",
  "source": "pump.fun"
}
```

- **`scope`** — `token` when `mint` is supplied, else `market`.
- **`whales`** — in `token` scope, one row per qualifying **buy** (largest
  first). In `market` scope, one row per qualifying whale **wallet**, where
  `solMoved` is the sum of that wallet's qualifying buys and `txHash`/`ts` point
  at its single largest buy.
- **`whaleCount`** — qualifying buys (token scope) or distinct whale wallets
  (market scope).
- **`totalSolMoved`** — total SOL across all qualifying whale buys.
- **`signal`** — see the rule below.
- **`stale`**: present and `true` only when pump.fun was rate-limiting and the
  rows came from the last successful pull. Absent means live.

### The signal rule (deterministic — no LLM)

The signal reads **net whale flow**: SOL bought by whales minus SOL sold by
whales, counting only trades at or above `minSol`. A net move of at least one
whale-sized position sets the direction, so the rule means the same thing at any
threshold:

```
netFlow = whaleBuySol − whaleSellSol

no qualifying whale trades at all   → neutral
netFlow ≥ +minSol (net accumulation) → bullish
netFlow ≤ −minSol (net distribution) → bearish
otherwise (balanced)                 → neutral
```

The implementation is `computeSignal` in
[`api/_lib/pump-whale-scan.js`](../api/_lib/pump-whale-scan.js) and is covered by
`tests/crypto-whales.test.js`.

### States

- **No whales over threshold** → `200` with `whales: []`, `whaleCount: 0`, and
  `signal: "neutral"`. Not an error. A quiet mint reports this, *not* an outage.
- **pump.fun feed unavailable** → `200` with an empty whale set and a `note`
  field. Never `500`. "Unavailable" means the feed call failed, never that the
  market happened to be quiet.
- **pump.fun rate-limited us** → `200` with `stale: true` alongside the normal
  body. The rows are real trades from the last successful pull (up to ten
  minutes old) rather than an empty answer; poll again shortly for live data.
- **Malformed `mint` / `minSol` / `limit`** → `400` with a clear message and an
  `example`.
- **Rate-limited** → `429` with `RateLimit-*` + `Retry-After` headers.

### Examples

```bash
# Whale buys of $THREE
curl "https://three.ws/api/crypto/whales?mint=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"

# Top whale wallets across pump.fun, raise the bar to 10 SOL, top 5
curl "https://three.ws/api/crypto/whales?minSol=10&limit=5"
```

---

## `GET /api/crypto/wallet` — Wallet portfolio

**Use-case.** An autonomous agent needs to inspect a wallet — its own or a
counterparty's — before it transacts. A **treasury agent** checks its own runway
(SOL + token value) before a spend; a **copy-trade agent** reads a leader wallet's
holdings to decide what to mirror; a **pre-trade counterparty check** inspects who
it's about to deal with (a fresh empty wallet, or a real holder?). Without this the
agent has to juggle an RPC (`getTokenAccountsByOwner`), a metadata source, and a
price API itself — here it's one keyless GET.

### Request

| Param     | Type   | Default  | Notes |
|-----------|--------|----------|-------|
| `address` | string | —        | Wallet address. Solana base58, or an EVM `0x` address. Required. |
| `chain`   | string | `solana` | `solana` (keyless) or `ethereum` (needs a provider key on the deployment). |

Solana is the keyless flagship: balances come from Helius DAS when a key is
configured, and fall back to the **public Solana RPC** (`getTokenAccountsByOwner`)
with **Jupiter Lite** + the **pump.fun bonding curve** for pricing when it isn't —
so a real answer comes back with no key at all.

### Response

```json
{
  "address": "HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk",
  "chain": "solana",
  "native": { "symbol": "SOL", "amount": 2.5, "usd": 375.0 },
  "tokens": [
    {
      "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
      "symbol": "THREE",
      "name": "three.ws",
      "amount": 1000,
      "usd": 1.6,
      "logo": "https://.../three.png"
    },
    {
      "mint": "THREEsynthetic1111111111111111111111111111",
      "symbol": "SYNTH",
      "name": "Synthetic",
      "amount": 500,
      "usd": null,
      "logo": null
    }
  ],
  "totalUsd": 376.6,
  "tokenCount": 2,
  "truncated": false,
  "ts": "2026-07-07T00:00:00.000Z",
  "sources": ["solana-rpc", "jupiter-lite"]
}
```

- **`native.usd` / `tokens[].usd`** — USD valuation, or `null` when the asset
  couldn't be priced (a low-liquidity token no source can route). The balance is
  always reported; only the valuation is nullable.
- **`totalUsd`** — sum of every **priced** holding (unpriced ones contribute
  nothing, they don't corrupt the total).
- **`tokenCount`** — total tokens held, even when the returned list is capped.
- **`truncated`** — `true` when the wallet holds more than 200 tokens; the list is
  sorted by USD value descending and cut at 200, so the meaningful holdings survive.
- **`stale`** — present and `true` only when every live RPC path failed and the
  endpoint served the wallet's last-known-good snapshot instead of erroring.

### States

- **Invalid / missing `address`** → `400` (`invalid_address` / `missing_address`)
  with an `example`.
- **Unsupported `chain`** → `400 unsupported_chain` (lists supported chains).
- **Empty wallet** → `200` with `amount: 0`, `tokens: []`, `totalUsd: 0`. Not an error.
- **EVM chain, no provider key** → `503 not_configured` (Solana still works keyless).
- **Every upstream RPC down** → `503 upstream_unavailable` + `Retry-After`. Never `500`.
- **Rate-limited** → `429 rate_limited` with `retryAfter`.

### Example

```bash
curl "https://three.ws/api/crypto/wallet?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&chain=solana"
```

---

## `GET/POST /api/crypto/symbol` — Symbol availability

**Use-case.** An agent about to launch a token needs a ticker that won't be lost
among clones. Before it commits a mint, it batch-checks its shortlist here: an
**exact** collision means the name is already taken; a **fuzzy** collision (e.g.
`MOONZ` vs `MOONS`) means the brand gets diluted in aggregator search even when the
exact string is free. Clearing the name here for free is the natural first step
before minting through the paid **Pump Launcher** (`/api/x402/pump-launch`) — clear
the name, then launch.

Fuzzy scoring uses a pg_trgm-style trigram Jaccard similarity — the same
exact-plus-fuzzy model the earlier *paid* `symbol-availability` endpoint ran,
broadened from three.ws's own mint index to the whole market and made free.

### Request

Up to **20** symbols per call. GET takes a comma-separated list; POST takes a JSON
array.

| Param     | Where | Type     | Notes |
|-----------|-------|----------|-------|
| `symbols` | `?symbols=A,B,C` (GET) or body array (POST) | string[] | 1–20 tickers. A leading `$` is stripped; matching is case-insensitive. Required. |
| `chain`   | `?chain=` (GET) or body (POST) | string | Optional. Restrict collisions to one chain (e.g. `solana`). Omit to check every indexed chain. |

### Response

```json
{
  "results": [
    {
      "symbol": "THREE",
      "available": false,
      "exactCollisions": [
        { "symbol": "three", "name": "three.ws", "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump", "chain": "solana" }
      ],
      "fuzzyCollisions": []
    },
    { "symbol": "MOONZ", "available": true, "exactCollisions": [], "fuzzyCollisions": [] }
  ],
  "availableCount": 1,
  "takenCount": 1,
  "chain": "solana",
  "ts": "2026-07-07T00:00:00.000Z"
}
```

- **`available`** — `true` when no exact collision exists, `false` when one does,
  and `null` when the collision source couldn't be reached for that symbol (the
  result carries a `note`, and the response sets `degraded: true`). An outage is
  never reported as a green light.
- **`fuzzyCollisions`** — each carries a `similarity` (0–1); sorted most-similar
  first, capped at 10.
- **`availableCount` / `takenCount`** — counts of `available === true` / `=== false`
  (unverifiable `null` symbols count as neither).

### States

- **No symbols** → `400 missing_symbols` with the cap and an `example`.
- **More than 20 symbols** → `400 too_many_symbols` with the cap.
- **Registry source down** → `200` with `degraded: true`; affected symbols get
  `available: null` + a `note`. Never `500`. Each lookup is retried once and
  keeps its last good DexScreener answer for 10 minutes, so through a throttle
  the result still lists the last known `exactCollisions` / `fuzzyCollisions`
  with `stale: true` (and `available: null`, because availability could not be
  verified live); a fresh answer carries `stale: false`.
- **Rate-limited** → `429 rate_limited` with `RateLimit-*` + `Retry-After` headers.

### Examples

```bash
# GET — comma-separated shortlist, Solana only
curl "https://three.ws/api/crypto/symbol?symbols=THREE,MOONZ,BLERGZ&chain=solana"

# POST — same batch as JSON
curl -s -X POST https://three.ws/api/crypto/symbol \
  -H 'content-type: application/json' \
  -d '{"symbols":["THREE","MOONZ","BLERGZ"],"chain":"solana"}'
```

---

## `GET /api/crypto/trending` — Trending / hot tokens

**Use-case.** A *discovery agent* needs "what's hot right now" — tokens ranked by
momentum so it can surface opportunities, fire alerts, or shortlist candidates to
research, without scraping five sites and inventing its own score. One call
replaces polling pump.fun, a DEX aggregator, and a smart-money tracker and
reconciling their formats.

### Request

| Param    | Type | Default | Notes |
|----------|------|---------|-------|
| `window` | enum | `1h`    | `5m` \| `1h` \| `24h` — the trade window the momentum score measures. |
| `limit`  | int  | `20`    | `1`–`50` (capped at 50). |
| `source` | enum | `all`   | `pumpfun` restricts to the pump.fun board; `all` fuses every source. |

### Response

```json
{
  "window": "1h",
  "tokens": [
    {
      "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
      "symbol": "THREE",
      "name": "three.ws",
      "marketCapUsd": 412000,
      "volumeUsd": 32679.02,
      "change": 12.4,
      "score": 75.97,
      "url": "https://pump.fun/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"
    }
  ],
  "count": 1,
  "ts": "2026-07-07T00:22:11.083Z",
  "sources": ["pumpfun", "dexscreener"],
  "note": "Partial data: gmgn unavailable; ranked from pumpfun, dexscreener."
}
```

- **`tokens`** — ordered by `score` descending.
- **`change`** — price change **%** over the window; `null` where an upstream
  doesn't expose it (pump.fun's swap feed carries no per-window %).
- **`sources`** — which upstreams actually contributed to this ranking.
- **`note`** — present only when a source was down or the whole set is empty.

### The ranking signal

`score` is a **0–100 momentum score**, not a measure of raw size — a small coin
with a fresh volume spike and heavy buying outranks a large, quiet one. Each token
is reduced to up to four features, **normalized within its own source** so the very
different volume scales of pump.fun vs a DEX board don't distort the blend:

| Feature       | Weight | Meaning |
|---------------|--------|---------|
| Volume share  | 0.45   | `volumeUsd` relative to the busiest token in that source. |
| Buy dominance | 0.25   | Buy pressure above 50/50, from real trade/txn counts. |
| Volume spike  | 0.20   | `volumeUsd ÷ median(peers)`, saturating at 3× — the same robust peer-median an anomaly verdict uses. |
| Price change  | 0.10   | Positive % change over the window, saturating at +50%. |

The score is the weighted sum over the features actually present, divided by the
sum of the present weights — so a source that can't supply one signal is scored on
what it has rather than penalized. Signals are composed from the platform's
existing scoring primitives (`scorePressure`, `summarizeWindowUsd`, `median`); see
[`api/_lib/crypto-trending.js`](../api/_lib/crypto-trending.js).

**Sources fused (all keyless):**

- **pump.fun** — live board + per-coin swap trades (windowed USD volume + buy pressure).
- **DexScreener** — boosted-token board (24h volume, 1h/24h price change, buy/sell txns).
- **GMGN** — smart-money rank, *best-effort*: serverless egress IPs are frequently
  Cloudflare-blocked, so it usually contributes nothing and is simply omitted from
  `sources` — never an error.

### States

- **A source is down** → `200` with whatever ranked data is available, plus a `note`.
- **Everything down** → `200` with `tokens: []`, `sources: []`, and a retry note. Never `500`.
  The same shape answers a window in which nothing qualified, so the note names both
  possibilities rather than blaming an upstream that may be healthy.
- **pump.fun rate-limited us** → the board and trade pulls are shared through a short
  cache with a last-known-good tier ([`api/_lib/pump-feed-fetch.js`](../api/_lib/pump-feed-fetch.js)),
  so consecutive calls across `5m`/`1h`/`24h` reuse one set of pulls instead of each
  re-fetching every coin and tripping the upstream limiter. Trade rows keep their own
  timestamps, so a windowed volume built from cached rows stays arithmetically honest.
- **Bad `window`/`source`** → coerced to the default. **`limit` > 50** → capped at 50.
- **Rate-limited** → `429` with `RateLimit-*` + `Retry-After` headers.

### Examples

```bash
# Top 5 hottest tokens across all sources, last hour
curl -s "https://three.ws/api/crypto/trending?window=1h&limit=5&source=all"

# pump.fun only, 24h window
curl -s "https://three.ws/api/crypto/trending?window=24h&source=pumpfun"
```

---

## `GET /api/crypto/token` — Token snapshot

**Use-case.** A *trading or research agent* holds a contract address — from a
signal, a mention, a whale buy — and must decide **buy, alert, or ignore** before
acting. Today that means juggling DexScreener + an RPC + a price API and
reconciling three formats. This is one free call that returns the token's whole
current market state, with honest `null`s for anything no live source can resolve.

### Request

| Param     | Type   | Default  | Notes |
|-----------|--------|----------|-------|
| `address` | string | required | Token contract address — Solana base58 mint or EVM `0x` contract. |
| `chain`   | string | inferred | Optional chain pin (`solana`, `ethereum`, `base`, `bsc`, …). Inferred from the address shape when omitted; for an EVM contract deployed on several chains it selects that chain instead of the deepest pool overall. Aliases `sol`/`eth` accepted. |

### Response

Stable schema — **every key is always present**; a field that couldn't be
resolved is `null`, never omitted, never fabricated.

```json
{
  "address": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
  "chain": "solana",
  "name": "three.ws",
  "symbol": "three",
  "priceUsd": 0.001653,
  "change24h": 19.41,
  "marketCapUsd": 1652862,
  "liquidityUsd": 206627.53,
  "volume24hUsd": 413939.89,
  "fdvUsd": 1652862,
  "pairCreatedAt": "2026-04-29T07:09:01.000Z",
  "dexId": "pumpswap",
  "url": "https://dexscreener.com/solana/…",
  "ts": "2026-07-07T02:30:00.000Z",
  "sources": ["dexscreener"]
}
```

- **`sources`** — which upstreams actually contributed (`dexscreener`,
  `pumpfun`, `helius`), so an agent can reason about freshness and coverage.
- **`note`** — present only when a source was down and the snapshot is partial.

**Sources, in order:** DexScreener prices the deepest pool for the address (any
chain it indexes, keyless). A Solana mint with **no DEX pair yet** — typically a
live pump.fun bonding-curve coin — falls back to pump.fun's public coin record
for name, symbol, market cap, and a pump.fun link. Non-pump SPL mints get
name/symbol enrichment via Helius DAS when the deployment has a key; without one
those fields are simply `null`.

### States

- **Thin data** (new launch, no pair) → `200` with the fields that exist + the rest `null`.
- **Missing/invalid `address`, contradictory `chain`** → `400` with a message + example.
- **Valid address no live source knows** → `400 token_not_found` with a pointer to
  [`/api/crypto/trending`](https://three.ws/api/crypto/trending) for discovery.
- **All upstreams unreachable** → `503` + `Retry-After` (never a false not-found, never `500`).
- **Rate-limited** → `429` with `RateLimit-*` + `Retry-After` headers.

### Examples

```bash
# Full snapshot of $THREE by mint (chain inferred)
curl -s "https://three.ws/api/crypto/token?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"

# Pin a multi-chain EVM contract to one chain
curl -s "https://three.ws/api/crypto/token?address=0x<evm-contract>&chain=base"
```

---

## `GET /api/crypto/security` — Token security / rug signals

**Use-case.** Before a *trading agent* buys — or an *LP agent* provides liquidity
into — a token, it needs a fast "is this a honeypot / rug?" read. This is the
single most-requested pre-trade check in crypto agent workflows. One keyless GET
returns the on-chain FACTS (authority status, holder concentration, liquidity,
metadata mutability, LP custody) and a **documented, deterministic** `riskLevel` —
never an LLM opinion, and an unknown is reported as `null`/`unknown`, never
guessed as "safe".

Solana-only by design: SPL mint/freeze authorities and
`getTokenLargestAccounts` have no EVM equivalent in this reader, so an EVM
address gets an honest `400` instead of a half-built passthrough.

### Request

| Param     | Type   | Default  | Notes |
|-----------|--------|----------|-------|
| `address` | string | required | Solana token mint (base58). |
| `chain`   | enum   | `solana` | Only `solana` (alias `sol`) is accepted. |

### Response

```json
{
  "address": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
  "chain": "solana",
  "checks": {
    "mintAuthorityRevoked": true,
    "freezeAuthorityRevoked": true,
    "metadataMutable": false,
    "lpBurnedOrLocked": true,
    "liquidityUsd": 215506.18,
    "topHolderPctFlag": false
  },
  "riskLevel": "low",
  "reasons": [
    "mint and freeze authorities are revoked, holders are not concentrated, and liquidity is healthy"
  ],
  "ts": "2026-07-07T02:56:48.691Z",
  "sources": ["solana-rpc", "dexscreener", "pumpfun"]
}
```

### The checks

| Check | Fact it reports | Source |
|-------|-----------------|--------|
| `mintAuthorityRevoked` | Nobody can mint new supply (`null` authority on the mint account). `false` = the deployer can still print. | Solana RPC `getAccountInfo` (SPL **and** Token-2022 mints) |
| `freezeAuthorityRevoked` | Nobody can freeze holders' token accounts. `false` = a classic honeypot lever. | Solana RPC |
| `metadataMutable` | Whether the token's name/symbol/image can still be rewritten. Token-2022 mints are read from the embedded token-metadata extension's update authority (pump.fun mints work this way — there is **no Metaplex PDA** for them); classic SPL mints from the Metaplex metadata account's `is_mutable`. | Solana RPC |
| `lpBurnedOrLocked` | LP custody. Only assertable as a **protocol fact** for pump.fun-native coins: on-curve liquidity is custodied by the bonding-curve program, and graduation burns the LP (Raydium) or moves it to a protocol-owned pool (PumpSwap) — the deployer cannot pull it either way. Any other token reports `null` (unknown), never a fake "safe". | pump.fun public record |
| `liquidityUsd` | Depth of the deepest indexed pool. | DexScreener |
| `topHolderPctFlag` | `true` when top-1 holder > 20% of supply **or** top-10 > 80% (the same thresholds as the v1 security reader). | Solana RPC `getTokenLargestAccounts` |

### The riskLevel rule (deterministic — no LLM)

Evaluated top-down; the first matching tier wins. `reasons[]` names exactly
which conditions fired, in plain language.

| Level | Rule |
|-------|------|
| `high` | Mint **or** freeze authority still active, **or** concentrated holders (`topHolderPctFlag`) on thin liquidity (< $10,000). |
| `medium` | No live authority lever, but: concentrated holders, **or** liquidity < $10,000, **or** mutable metadata. |
| `low` | Both authorities verifiably revoked **and** no concentration flag **and** liquidity known and ≥ $10,000. |
| `unknown` | The inputs needed to clear `low` are unresolved (e.g. RPC couldn't read the mint or holders) and nothing triggered `high`/`medium`. The unresolved inputs are named in `reasons[]`. |

### States

- **New token, no pool yet** → `200` with `liquidityUsd: null` (and `lpBurnedOrLocked: null`
  unless it's a pump.fun coin); `riskLevel` follows the rule — typically `unknown` or `medium`/`high`.
- **A source is down** → `200`; only that source's checks are `null`, `sources[]` names what answered.
- **Missing/EVM/invalid `address`** → `400` with a clear message + example.
- **Valid mint no live source knows** → `400 token_not_found`.
- **Every source unreachable** → `503` + `Retry-After` — no verdict is ever fabricated during an outage.
- **Rate-limited** → `429` with `RateLimit-*` + `Retry-After` headers.

### Examples

```bash
# Pre-trade check on $THREE
curl -s "https://three.ws/api/crypto/security?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"

# Just the verdict and why
curl -s "https://three.ws/api/crypto/security?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" | jq '{riskLevel, reasons}'
```

---

## `GET /api/crypto/holders` — Holders & concentration

**Use-case.** An *agent sizing a position* needs holder distribution before it
commits: how many holders exist, what share the top wallets control, whether the
dev or insiders still dominate. High concentration = exit risk — the top wallets
can drain the pool before the agent can react. One free call answers it with
real on-chain data.

### Request

| Param     | Type    | Default  | Notes |
|-----------|---------|----------|-------|
| `address` | string  | required | Solana token mint (base58). |
| `chain`   | enum    | `solana` | Only `solana` (alias `sol`) is accepted. |
| `limit`   | integer | `10`     | Top holders to return, `1`–`50` (capped, not an error). |

### Response

```json
{
  "address": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
  "chain": "solana",
  "holderCount": 3241,
  "top": [
    { "owner": "THREEsynthetic1111111111111111111111111111A", "amount": 59968211131,
      "pct": 6.0 }
  ],
  "top10Pct": 22.17,
  "concentration": "low",
  "ts": "2026-07-07T03:05:00.000Z",
  "sources": ["helius-das", "solana-rpc"]
}
```

- **`top[].owner`** — the holder's *wallet*, aggregated across all of its token
  accounts on the keyed path; on the keyless path each entry is one token
  account's resolved owner (or the account address itself if the owner read
  failed, honestly un-aggregated).
- **`top[].amount`** — raw base units. **`pct`** — % of on-chain supply, 2 decimals.
- **`holderCount`** — exact only when the keyed walk enumerated every account;
  `null` otherwise (keyless RPC cannot count holders — it is never guessed).
- LP pools and bonding-curve accounts appear among holders when they genuinely
  hold supply (e.g. an on-curve pump.fun coin's curve account) — real custody,
  reported as-is.

### The concentration rule (documented thresholds)

| Verdict | Rule |
|---------|------|
| `high` | `top10Pct` > 80 |
| `medium` | `top10Pct` > 50 |
| `low` | `top10Pct` ≤ 50 |
| `unknown` | `top10Pct` unresolved |

The 80% bar matches the security endpoint's `topHolderPctFlag`, so the two
surfaces can never contradict each other.

### Sources

- **Keyed (when the deployment has an indexer key):** Helius DAS
  `getTokenAccounts` — pages through the token's accounts and aggregates by
  owner wallet, so a whale split across accounts reads as one holder. Walk
  capped at 5,000 accounts; beyond it `holderCount` is `null` with a `note`.
- **Keyless fallback (always available):** Solana RPC `getTokenLargestAccounts`
  (the chain's top 20 token accounts) + `getMultipleAccounts` to resolve owners
  + the mint's supply for percentages. Coarse but real, and marked in `note`.

### States

- **Brand-new token, zero token accounts** → `200` with `top: []`,
  `concentration: "unknown"`, and a note — a valid empty, not an error.
- **Missing/EVM/invalid `address`** → `400` with a clear message + example.
- **Valid address that isn't an on-chain mint** → `400 token_not_found`.
- **Holder sources unreachable or throttled** → the last good answer for that
  `address` + `limit`, held for 24 hours, served as `200` with `stale: true`,
  `as_of` (when it was computed), and an `x-holders-stale: 1` header; with no
  last good copy, `503` + `Retry-After`. A throttled RPC is never reported as
  "no holders". Never `500`.
- **Rate-limited** → `429` with `RateLimit-*` + `Retry-After` headers.

### Examples

```bash
# Top 10 holders of $THREE with the concentration verdict
curl -s "https://three.ws/api/crypto/holders?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"

# Just the verdict for position sizing
curl -s "https://three.ws/api/crypto/holders?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" | jq '{top10Pct, concentration}'
```

---

## `GET /api/crypto/portfolio` - Portfolio overview

**Use-case.** A *treasury or reporting agent* already has the raw balances from
[`/api/crypto/wallet`](#get-apicryptowallet--wallet-portfolio) and needs the
next layer: how the value splits across stables, majors and everything else,
which assets dominate, and whether the book is up or down on the day. This is
that layer, computed once server-side so every client renders the same numbers.

### Request

| Param     | Type   | Default  | Notes |
|-----------|--------|----------|-------|
| `address` | string | required | Wallet address. Solana base58 or EVM `0x`. |
| `chain`   | enum   | `solana` | `solana` (alias `sol`) or `ethereum` (aliases `eth`, `evm`, `mainnet`). |

### Response

```json
{
  "address": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
  "chain": "solana",
  "totalUsd": 1284.51,
  "unpricedCount": 2,
  "change24h": { "usd": -22.4, "pct": -1.71, "coveragePct": 96.2 },
  "summary": {
    "stable": { "usd": 400.0, "pct": 31.14, "count": 1 },
    "major": { "usd": 800.5, "pct": 62.32, "count": 1 },
    "other": { "usd": 84.01, "pct": 6.54, "count": 3 }
  },
  "topAssets": [
    { "id": "native", "symbol": "SOL", "name": "Solana", "usd": 800.5, "pct": 62.32, "slot": 1, "logo": null }
  ],
  "rows": [
    {
      "id": "native",
      "symbol": "SOL",
      "name": "Solana",
      "kind": "native",
      "class": "major",
      "amount": 10.58,
      "price": 75.66,
      "usd": 800.5,
      "sharePct": 62.32,
      "change24h": -1.78,
      "logo": null
    }
  ],
  "tokenCount": 5,
  "truncated": false,
  "ts": "2026-08-10T16:31:34.527Z",
  "sources": ["solana-rpc", "jupiter-lite", "dexscreener"]
}
```

- **`change24h.coveragePct`** - the share of portfolio value the aggregate move
  actually covers. Tokens beyond the enrichment cap keep `change24h: null` and
  are excluded from the aggregate rather than extrapolated over.
- **`class`** - `stable`, `major` or `other`, so a chart can group without
  re-deriving the taxonomy per client.
- **`sharePct` vs `pct`** - a `rows[]` entry carries its share of the book as
  `sharePct`; the condensed `topAssets[]` entries use `pct`. Read the field the
  array you are in actually publishes.
- **`slot`** - a palette slot per top asset, so the same wallet colors the same
  way across reloads and across surfaces.
- **`stale: true`** - present only when the balance source served a cached read.
  The 24h-change column has its own continuity: each DexScreener batch is
  retried once and keeps its last good pair list for 10 minutes, so a throttle
  no longer blanks every `change24h` in the batch in a way indistinguishable
  from a token that genuinely has none.

### Sources

- **Solana (keyless):** Helius DAS when the deployment has a key, else a public
  RPC walk; prices from Jupiter Lite plus the pump.fun curve; 24h changes from
  DexScreener's batch endpoint (30 mints per call, top 60 holdings) and the
  multi-provider SOL price failover.
- **Ethereum:** the same `getBalances()` EVM path (needs a provider key) - its
  tokens already carry CoinGecko 24h changes.

### States

- **Wallet with holdings** -> `200` with the full overview.
- **Empty wallet** -> `200` with `totalUsd: 0`, empty `rows`/`topAssets` - a
  valid empty, not an error.
- **Missing/invalid `address`, unsupported `chain`** -> `400` with an example.
- **Chain needs a key this deployment lacks** -> `503 not_configured`, naming
  that Solana works keyless.
- **Balance source unreachable** -> `503` + `Retry-After`. Never `500`.
- **Rate-limited** -> `429`.

### Examples

```bash
# Full overview for a Solana wallet
curl -s "https://three.ws/api/crypto/portfolio?address=<wallet>"

# Just the day's move and how much of the book it covers
curl -s "https://three.ws/api/crypto/portfolio?address=<wallet>" | jq '.change24h'
```

---

## `GET /api/crypto/airdrops` - Airdrop eligibility

**Use-case.** A *wallet-strategy agent* wants to know which upcoming airdrops a
wallet is already on track for, and exactly what is missing for the rest. One
call measures the wallet's real on-chain activity and scores it against the live
registry, so the agent can act on the gap instead of guessing at farming advice.

### Request

| Param     | Type   | Default | Notes |
|-----------|--------|---------|-------|
| `address` | string | none    | Wallet to score (Solana base58 or EVM `0x`). Omit it to get the registry alone - the directory view before any lookup. |

### Response

```json
{
  "address": "<wallet>",
  "family": "solana",
  "activity": {
    "family": "solana",
    "tx_count": 412,
    "days_active": 96,
    "account_age_days": 640,
    "unique_tokens": 23,
    "capped": false,
    "chains": ["solana"]
  },
  "opportunities": [
    {
      "id": "jupiter-jupuary",
      "name": "Jupiter",
      "chain": "solana",
      "status": "confirmed",
      "score": 82,
      "eligibility": "qualified",
      "met": [{ "description": "50+ transactions on Solana", "met": true }],
      "missing": [],
      "manual": [{ "description": "Swap through the aggregator and try limit orders" }],
      "estimatedValue": "$100 - $2,000",
      "deadline": null,
      "source": "https://jup.ag"
    }
  ],
  "otherFamily": [],
  "summary": { "tracked": 9, "qualified": 3, "in_progress": 2, "not_eligible": 4, "estimatedValue": "$100 - $2,000" },
  "thresholds": { "qualified": 80, "inProgress": 30 },
  "registryUpdated": "2026-08-06",
  "ts": "2026-08-10T16:31:34.527Z"
}
```

- **`met` / `missing` / `manual`** - criteria that the measured activity clears,
  criteria it does not, and criteria no on-chain read can settle (governance
  votes, off-chain quests). Manual criteria never inflate the score.
- **`otherFamily`** - registry entries for the chain family this address is not
  on, returned unevaluated so a UI can say "check this with your other wallet"
  instead of rendering a fake zero.
- **`eligibility`** - `qualified`, `in_progress` or `not_eligible`, decided by
  the `thresholds` returned alongside it, so the cutoffs are never implicit.

### Sources

- **Solana (keyless):** the rotating RPC chain, for transaction count, active
  days, account age and distinct tokens touched.
- **EVM:** Etherscan V2 behind `ETHERSCAN_API_KEY`.
- **Registry:** [`data/airdrops.json`](../data/airdrops.json), with its
  `updated` date echoed as `registryUpdated`.

### States

- **No `address`** -> `200` with `registry`, `updated` and `thresholds`: the
  directory view. (The scored response echoes the same date as `registryUpdated`.)
- **Scored wallet** -> `200` with activity, opportunities and summary.
- **Invalid address (neither Solana nor EVM)** -> `400`.
- **EVM requested where no explorer key is set** -> `503 not_configured`,
  naming that Solana wallets work keyless.
- **Activity sources unreachable** -> `503` + `Retry-After`. Never `500`.
- **Rate-limited** -> `429`.

### Examples

```bash
# The registry alone, before any wallet lookup
curl -s "https://three.ws/api/crypto/airdrops" | jq '.registry[].name'

# Score a wallet and list only what it already qualifies for
curl -s "https://three.ws/api/crypto/airdrops?address=<wallet>" \
  | jq '.opportunities[] | select(.eligibility == "qualified") | .name'
```

---

## Related

- [Market Data API](/docs/market-data-api) - the paid x402 twin: coin prices, DeFi TVL, yields, gas, and the per-datapoint fabric
- [x402 Paid Endpoints](/docs/x402-endpoints) - the full paid catalog and pricing
- [API Reference](/docs/api-reference) - the complete three.ws HTTP API surface
- [Pump Launcher](/docs/pump-launcher) - launch a token after clearing its symbol here
