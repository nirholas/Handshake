# `api/coin/` - global crypto market data endpoints

Read-only market-data endpoints behind the /coins section and the Markets tools. Each file is its own HTTP route (`api/coin/markets.js` serves `GET /api/coin/markets`, see [`api/README.md`](../README.md) for the routing rules). Most proxy CoinGecko through the shared helper [`../_lib/coingecko.js`](../_lib/coingecko.js), slim the multi-hundred-KB upstream payloads down to exactly what the page renders, and cache in-memory plus at the CDN.

Why this layer exists instead of calling CoinGecko from the browser:

- **Rate-limit survival.** CoinGecko's keyless/demo tiers cap at roughly 30 req/min. The proxy adds an in-memory cache with a stale buffer, a durable last-good copy in the shared cache, and CDN `s-maxage`, so a throttled upstream serves recent data instead of a blank page.
- **Failover.** The load-bearing datapoints read through [`../_lib/market-fallbacks.js`](../_lib/market-fallbacks.js): CoinGecko first, then CoinPaprika and CoinLore for the stats bar and market table, and Kraken/Coinbase exchange candles for the headline OHLC charts. A single dead upstream no longer blanks /coins.
- **Payload shaping.** Every handler returns only the fields its page renders, coerces non-finite numbers to `null` (never NaN in the UI), and sanitizes upstream HTML descriptions to plain text server-side.

All endpoints are `GET`, CORS-open, and rate-limited per client IP via [`../_lib/rate-limit.js`](../_lib/rate-limit.js). Errors follow the platform shape from [`../_lib/http.js`](../_lib/http.js).

## Endpoints

| Route | Powers | Source |
| --- | --- | --- |
| `GET /api/coin/markets?page&per_page[&category][&q]` | /coins table, /category/:id table, coin search type-ahead | CoinGecko `/coins/markets` and `/search`, CoinLore fallback |
| `GET /api/coin/global` | /coins stats bar (market cap, volume, dominance, Fear & Greed) | CoinGecko, CoinPaprika, CoinLore failover plus alternative.me |
| `GET /api/coin/detail?id=<id>` or `?contract=<solana-mint>` | /coin/:id profile | CoinGecko `/coins/{id}` |
| `GET /api/coin/ohlc?id=<id>&days=<1\|7\|30\|90\|365>` | /coin/:id price chart | CoinGecko `market_chart`, Kraken/Coinbase candle fallback |
| `GET /api/coin/tickers?id=<id>&page=1` | /coin/:id exchange listings table | CoinGecko `/coins/{id}/tickers` |
| `GET /api/coin/pool?address=<token>&network=<net>` | /coin/:id GeckoTerminal chart embed (pool resolution) | GeckoTerminal via [`../_lib/market/ohlcv.js`](../_lib/market/ohlcv.js) |
| `GET /api/coin/news?q=<coin name>&limit=8` | /coin/:id related-news rail | Native aggregator [`../_lib/news.js`](../_lib/news.js) |
| `GET /api/coin/trending` | /markets/trending | CoinGecko `/search/trending` |
| `GET /api/coin/categories` | /categories leaderboard | CoinGecko `/coins/categories` |
| `GET /api/coin/category?id=<slug>` | /category/:id detail | CoinGecko `/coins/categories` (one cached fetch serves all) |
| `GET /api/coin/exchanges` | /exchanges table | CoinGecko `/exchanges`, volumes converted to USD |
| `GET /api/coin/exchange?id=<slug>[&days][&view=chart]` | /exchange/:id detail (spot and derivatives venues) | CoinGecko `/exchanges/{id}` plus `volume_chart` |
| `GET /api/coin/derivatives[?view=exchanges]` | /derivatives (perp contracts and venues) | CoinGecko `/derivatives` |
| `GET /api/coin/fear-greed?limit=<1..365>` | /fear-greed index and history chart | alternative.me `/fng` |
| `GET /api/coin/gas` | /gas Ethereum fee tiers with USD estimates | On-chain `eth_feeHistory` via public RPC, no gas API |
| `GET /api/coin/rates` | /converter fiat rates | CoinGecko `/exchange_rates` |
| `GET /api/coin/liquidations` | /coins liquidations pulse strip | [`services/liquidation-collector`](../../services/liquidation-collector/README.md) |
| `GET /api/coin/:mint/cohorts[?cohort&…]` | Holder cohorts for one agent token (creator-gated export) | Platform DB, see [`[mint]/cohorts.js`](./%5Bmint%5D/cohorts.js) |

Frontend consumers live in `src/`: `coins-index.js`, `coin-page.js`, `markets-page.js`, `markets-trending.js`, `categories.js`, `category-page.js`, `exchanges.js`, `exchange-page.js`, `derivatives.js`, `fear-greed.js`, `gas.js`, `converter.js`, plus the Markets tools `heatmap.js`, `screener.js`, and `compare.js`. The public pages are declared in [`data/pages.json`](../../data/pages.json) (/coins, /heatmap, /screener, /compare, /categories, /exchanges, /derivatives, /fear-greed, /gas, /converter, /markets/trending).

## Shared internals

- [`../_lib/coingecko.js`](../_lib/coingecko.js) exports `geckoFetch(path, { ttlMs, timeoutMs })`, the one CoinGecko fetch: base URL, optional `COINGECKO_API_KEY` (demo tier, works key-free), per-instance memory cache with a 30-minute stale buffer, a durable last-good copy in Upstash, and automatic key benching when an exhausted demo key starts rejecting requests. It throws with `.status` set on non-OK responses so callers can tell 404 (unknown coin, a real answer) from 429/5xx (upstream trouble, serve stale). Also exports `isPlausibleCoinId` and `htmlToText`.
- [`../_lib/market-fallbacks.js`](../_lib/market-fallbacks.js) exports the failover reads: `fetchGlobalMarket()`, `fetchMarketsTable({ page, perPage, category })`, `fetchCoinPriceUsd(coingeckoId)`, and `fetchExchangeChart(id, days)`.
- `markets.js` itself exports `searchCoins(q)`, reused by the paid Market Data API in [`../_lib/market-data/`](../_lib/market-data/) so the x402 market-coins endpoint shares the same id resolver.

## Usage

No install step: these deploy with the rest of `api/` and run locally under the dev server (`npm run dev`, port 3000, Vite proxies `/api`). They work with zero configuration; two env vars are optional:

- `COINGECKO_API_KEY` (demo tier) lifts the public CoinGecko rate limit.
- `LIQUIDATION_COLLECTOR_URL` points at the liquidation collector; unset, `/api/coin/liquidations` answers `503 { "error": "collector_offline" }` and the UI shows its designed offline state. No synthetic numbers, ever.

Example, straight from the route contract at the top of [`markets.js`](./markets.js) (`GET /api/coin/markets?page=1&per_page=100` returns ranked market table rows):

```sh
curl -s 'https://three.ws/api/coin/markets?page=1&per_page=10' | head -c 600
```

Returns `{ "coins": [ { rows with rank, price, 24h change, market cap, downsampled 7d sparkline } ], "page": 1, "per_page": 10, "category": null }`. Add `?q=solana` for the search shape instead, or `&category=layer-1` to scope the table to one CoinGecko category.

`page` and `per_page` are clamped rather than rejected: `page` to 1..20 and `per_page` to 10..250, and the response echoes the clamped values it actually used. So `per_page=5` returns ten rows and reports `"per_page": 10`. `/api/coin/tickers` is the one endpoint here that rejects instead of clamping, because its upstream page ceiling is a real limit rather than a preference: a `page` outside 1..10, or one that is not an integer, answers `400 bad_page`.

## Related

- [`api/README.md`](../README.md), how routing, `_lib/`, and crons work across the whole API surface.
- [`services/liquidation-collector/README.md`](../../services/liquidation-collector/README.md), why the liquidations feed is a standalone long-lived service.
- [`STRUCTURE.md`](../../STRUCTURE.md), the map of every product surface.
