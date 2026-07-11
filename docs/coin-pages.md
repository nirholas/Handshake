# Global Markets & Coin Detail Pages

three.ws has always had deep coverage of pump.fun launches (`/launches`,
`/coin-intel`, `/oracle`). The **Markets** surface extends that to the whole
crypto market: a CoinGecko-style index of the top assets, and a rich,
shareable detail page for every coin. The design is adopted from the
[cryptocurrency.cv](https://github.com/nirholas/cryptocurrency.cv) coin pages —
editorial serif headings, hairline borders, mono numerals, light/dark themes.

## The pages

### `/coins` — markets index

- **Global stats bar** — total market cap (with 24h change), 24h volume, the
  top-2 dominance shares, the Fear & Greed index, and the active-coin count.
- **Top coins table** — rank, name, live price, 24h %, 7d %, market cap, 24h
  volume, and a 7-day sparkline per coin. Every column sorts (click or
  Enter/Space on a header); every row links to its detail page. "Load more"
  appends the next 100 ranks.
- **Search** — a debounced type-ahead over the full CoinGecko catalog with
  keyboard navigation (↑/↓/Enter/Escape); selecting a result opens its detail
  page.
- Responsive: lower-priority columns collapse at small widths, the coin-name
  column stays sticky while the table scrolls horizontally.
- **Liquidations pulse** — a strip under the global stats bar showing a
  dominant-side badge (LONG PAIN / SHORT SQUEEZE / BALANCED), 1h long-vs-short
  liquidated USD bars, and the 3 largest recent liquidations, fed by
  `/api/coin/liquidations` and polled every 30s (paused while the tab is
  hidden). Optional enrichment: degrades to a quiet single-line offline state
  — never fabricated data — when its collector isn't reachable. See
  [`services/liquidation-collector/README.md`](../services/liquidation-collector/README.md)
  and [api-reference.md → Liquidations](api-reference.md#liquidations).

### `/coin/:id` — coin detail

`:id` accepts either a CoinGecko slug or a base58 **Solana mint address**
(resolved through the contract lookup).

- **Header** — icon, name, symbol, market-cap-rank badge, live price, and
  24h / 7d / 30d change chips, plus the coin's categories.
- **Interactive chart** — SVG line chart across 24H / 7D / 30D / 90D / 1Y with
  a crosshair tooltip showing exact price and time.
- **Price performance matrix** — colored 1h / 24h / 7d / 14d / 30d / 60d /
  200d / 1y change cells, so the whole return curve is legible at a glance.
- **Market stats** — market cap, 24h volume, circulating/total supply,
  all-time high and low (dated), 24h high/low.
- **Supply** — a circulating-vs-max (or total) supply bar with the percentage
  in circulation, the market-cap / FDV ratio, and 24h market-cap change.
- **All-time high / low** — value and date for each, the drawdown from ATH,
  and the recovery multiple from ATL.
- **Community sentiment** — the CoinGecko bullish/bearish vote split and the
  number of users watching the coin. Hidden when the coin has no votes.
- **Community & development** — Twitter / Reddit / Telegram followings and
  GitHub stars, forks, watchers, issues, merged PRs, contributors, and
  commits in the last four weeks. Each block hides when untracked.
- **Markets** — a paginated exchange-listings table (from
  [`/api/coin/tickers`](../api/coin/tickers.js)): exchange (linking to its
  [detail page](#exchangeid--exchange-detail)), pair (deep-linking to the
  live trade page on that venue), price, spread, +2% / −2% order-book depth,
  24h volume, and a color-coded trust rating. Stale/anomalous rows are dimmed.
- **Related news** — live articles mentioning the coin, from the native
  three.ws aggregator (192 publisher feeds, `api/_lib/news.js`).
- **About + links** — plain-text description, official site / social /
  explorer pills, plus whitepaper, forum, chat, announcement, and extra-repo
  links, and per-chain contract addresses with one-click copy.
- **three.ws integration** — coins with a Solana contract cross-link into
  [Alpha Copilot](/alpha-copilot) and the [live trade feed](/trades). A
  mint-shaped id that isn't on the market data source points to its
  [launch profile](/launches) and [Coin Intelligence](/coin-intel) instead.

The detail endpoint ([`api/coin/detail.js`](../api/coin/detail.js)) requests
CoinGecko's community and developer blocks and slims the multi-hundred-KB
payload to exactly these fields; all-zero developer/community blocks (coins
with no tracked repo or socials) collapse to `null` so the page hides the
whole section rather than render a wall of zeros.

Unknown ids, upstream outages, loading, and empty news/markets all have
designed states — the page never renders a blank void.

## The market tools

Four more surfaces extend Markets, all sharing the same design system
([`src/coin-pages.css`](../src/coin-pages.css)) and real, key-free data. Every
one cross-links back into the markets table and the coin detail pages.

### `/heatmap` — market heatmap

Every top coin as a tile in a squarified treemap, **sized by market cap** and
**colored by its price move** (green up, red down, brightness scaling with the
move). Toggle the color between 24h and 7d, and the set between top 50 and top 100. Hover any tile for a price · 24h · 7d · market-cap tooltip; click it to open
the coin's detail page. The layout is computed client-side from the existing
`/api/coin/markets` feed — no extra endpoint.

### `/fear-greed` — Fear & Greed index

The market's mood as a single 0–100 score on a live semicircle **gauge**, with a
week-over-week delta and its classification (Extreme Fear → Extreme Greed). Below
it, an **interactive history chart** (30D / 90D / 1Y) with a crosshair tooltip,
and a labelled scale. Data is the alternative.me index — the same source the
`/coins` stats bar uses — served through `/api/coin/fear-greed`.

### `/gas` — Ethereum gas tracker

Live Ethereum gas in three tiers (**slow / standard / fast**), each in gwei with
a USD cost estimate, plus a cost-by-action table (ETH transfer, token transfer,
DEX swap, NFT mint). The page auto-refreshes every 15s and pauses when the tab is
hidden. Fees are read straight from the chain — `/api/coin/gas` calls
`eth_feeHistory` on a public RPC (with failover across four providers) and prices
each tier with the live ETH price. No third-party gas API, no key.

### `/compare` — side-by-side comparison

Up to four coins head to head: an **overlay chart** of normalized price
performance (% change from the window start) over 7D / 30D / 90D / 1Y with a
multi-series crosshair, and a **stats table** lining up price, 24h/7d/30d change,
market cap, volume, FDV, supply, and all-time high — the best value per row
highlighted. Add coins with the search type-ahead; the selection is mirrored to
`?ids=…` so any matchup is a shareable link. Reuses `/api/coin/markets` (search),
`/api/coin/detail`, and `/api/coin/ohlc` — no new endpoint.

## More market tools

Eight further tools round out the suite, same design system, same "real key-free
data" rule:

- **`/screener`** — filter the top 250 coins by search, gainers/losers, minimum
  market cap, and minimum 24h volume; every column sorts. Reuses
  `/api/coin/markets` (no new endpoint).
- **`/categories`** — every crypto sector ranked by market cap with 24h change,
  volume, and the top coins in each. New `/api/coin/categories` (CoinGecko
  `/coins/categories`). Each row opens a [category detail
  page](#categoryid--category-detail).
- **`/exchanges`** — top exchanges by trust score and 24h volume (USD, derived
  from the live BTC price). New `/api/coin/exchanges`. Each row opens an
  [exchange detail page](#exchangeid--exchange-detail).
- **`/derivatives`** — perpetual-futures markets: price, funding rate, open
  interest, volume, filterable by index, plus a **Derivatives Exchanges** table
  (open interest, perp/futures counts) whose rows open the exchange detail page.
  `/api/coin/derivatives` (`?view=exchanges` for the venues).
- **`/converter`** — convert any crypto ⇄ any major fiat at live rates
  (USD-anchored math covers all four directions). New `/api/coin/rates`
  (CoinGecko `/exchange_rates`) + `/api/coin/markets`/`detail`.
- **`/defi`** — total DeFi TVL and the top protocols by TVL (CEX reserves
  excluded), category-filterable. New `/api/defi/protocols` (DeFiLlama).
- **`/chains`** — every chain ranked by TVL with a dominance share bar. New
  `/api/defi/chains` (DeFiLlama).
- **`/stablecoins`** — stablecoins by circulating market cap with live peg
  health and backing mechanism. New `/api/defi/stablecoins` (DeFiLlama).
- **`/yields`** — an explorer over ~15,000 live DeFi yield pools: filter by
  chain, project, stablecoin exposure, and minimum TVL; sort by APY or TVL
  (the APY sort ignores sub-$10k dust pools to keep the ranking honest); open
  any row for its full APY + TVL history in a dual-axis chart. Filters sync to
  the URL for shareable views. New `/api/defi/yields` (DeFiLlama
  `yields.llama.fi/pools` + `/chart/{pool}`).

## Detail pages

Beyond `/coin/:id`, two list surfaces now have their own rich detail pages,
reached by clicking a row.

### `/exchange/:id` — exchange detail

A full profile for one exchange (or derivatives venue): logo, trust-score
badge, rank, country, year established, centralized/DEX flag, and description;
stat cards for 24h volume (BTC + USD), **normalized** 24h volume (adjusted to
discount wash trading), markets count, and trust rank; an interactive
BTC-volume history chart (7D–365D, crosshair with BTC + USD); and a markets
table of the venue's pairs (each pair deep-linking to `/coin/:id` and to the
live trade page), with price, spread, 24h volume, and trust. Derivatives venues
show open interest and perp/futures pair counts with a contract table instead.
New `/api/coin/exchange` (CoinGecko `/exchanges/{id}` + `/volume_chart`, falling
back to `/derivatives/exchanges/{id}`).

### `/category/:id` — category detail

A sector page: rank ("#N by market cap"), description, and stat cards for
market cap, 24h change, 24h volume, and share of the categorized market; the
full sortable coins table for that category (reusing the shared markets table,
so every row deep-links to `/coin/:id`); and a strip of related categories.
Reuses `/api/coin/markets?category=<id>` for the table and new
`/api/coin/category` for the header + neighbours.

## News & the markets hub

The suite's news wing and its front door, added 2026-07-10:

### `/markets` — the markets hub

Everything in one place: the global stats bar (market cap, volume, dominance,
Fear & Greed, active coins), **every markets surface as its own hero card**
with live stats hydrated in (top 24h mover on the Heatmap card, current gwei on
Gas, live story count on News, and so on), a sortable **top-100 coins table**,
and a latest-news rail with an archive teaser. Five already-cached endpoints
feed it: `/api/coin/global`, `/api/coin/markets`, `/api/coin/gas`,
`/api/news/feed`, `/api/news/archive?stats=true`.

### `/markets/news` — "Your briefing"

The front page of the news wing, laid out as a daily briefing over headlines
aggregated **natively** by three.ws from the publisher RSS/Atom registry
(CoinDesk, The Block, Decrypt, CoinTelegraph, Blockworks, SEC press, Forkast,
and more — [`api/_lib/news-sources.js`](../api/_lib/news-sources.js)):

- **Primary tabs** — Featured (the majors, via `/api/news/feed?featured=1`),
  Headlines, Trending (the digest's coverage-ranked narratives), DeFi,
  Bitcoin, Ethereum, Analysis, Saved, and All, which unfolds the full
  category registry.
- **Breaking ticker** — stories under 45 minutes old scroll in a marquee
  (paused on hover, static under `prefers-reduced-motion`); hidden when
  nothing is fresh.
- **Today's AI Briefing** — the top digest narratives as a collapsible
  numbered card, linking into `/markets/digest`.
- **Top stories** — a lead-story hero beside a compact headline rail, then
  the Latest grid with offset pagination.
- **Saved stories** — a ☆ on every card bookmarks the article to
  localStorage; the Saved tab renders the collection.
- Debounced search, language + per-source filters, sentiment dots, and ticker
  chips that pivot the feed to that symbol carry over from the flat layout.

Preview images never break: feed images load with `no-referrer`, retry once
through the same-origin `/api/img` proxy, and articles whose feed ships no
image resolve their publisher's `og:image` in the background via
`/api/news/image` — falling back to a designed source-initials tile only when
no preview exists anywhere. Each source is cached server-side for 5 minutes
with serve-stale-on-error, so one dead feed never blanks the page.

### `/markets/news/article` — rich article reader

Opens any story with server-side extraction (`/api/news/article`): full
paragraphs, publisher metadata, an AI summary + key points via the platform
LLM chain (Groq → OpenRouter) with an extractive fallback when no provider key
is present, bullish/bearish/neutral sentiment, detected tickers, and a
related-coverage rail. Publishers that block server fetches degrade through an
honest ladder: page extraction → the publisher's own feed body
(`content:encoded`) → a labelled preview with a read-at-source CTA. Never a
dead end, never fabricated text.

### `/markets/digest` — the day in stories, not headlines

Groups the last N hours of coverage (6h → 72h) into the handful of narratives
that actually moved, each with a summary, a market stance, the tickers
involved, and an expandable list of **every outlet that covered it**. Two real
engines, reported honestly in the response and on the page:

- **`engine: "llm"`** — the platform LLM chain (`api/_lib/llm.js`, free tiers
  first) groups the headlines semantically. Every narrative must cite indices
  that resolve to articles the aggregator actually fetched; a hallucinated
  citation is dropped, and a digest where nothing resolves falls through.
- **`engine: "heuristic"`** — agglomerative clustering on Jaccard similarity
  over each headline's significant tokens plus its detected tickers, with an
  extractive summary from the lead article. Not a placeholder: it produces
  genuine clusters from the same articles, and runs whenever no LLM provider
  key is configured or the chain fails.

Cached 30 min per window in-process; `?refresh=1` regenerates. Backed by
`/api/news/digest`.

### `/markets/archive` — the historical archive

The largest open crypto-news archive: **660,000+ enriched articles from
September 2017 to today** (the CryptoPanic english corpus + the Odaily chinese
corpus + the cryptocurrency.cv live archiver), **kept current by an hourly
archiver** ([`api/cron/news-archive-append.js`](../api/cron/news-archive-append.js),
Cloud Scheduler `17 * * * *`) that appends the live feed's articles to the
current month's JSONL — idempotent by content-addressed id, generation-guarded
against concurrent runs. Every record carries tickers,
tags, sentiment, language, and market context at capture time. Hosted on the platform's own GCS bucket
(`gs://three-ws-news-archive`, public, gzip at rest) as monthly JSONL plus
indexes and corpus stats. The explorer filters by keyword, ticker, source,
date range, sentiment, and language (EN/中文), with year quick-jump buttons and
trending-ticker chips. The API scans months newest→oldest and reports exactly
which months it covered, so the UI can be honest about how deep a search went.

## Where the data comes from

All data is real and fetched at runtime — nothing is hardcoded or sampled:

| Endpoint                | Upstream                                                   | Cache        |
| ----------------------- | ---------------------------------------------------------- | ------------ |
| `/api/coin/detail`      | CoinGecko `/coins/{id}` or `/coins/solana/contract/{mint}` (with community + developer blocks) | 60 s |
| `/api/coin/tickers`     | CoinGecko `/coins/{id}/tickers` (exchange listings, ±2% depth) | 120 s     |
| `/api/coin/ohlc`        | CoinGecko `/coins/{id}/market_chart`                       | 120 s        |
| `/api/coin/markets`     | CoinGecko `/coins/markets` (optional `category=`), `/search` | 60 s / 300 s |
| `/api/coin/categories`  | CoinGecko `/coins/categories`                              | 300 s        |
| `/api/coin/category`    | CoinGecko `/coins/categories` (one category + rank + neighbours) | 600 s   |
| `/api/coin/exchanges`   | CoinGecko `/exchanges` + `/simple/price` (BTC)             | 300 s        |
| `/api/coin/exchange`    | CoinGecko `/exchanges/{id}` (+ `/volume_chart`) or `/derivatives/exchanges/{id}` fallback | 120 s |
| `/api/coin/derivatives` | CoinGecko `/derivatives` (`?view=exchanges` → `/derivatives/exchanges`) | 60 s / 300 s |
| `/api/defi/yields`      | DeFiLlama `yields.llama.fi/pools` (+ `/chart/{pool}`)      | 300 s / 600 s |
| `/api/coin/rates`       | CoinGecko `/exchange_rates`                                | 300 s        |
| `/api/defi/protocols`   | DeFiLlama `/protocols` (CEX excluded)                      | 300 s        |
| `/api/defi/chains`      | DeFiLlama `/v2/chains`                                     | 300 s        |
| `/api/defi/stablecoins` | DeFiLlama `stablecoins.llama.fi/stablecoins`               | 300 s        |
| `/api/coin/global`      | CoinGecko `/global` + alternative.me Fear & Greed          | 120 s        |
| `/api/coin/fear-greed`  | alternative.me `/fng` (current + history)                  | 300 s        |
| `/api/coin/gas`         | public Ethereum RPC `eth_feeHistory` + CoinGecko ETH price | 15 s         |
| `/api/coin/news`        | native aggregator (`api/_lib/news.js`, 192 publisher feeds) | 300 s        |
| `/api/news/feed`        | native aggregator — 38 publisher RSS/Atom feeds, per-source cache + serve-stale | 120 s |
| `/api/news/article`     | publisher page fetch (SSRF-guarded) → publisher feed body → preview; LLM analysis via Groq/OpenRouter with extractive fallback | 1800 s |
| `/api/news/archive`     | `gs://three-ws-news-archive` (662k-article JSONL corpus + indexes on GCS) | 300 s / 3600 s |
| `/api/coin/liquidations`| `services/liquidation-collector` (Binance/Bybit/OKX public liquidation WebSocket streams) | 15 s, `503` no-fallback offline |

Full request/response shapes: [api-reference.md → Coin Market Data API](api-reference.md#coin-market-data-api).

The proxies live in [`api/coin/`](../api/coin) over the shared
[`api/_lib/coingecko.js`](../api/_lib/coingecko.js) fetcher (optional
`COINGECKO_API_KEY` env lifts the public rate limit; everything works
key-free). Payloads are slimmed server-side — the markets endpoint downsamples
sparklines so 100 rows stay light, and coin descriptions are stripped to plain
text before they reach the client.

## Code map

| Piece                       | Location                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Markets page                | [`pages/coins.html`](../pages/coins.html) + [`src/coins-index.js`](../src/coins-index.js)                                                |
| Detail page                 | [`pages/coin.html`](../pages/coin.html) + [`src/coin-page.js`](../src/coin-page.js)                                                      |
| Heatmap                     | [`pages/heatmap.html`](../pages/heatmap.html) + [`src/heatmap.js`](../src/heatmap.js)                                                    |
| Fear & Greed                | [`pages/fear-greed.html`](../pages/fear-greed.html) + [`src/fear-greed.js`](../src/fear-greed.js)                                        |
| Gas tracker                 | [`pages/gas.html`](../pages/gas.html) + [`src/gas.js`](../src/gas.js)                                                                    |
| Compare                     | [`pages/compare.html`](../pages/compare.html) + [`src/compare.js`](../src/compare.js)                                                    |
| Screener / Categories       | `pages/screener.html`, `pages/categories.html` (+ `src/*.js`, `src/*.css`)                                                               |
| Category detail             | [`pages/category.html`](../pages/category.html) + `src/category-page.js` + `src/category-page.css`, API [`api/coin/category.js`](../api/coin/category.js) |
| Exchanges / Derivatives     | `pages/exchanges.html`, `pages/derivatives.html` (+ `src/*.js`, `src/*.css`)                                                             |
| Exchange detail             | [`pages/exchange.html`](../pages/exchange.html) + `src/exchange-page.js` + `src/exchange-page.css`, API [`api/coin/exchange.js`](../api/coin/exchange.js) |
| Converter                   | `pages/converter.html` + `src/converter.js` + `src/converter.css`                                                                        |
| DeFi / Chains / Stablecoins | `pages/{defi,chains,stablecoins}.html` (+ `src/*.js`, `src/*.css`), APIs in [`api/defi/`](../api/defi)                                   |
| DeFi Yields                 | [`pages/yields.html`](../pages/yields.html) + `src/yields.js` + `src/yields.css`, API [`api/defi/yields.js`](../api/defi/yields.js)      |
| Markets hub                 | [`pages/markets.html`](../pages/markets.html) + [`src/markets-page.js`](../src/markets-page.js)                                          |
| Crypto news                 | [`pages/markets-news.html`](../pages/markets-news.html) + [`src/markets-news.js`](../src/markets-news.js)                                |
| Article reader              | [`pages/news-article.html`](../pages/news-article.html) + [`src/news-article.js`](../src/news-article.js)                                |
| News archive                | [`pages/news-archive.html`](../pages/news-archive.html) + [`src/news-archive.js`](../src/news-archive.js)                                |
| News engine + sources       | [`api/_lib/news.js`](../api/_lib/news.js) + [`api/_lib/news-sources.js`](../api/_lib/news-sources.js), endpoints in [`api/news/`](../api/news) |
| Shared news renderers       | [`src/shared/news-render.js`](../src/shared/news-render.js); table primitives in [`src/shared/market-table.js`](../src/shared/market-table.js) |
| Shared design system        | [`src/coin-pages.css`](../src/coin-pages.css) (Source Serif 4 self-hosted in `public/fonts/`)                                            |
| Shared formatters           | [`src/shared/coin-format.js`](../src/shared/coin-format.js) — unit-tested in [`tests/coin-format.test.js`](../tests/coin-format.test.js) |
| API proxies                 | [`api/coin/`](../api/coin) — `detail.js`, `ohlc.js`, `markets.js`, `global.js`, `fear-greed.js`, `gas.js`, `news.js`, `liquidations.js`  |
| Liquidations collector      | [`services/liquidation-collector/`](../services/liquidation-collector) — standalone always-on Node service (not a Vercel function)      |

Routing: `vercel.json` rewrites `/coins`, `/coin/<id>`, `/heatmap`,
`/fear-greed`, `/gas`, and `/compare` to their pages in production; the Vite dev
server mirrors each (including the dynamic `/coin/:id` path). The pre-existing
`/coin` (no id) redirect to `/demo/coin` is untouched.
