# `api/defi/` - DeFi market data endpoints (DeFiLlama-backed)

Read-only DeFi data endpoints behind the /defi section of the markets hub. Each file is its own HTTP route (`api/defi/protocols.js` serves `GET /api/defi/protocols`, see [`api/README.md`](../README.md) for the routing rules). Every handler proxies DeFiLlama's free, keyless APIs (`api.llama.fi`, `yields.llama.fi`, `stablecoins.llama.fi`), slims the multi-MB upstream payloads down to exactly what the page renders, and caches in-memory plus at the CDN. No API key exists anywhere in this directory: the whole surface runs with zero configuration.

Why this layer exists instead of calling DeFiLlama from the browser:

- **Payload shaping.** The raw upstream feeds are enormous (the yields `/pools` feed alone is a multi-MB dump of ~15k pools; a protocol profile carries 2k+ daily TVL points). Every handler returns only the fields its page renders, downsamples chart series server-side, and coerces non-finite numbers to `null` (never NaN in the UI).
- **Data hygiene.** DeFiLlama mixes centralized-exchange custody rows (category "CEX") into `/protocols`; the TVL leaderboard excludes them so Binance/OKX reserves never dwarf actual protocols. Synthetic per-chain TVL keys (`-borrowed`, `-staking`, `-pool2`, `-vesting`) are stripped from chain breakdowns so nothing double-counts. APY sorting enforces a $10k TVL floor so dust pools advertising five-digit APYs on three digits of liquidity never outrank real venues.
- **Caching and dedup.** Every feed is read through [`api/_lib/mem-cache.js`](../_lib/mem-cache.js): an LRU cache with a per-entry TTL (5 to 10 min per feed) and **single-flight de-duplication**, so concurrent misses on the same key share one upstream call instead of stampeding it. That last part is load-bearing here, not a micro-optimization: the feeds run from ~2 MB (dexs) to ~8 MB (protocols), and before it was applied uniformly, 10 concurrent cold requests to `/api/defi/dex-volumes` issued 10 identical upstream fetches. A burst like that arrives exactly when an entry expires under load, which is when the upstream is least willing to absorb it, and a refused burst reaches users as a 502 on a page whose data is fine. Per-slug and per-id lookups (`protocol`, `stablecoin`, `chain`) are LRU-bounded, so a crawl across many keys evicts the coldest entry rather than clearing every warm one. A failed load is never cached, so a transient outage cannot pin an endpoint for a whole TTL. `chain.js` additionally shares one copy of the protocols feed across every chain profile built in its TTL. On top of that, CDN `s-maxage` with `stale-while-revalidate` keeps upstream load at a handful of requests per instance per TTL regardless of traffic.
- **One implementation for free and paid.** The exported builder functions below are reused verbatim by the paid x402 Market Data API ([`api/_lib/market-data/fetch.js`](../_lib/market-data/fetch.js)), so the data agents pay for can never drift from what the site shows.

All endpoints are `GET`, CORS-open, and rate-limited per client IP via [`../_lib/rate-limit.js`](../_lib/rate-limit.js) (the shared `marketDataIp` limiter). Errors follow the platform shape from [`../_lib/http.js`](../_lib/http.js); upstream failures return `502 upstream_error`, never synthetic numbers.

## Endpoints

| Route | Powers | Source |
| --- | --- | --- |
| `GET /api/defi/protocols` | /defi TVL leaderboard (top 100 protocols plus whole-market totals, CEX excluded) | DeFiLlama `/protocols` |
| `GET /api/defi/protocol?slug=<slug>` | /protocol/:slug profile (TVL history, per-chain TVL, fees, revenue, DEX volume, raises, hallmarks, audits) | DeFiLlama `/protocol/{slug}` plus optional `/summary/fees/{slug}` and `/summary/dexs/{slug}` |
| `GET /api/defi/chains` | /chains cross-chain TVL board (top 100 with dominance share) | DeFiLlama `/v2/chains` |
| `GET /api/defi/chain?name=<chain>` | /chain/:name profile (TVL history, top protocols on the chain, stablecoin supply, DEX volume, fees) | DeFiLlama `/v2/chains`, `/v2/historicalChainTvl`, `/protocols`, stablecoin charts, per-chain dexs/fees overviews |
| `GET /api/defi/yields[?chain&project&stablecoin&search&minTvl&sort=tvl\|apy&limit&offset]` | /yields pool explorer (~15k pools, filters, facets, stats) | DeFiLlama `yields.llama.fi/pools` |
| `GET /api/defi/yields?pool=<uuid>` | /yields per-pool APY plus TVL history chart (downsampled to 300 points; unknown pools 404) | DeFiLlama `yields.llama.fi/chart/{pool}` |
| `GET /api/defi/stablecoins` | /stablecoins market-cap board (top 100 with peg health and mechanism) | DeFiLlama `stablecoins.llama.fi/stablecoins` |
| `GET /api/defi/stablecoin?id=<n>` | /stablecoin/:id profile (per-chain circulation, supply history, peg deviation) | DeFiLlama `stablecoins.llama.fi/stablecoin/{id}` |
| `GET /api/defi/dex-volumes` | /dex-volumes rankings (top 100 DEXs by 24h volume, market chart, share of market) | DeFiLlama `/overview/dexs` |
| `GET /api/defi/fees?type=fees\|revenue` | /fees rankings (what users pay vs. what protocols keep, top 100 plus market chart) | DeFiLlama `/overview/fees` |
| `GET /api/defi/hacks[?search&limit&offset]` | /hacks exploit database (searchable incident history plus headline stats) | DeFiLlama `/hacks` |

Frontend consumers live in `src/`: `defi.js`, `protocol-page.js`, `chains.js`, `chain-page.js`, `yields.js`, `stablecoins.js`, `stablecoin-page.js`, `dex-volumes.js`, `fees.js`, `hacks.js`. The public pages (/defi, /chains, /stablecoins, /yields, /fees, /dex-volumes, /hacks) are declared in [`data/pages.json`](../../data/pages.json) and linked from the /markets hub.

## Exports (the paid Market Data API contract)

Beyond their default HTTP handlers, seven modules export their builder functions for the x402 Market Data API ([`api/_lib/market-data/fetch.js`](../_lib/market-data/fetch.js) and [`api/_lib/market-data/datapoints.js`](../_lib/market-data/datapoints.js), documented in [`docs/market-data-api.md`](../../docs/market-data-api.md)):

- [`protocols.js`](./protocols.js) exports `buildProtocols()`, the TVL leaderboard behind the paid market-defi endpoint.
- [`chains.js`](./chains.js) exports `buildChains()`, the cross-chain TVL board behind market-chains.
- [`yields.js`](./yields.js) exports `queryYieldPools({ chain, project, stablecoin, search, minTvl, sort, limit, offset })` (filtered pool explorer), `queryYieldChart(pool)` (single-pool history; throws `{ status, code }` on bad or unknown uuids), and `loadYieldPools()` (the cached full pool set, used by the per-pool datapoint fabric).
- [`stablecoins.js`](./stablecoins.js) exports `buildStablecoins()`, the peg board behind market-stablecoins.
- [`dex-volumes.js`](./dex-volumes.js) exports `buildDexVolumes()`, the DEX rankings behind market-dex-volumes.
- [`fees.js`](./fees.js) exports `buildFees(type)` with `type` either `'fees'` or `'revenue'`.
- [`hacks.js`](./hacks.js) exports `queryHacks({ search, limit, offset })`, the exploit database behind market-hacks.

The three detail handlers (`protocol.js`, `chain.js`, `stablecoin.js`) export only their default HTTP handler.

## Usage

No install step: these deploy with the rest of `api/` and run locally under the dev server (`npm run dev`, port 3000, Vite proxies `/api`). No env vars, required or optional; the DeFiLlama upstreams are keyless.

Example, straight from the route contract at the top of [`yields.js`](./yields.js) (list mode with filters, APY sort, and the $10k TVL dust-pool floor):

```sh
curl -s 'https://three.ws/api/defi/yields?chain=solana&sort=apy&limit=5'
```

Returns `{ "pools": [ 5 Solana pools ordered by APY, each with tvl_usd, apy, apy_base, apy_reward, il_risk, outlook ], "total": <matching pool count>, "facets": { top chains and projects for the dropdowns }, "stats": { pool_count, total_tvl, median_apy }, "updated_at": <ms> }`. Add `?pool=<uuid>` instead for that pool's downsampled APY plus TVL history, or swap the path for any endpoint in the table above.

## Related

- [`api/README.md`](../README.md), how routing, `_lib/`, and crons work across the whole API surface.
- [`api/coin/README.md`](../coin/README.md), the sibling CoinGecko-backed layer serving /coins and the broader markets pages.
- [`docs/market-data-api.md`](../../docs/market-data-api.md), the paid x402 endpoints these builders also power.
- [`STRUCTURE.md`](../../STRUCTURE.md), the map of every product surface.
