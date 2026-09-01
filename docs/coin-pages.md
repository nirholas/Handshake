# Global Markets & Coin Detail Pages

three.ws has always had deep coverage of pump.fun launches (`/launches`,
`/coin-intel`, `/oracle`). The **Markets** surface extends that to the whole
crypto market: a CoinGecko-style index of the top assets, and a rich,
shareable detail page for every coin. The design is adopted from the
[cryptocurrency.cv](https://github.com/nirholas/cryptocurrency.cv) coin pages —
editorial headings, hairline borders, mono numerals, light/dark themes (the
port's Source Serif 4 headings were retired 2026-07 for the sitewide Space
Grotesk display face).

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
- **Interactive chart with a source switcher** — the default is a lightweight
  native SVG line chart across 24H / 7D / 30D / 90D / 1Y (data by CoinGecko)
  with a crosshair tooltip showing exact price and time. A pill switcher next
  to the time ranges swaps in a full third-party terminal, and each option only
  appears when it can actually chart the coin:
  - **CoinGecko** — the native line chart (always available).
  - **TradingView** — the advanced candlestick widget (indicators, drawing
    tools), for any coin with a ticker symbol.
  - **DexScreener** — the on-chain terminal keyed by the token's contract
    address, for coins with a Solana mint or a supported EVM contract.
  - **GeckoTerminal** — the on-chain terminal keyed by the token's most-liquid
    pool, resolved server-side via `GET /api/coin/pool` (below).

  The picked source is remembered across coins and visits (localStorage
  `tws_coin_chart_source`), and the embeds follow the site's light/dark theme.

  A third-party terminal that never renders is caught, not left as an empty
  box: [`src/shared/embed-guard.js`](../src/shared/embed-guard.js) gives each
  embed a 12 s deadline (started when it first scrolls into view, since a lazy
  iframe below the fold has not begun loading), and a TradingView script that
  is blocked outright or loads without ever injecting its chart trips the same
  path. The panel that replaces it says the provider did not load (an ad
  blocker, an extension or the network usually ate it), links to the same
  chart on the provider's own site, and offers a "Try again" that remounts the
  embed.
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
  three.ws aggregator (`api/_lib/news.js`; 197 publisher feeds in the
  `api/_lib/news-sources.js` registry).
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
whole section rather than render a wall of zeros. A single follower count of
exactly 0 is treated the same way: it means the channel isn't tracked, not that
it's empty (Solana's subreddit has ~170k members and still reports 0), so the
stat is omitted rather than stated falsely. Developer counters keep their
zeros — "0 commits in 4 weeks" is a real reading about a real repo.

Unknown ids, upstream outages, loading, and empty news/markets all have
designed states — the page never renders a blank void. When a datapoint is
answered by a backup provider, the page footer names it ("Served from
CoinPaprika") so a missing field reads as *degraded right now* rather than
*this coin has no FDV*.

## Data sources & failover

No market datapoint depends on a single upstream. CoinGecko's keyless tier
rate-limits hard under load, so the reads that used to blank on a CoinGecko blip
now fail over across free, keyless public APIs before surfacing an error, all
through the shared [`failover-fetch`](../src/shared/failover-fetch.js) primitive
(a dead upstream is skipped, cooled down for a minute, and the chain moves on):

- **Global stats bar** (`/api/coin/global`) — CoinGecko → CoinPaprika → CoinLore.
  Each is normalized to the same shape in
  [`api/_lib/market-fallbacks.js`](../api/_lib/market-fallbacks.js); a fallback
  that only carries BTC dominance (CoinPaprika) simply shows one dominance chip.
  The Fear & Greed reading is fetched with one retry and keeps its last good
  value for a day (the index updates once daily), so an alternative.me blip
  never blanks the gauge.
- **Market table** (`/api/coin/markets`) — CoinGecko → CoinLore. CoinLore backs
  up the ranked top-N list (7d sparklines and category scoping stay
  CoinGecko-only and degrade to an empty chart / CoinGecko-only when it's down).
- **Headline prices** — the ETH figure on `/gas` and the BTC figure on
  `/exchanges` fail over CoinGecko → DefiLlama (keyed by the same CoinGecko id),
  then to live exchange tickers (Kraken → Coinbase → Bitfinex) for the mapped
  majors (BTC, ETH, SOL).
- **Coin profile** (`/api/coin/detail`) — CoinGecko `/coins/{id}` → CoinPaprika
  ([`api/_lib/coin-fallbacks.js`](../api/_lib/coin-fallbacks.js)). CoinPaprika
  uses its own `<symbol>-<name-slug>` ids, so the module resolves the CoinGecko
  id in two stages and caches the result for a week. First an exact id-slug or
  name-slug match (`solana` → `sol-solana`), which covers a little over half the
  top 50. The rest miss because the two catalogues list the same asset under
  different names — one by ticker, the other by product name, or one with a
  disambiguating suffix. For those, identity is **proven, not guessed**:
  DefiLlama supplies the authoritative
  symbol and price for the requested CoinGecko id, and a same-symbol candidate is
  accepted only when its own price agrees within 2%. Two different coins sharing
  a ticker and a price to within 2% is vanishingly unlikely, so agreement is
  evidence; a name heuristic would only be a hunch, and serving a *different*
  coin's market cap is worse than serving an error. Fields this source doesn't
  carry (FDV, 24h high/low, developer stats, per-chain contract addresses) come
  back `null` and the page hides those sections. Circulating supply isn't
  published either, but market cap ÷ price recovers it exactly. The lookup by
  Solana mint (`?contract=`) has no fallback: CoinPaprika is addressed by coin
  id, not by mint.
- **Exchange listings** (`/api/coin/tickers`) — CoinGecko `/coins/{id}/tickers`
  → CoinPaprika `/coins/{id}/markets`. Derivatives venues are filtered out (the
  CoinGecko endpoint it stands in for is spot-only, and perps would otherwise
  head the table by volume). Spread and ±2% order-book depth don't exist in this
  feed, so the client drops those three columns rather than render a wall of
  em-dashes.
- **Price chart** (`/api/coin/ohlc`) — CoinGecko `market_chart`, backed up for
  BTC/ETH/SOL by exchange candles (Kraken OHLC → Coinbase Exchange) — real trade
  prints, so they lead — and for **every other coin** by DefiLlama's coins
  oracle, which is addressed as `coingecko:<id>` and therefore needs no id
  mapping at all. The long tail keeps its chart through a CoinGecko outage
  instead of blanking. A 404 (unknown coin) never falls back: that is an answer.
- **Derivatives table** (`/api/coin/derivatives`) — CoinGecko's cross-venue perp
  feed, falling back to Hyperliquid's keyless info API
  ([`api/_lib/hyperliquid.js`](../api/_lib/hyperliquid.js)): one venue instead of
  dozens, but live price/funding/OI/volume for ~200 perps beats a 502. Because
  no other venue reports the same contracts, each Hyperliquid info query is
  retried once and keeps its last good answer for ten minutes (keyed by the
  query body), so a throw there never empties the derivatives view. The
  response carries a `source` marker. Riding alongside whichever source answered
  is a `deribit` block ([`api/_lib/deribit.js`](../api/_lib/deribit.js)): index
  prices, funding-carrying perp tickers, and per-asset options aggregates from
  Deribit's keyless public API. It is fetched in parallel and fails soft to
  `null`, so an unreachable Deribit never delays or blanks the perp table.
- **SOL spot** — seven sources server-side (CoinGecko, Jupiter, Kraken,
  Coinbase, DefiLlama, DIA, Bitfinex) and four browser-side, CORS-safe ones.
- **Solana token panels**: Birdeye → Tokens API → DexScreener → GeckoTerminal →
  DefiLlama → Raydium (see
  [`api/_lib/market/token-market.js`](../api/_lib/market/token-market.js)).
  The Tokens API rung (`api.tokens.xyz`, the Solana Foundation's canonical asset
  index) carries the same full field set as Birdeye, holder count and
  circulating supply included, so it is a like-for-like second rather than a
  degraded fallback; it sits behind Birdeye only because Birdeye is our own
  direct read. The Raydium rung is price-only and covers only Raydium-pooled
  tokens, but it indexes its own AMM, so it stays up when every aggregator is
  rate-limited.
- **Trending** (`/api/coin/trending`) — CoinGecko `/search/trending` → GeckoTerminal
  on-chain trending. CoinGecko ranks by search interest across all chains; the
  free fallback ranks by on-chain pool activity, scoped to Solana so every
  token's mint resolves on the `/coin/:id` detail page. It's a different signal
  (the response carries a `source` marker so the client can badge it) and only
  fills the coins list — categories and NFTs have no on-chain analogue and come
  back empty, which the page hides. A populated list still beats a blank page.

Every fallback is free and keyless (Binance, Bybit and OKX are excluded — they
geo-block US datacenter IPs, so from Cloud Run they would be permanently dead
rungs).

### Budgeting the CoinPaprika rungs

**CoinPaprika's free tier allows 60 requests per hour** (25k/month) and returns
`402 payment_required` with a one-hour block once that is spent. A fallback is
hot exactly when CoinGecko is throttling, which is the worst possible moment to
burn the only other profile source — so the per-coin rungs are budgeted rather
than called per request:

- **Normalized payloads are cached in the shared cache for 120s.** One round-trip
  serves the whole fleet for the window, so 500 visitors to `/coin/solana` during
  an outage cost one request, not 500. This is what makes the budget survivable.
- **Concurrent misses single-flight.** A cold cache under load resolves to one
  upstream call, not one per in-flight request.
- **The id mapping is cached for a week**, so a coin costs its resolution once.
- **Paging is served from the cached response** — CoinPaprika returns every market
  in one payload, so "Load more exchanges" spends nothing.
- **A 402/429 benches the source for an hour.** A spent budget then costs zero
  further requests instead of one wasted round-trip per request until it resets.

DefiLlama carries no comparable limit and is addressed by CoinGecko id, which is
why it — not CoinPaprika — takes the high-volume chart job.

## The market tools

Five more surfaces extend Markets, all sharing the same design system
([`src/coin-pages.css`](../src/coin-pages.css)) and real, key-free data. Every
one cross-links back into the markets table and the coin detail pages.

### `/heatmap` — market heatmap

Every top coin as a tile in a squarified treemap, **sized by market cap** and
**colored by its price move** (green up, red down, brightness scaling with the
move). Toggle the color between 24h and 7d, and the set between top 50 and top 100. Hover any tile for a price · 24h · 7d · market-cap tooltip; click it to open
the coin's detail page. The layout is computed client-side from the existing
`/api/coin/markets` feed — no extra endpoint.

### `/fear-greed` — Fear & Greed index

The market's mood as a single 0 to 100 score on a live semicircle **gauge**, with
a week-over-week delta and its classification (Extreme Fear → Extreme Greed).
The delta is only drawn when the requested window actually contains a reading a
full week old: otherwise `previous_week` comes back null and the page omits the
comparison rather than score the current reading against itself. Below
it, an **interactive history chart** (30D / 90D / 1Y) with a crosshair tooltip,
and a labelled scale. Data is the alternative.me index — the same source the
`/coins` stats bar uses — served through `/api/coin/fear-greed`.

### `/gas` — Ethereum gas tracker

Live Ethereum gas in three tiers (**slow / standard / fast**), each in gwei with
a USD cost estimate, plus a cost-by-action table (ETH transfer, token transfer,
DEX swap, NFT mint). The page auto-refreshes every 15s and pauses when the tab is
hidden. Fees are read straight from the chain — `/api/coin/gas` calls
`eth_feeHistory` on a public RPC (with failover across four providers) and prices
each tier with the live ETH price (CoinGecko → DefiLlama failover). No
third-party gas API, no key.

### `/screener`: the Token Screener

A live filtering workbench over the **top 250 coins by market cap**. The page
loads the whole set once (`/api/coin/markets?page=1&per_page=250`, the same
cached endpoint behind the markets table, so no new endpoint), then every
keystroke, filter change, and sort runs instantly in the browser with no
further network traffic.

The filter controls, all composable (a coin must pass every active one):

- **Search**: a debounced (200 ms) substring match against name and symbol.
- **Direction**: an All / Gainers / Losers segmented control. Gainers keeps
  only coins whose 24h change is above zero, Losers only those below; a coin
  flat at exactly 0 matches neither.
- **Min market cap**: Any, $10M+, $100M+, $1B+, $10B+, $100B+.
- **Min 24h volume**: Any, $1M+, $10M+, $100M+, $1B+.
- **Reset** restores every control and the default sort in one click (the
  zero-results empty state offers the same reset inline).

The results table reuses the shared `cv-table` pattern from the markets index:
rank, coin (icon, name, symbol), price, 24h %, 7d %, market cap, and 24h
volume. **Every column sorts**: click a header, or focus it and press
Enter/Space (headers are keyboard-reachable and announce `aria-sort`). The
first activation sorts name and rank ascending and every numeric column
descending; activating the already-active column flips the direction. Rows
link to their [`/coin/:id`](#coinid--coin-detail) detail page, and clicking
anywhere on a row navigates. A live match counter ("N of 250 coins",
`aria-live`) and an "Updated HH:MM:SS" stamp keep the state legible, and
lower-priority columns collapse at narrow widths while the coin column stays
readable.

Every state is designed: a 14-row skeleton while the single fetch is in
flight, a plain-language error state when the markets feed is unavailable,
and a zero-match empty state that suggests widening the floors and offers the
one-click reset.

Files: [`pages/screener.html`](../pages/screener.html) (shell, controls, SEO),
[`src/screener.js`](../src/screener.js) (state, filtering, sorting,
rendering), [`src/filter-controls.css`](../src/filter-controls.css) (the
labelled filter row, shared with `/yields`), with shared formatters
from [`src/shared/coin-format.js`](../src/shared/coin-format.js) and the table
pattern from [`src/coins-index.js`](../src/coins-index.js).

### `/compare` — side-by-side comparison

Up to four coins head to head: an **overlay chart** of normalized price
performance (% change from the window start) over 7D / 30D / 90D / 1Y with a
multi-series crosshair and a date axis, and a **stats table** lining up price,
24h/7d/30d change, market cap, volume, FDV, supply, and all-time high. Add coins
with the search type-ahead; the selection is mirrored to `?ids=…` so any matchup
is a shareable link. Reuses `/api/coin/markets` (search), `/api/coin/detail`, and
`/api/coin/ohlc`, no new endpoint.

Three details the table and chart depend on:

- **Sign wins the colour, the row winner wins the weight.** Gains render green
  and losses red; the best value in a row is bold on a tinted cell and carries a
  screen-reader-only "(best)", so a 37% drawdown that happens to be the smallest
  one is never painted as a gain.
- **The overlay is measured, not scaled.** Its viewBox is taken from the panel
  width on every render (and on resize), so a 320 px column draws a full-height
  chart with legible axis labels instead of a squashed desktop chart.
- **A slow range answer is discarded.** Each reload carries a monotonic id;
  clicking 1Y then 7D can no longer paint a year of history under a 7D axis.

## More market tools

Eight further tools round out the suite, same design system, same "real key-free
data" rule:

- **`/screener`**: filter the top 250 coins by search, gainers/losers, minimum
  market cap, and minimum 24h volume; every column sorts. Reuses
  `/api/coin/markets` (no new endpoint). Documented in full in
  [its own section above](#screener-the-token-screener).
- **`/categories`** — every crypto sector ranked by market cap with 24h change,
  volume, and the top coins in each. New `/api/coin/categories` (CoinGecko
  `/coins/categories`). Each row opens a [category detail
  page](#categoryid--category-detail). CoinGecko reports 750+ categories, so the
  table opens with the top 50 and pages in 50 more per click, and the search box
  filters the full set by name or slug before you page. Every column sorts, and
  the three no-rows outcomes read differently: a failed fetch offers a retry that
  refetches, an upstream reporting nothing says so, and a search with no match
  offers to clear itself.
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
  the URL for shareable views; project and chain link to their detail pages.
  New `/api/defi/yields` (DeFiLlama `yields.llama.fi/pools` + `/chart/{pool}`).
- **`/fees`** — fees paid by users and revenue kept by protocols across all of
  DeFi, with 24h/7d/30d totals, an aggregate history chart, and a Fees|Revenue
  toggle. New `/api/defi/fees` (DeFiLlama `/overview/fees`).
- **`/dex-volumes`** — every DEX ranked by volume with 24h/7d totals, 7-day
  change, market share, and an aggregate volume chart. New
  `/api/defi/dex-volumes` (DeFiLlama `/overview/dexs`).
- **`/hacks`** — a searchable database of every major DeFi exploit: amount
  stolen, classification, technique, chains, bridge flag, and source, with
  all-time and trailing-12-month totals. New `/api/defi/hacks` (DeFiLlama
  `/hacks`).
- **`/markets/trending`** — the most-searched coins, categories, and NFTs on
  CoinGecko over the last 24h, auto-refreshing; coins and categories link to
  their detail pages. New `/api/coin/trending` (CoinGecko `/search/trending`).

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

### `/protocol/:slug` — DeFi protocol detail

A full profile for one protocol, reached from a `/defi`, `/fees`,
`/dex-volumes`, or `/yields` row: hero (logo, category, audit badge,
forked-from/parent chips, website + twitter); stat cards for TVL, Mcap/TVL,
24h fees, 24h revenue, and 24h DEX volume (null cards hidden); a full TVL
history chart with 30D/90D/1Y/All ranges and event (hallmark) markers; a
per-chain TVL breakdown (each chain linking to `/chain/:name`); a funding-rounds
table; and a methodology section. New `/api/defi/protocol` (DeFiLlama
`/protocol/{slug}` enriched with `/summary/fees` and `/summary/dexs`).

### `/chain/:name` — chain detail

A per-chain page reached from `/chains`: hero (native token, chain id, rank,
dominance); stat cards for TVL, share of DeFi, stablecoin supply, 24h DEX
volume, 24h fees, and protocol count; interactive TVL, stablecoin-supply, and
DEX-volume history charts; and the top protocols on that chain (each linking to
`/protocol/:slug`). New `/api/defi/chain` (a fan-out over DeFiLlama's chains,
historical-TVL, protocols, stablecoin-charts, and dimensions endpoints).

### `/stablecoin/:id` — stablecoin detail

A per-issuer page reached from `/stablecoins`: hero (peg, mechanism, price with
a basis-point peg-deviation badge, audits, and a cross-link to the coin's
`/coin/:id` market data); circulating-supply history chart; and a per-chain
distribution table (each chain linking to `/chain/:name`). New
`/api/defi/stablecoin` (DeFiLlama `stablecoins.llama.fi/stablecoin/{id}`).

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
LLM chain (`api/_lib/llm.js`, free providers first, paid keys only as a tail
backstop) with an extractive fallback when no provider is reachable,
bullish/bearish/neutral sentiment, detected tickers, and a
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
| `/api/coin/pool`        | GeckoTerminal top-pool lookup by token address (feeds the GeckoTerminal chart embed) | 60 s + 300 s CDN |
| `/api/coin/markets`     | CoinGecko `/coins/markets` (optional `category=`), `/search` | 60 s / 300 s |
| `/api/coin/categories`  | CoinGecko `/coins/categories`                              | 300 s        |
| `/api/coin/category`    | CoinGecko `/coins/categories` (one category + rank + neighbours) | 600 s   |
| `/api/coin/exchanges`   | CoinGecko `/exchanges` + `/simple/price` (BTC)             | 300 s        |
| `/api/coin/exchange`    | CoinGecko `/exchanges/{id}` (+ `/volume_chart`) or `/derivatives/exchanges/{id}` fallback | 120 s |
| `/api/coin/derivatives` | CoinGecko `/derivatives` (`?view=exchanges` → `/derivatives/exchanges`) | 60 s / 300 s |
| `/api/defi/yields`      | DeFiLlama `yields.llama.fi/pools` (+ `/chart/{pool}`)      | 300 s / 600 s |
| `/api/coin/trending`    | CoinGecko `/search/trending` (coins + categories + NFTs)   | 120 s        |
| `/api/defi/protocol`    | DeFiLlama `/protocol/{slug}` (+ `/summary/fees` + `/summary/dexs`) | 300 s |
| `/api/defi/chain`       | DeFiLlama `/v2/chains` + `/v2/historicalChainTvl` + `/protocols` + stablecoin/DEX/fees per chain | 300 s |
| `/api/defi/stablecoin`  | DeFiLlama `stablecoins.llama.fi/stablecoin/{id}`           | 300 s        |
| `/api/defi/fees`        | DeFiLlama `/overview/fees` (`?type=fees\|revenue`)         | 600 s        |
| `/api/defi/dex-volumes` | DeFiLlama `/overview/dexs`                                 | 600 s        |
| `/api/defi/hacks`       | DeFiLlama `/hacks` (exploit database)                      | 600 s        |
| `/api/coin/rates`       | CoinGecko `/exchange_rates`                                | 300 s        |
| `/api/defi/protocols`   | DeFiLlama `/protocols` (CEX excluded)                      | 300 s        |
| `/api/defi/chains`      | DeFiLlama `/v2/chains`                                     | 300 s        |
| `/api/defi/stablecoins` | DeFiLlama `stablecoins.llama.fi/stablecoins`               | 300 s        |
| `/api/coin/global`      | CoinGecko `/global` + alternative.me Fear & Greed          | 120 s        |
| `/api/coin/fear-greed`  | alternative.me `/fng` (current + history)                  | 300 s        |
| `/api/coin/gas`         | public Ethereum RPC `eth_feeHistory` + CoinGecko ETH price | 15 s         |
| `/api/coin/news`        | native aggregator (`api/_lib/news.js`, 197 publisher feeds) | 300 s        |
| `/api/news/feed`        | native aggregator: 197 publisher RSS/Atom feeds (`api/_lib/news-sources.js`), per-source cache + serve-stale | 120 s |
| `/api/news/article`     | publisher page fetch (SSRF-guarded) → publisher feed body → preview; LLM analysis via the platform chain (`api/_lib/llm.js`) with extractive fallback | 1800 s |
| `/api/news/archive`     | `gs://three-ws-news-archive` (662k-article JSONL corpus + indexes on GCS) | 300 s / 3600 s |
| `/api/coin/liquidations`| `services/liquidation-collector` (Binance/Bybit/OKX public liquidation WebSocket streams) | 15 s, `503` no-fallback offline |

The `/api/defi/*` handlers have DeFiLlama as their only upstream, so a TTL
cache alone would still 502 the moment it expired during an outage. Every
DeFiLlama read goes through the shared
[`upstream-fetch`](../api/_lib/upstream-fetch.js) helper (one retry on a
transient failure, `attempts: 2`) and each handler keeps its last good payload
past the TTL: `/api/defi/chain`, `/api/defi/protocol`, `/api/defi/yields` and
`/api/defi/hacks` hold theirs for six hours, the rest for the 30 minutes that
[`mem-cache`](../api/_lib/mem-cache.js)'s `cached()` mirrors every value into
its last-known-good tier. A response served from that copy carries an
`x-three-stale: 1` header so the page can say the numbers are not live rather
than pass them off as current; the header disappears the moment the loader
succeeds again.

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
| DeFi Yields                 | [`pages/yields.html`](../pages/yields.html) + `src/yields.js` + `src/yields.css` + [`src/filter-controls.css`](../src/filter-controls.css), API [`api/defi/yields.js`](../api/defi/yields.js) |
| Protocol detail             | [`pages/protocol.html`](../pages/protocol.html) + `src/protocol-page.js` + `src/protocol-page.css`, API [`api/defi/protocol.js`](../api/defi/protocol.js) |
| Chain detail                | [`pages/chain.html`](../pages/chain.html) + `src/chain-page.js` + `src/chain-page.css`, API [`api/defi/chain.js`](../api/defi/chain.js)  |
| Stablecoin detail           | [`pages/stablecoin.html`](../pages/stablecoin.html) + `src/stablecoin-page.js` + `src/stablecoin-page.css`, API [`api/defi/stablecoin.js`](../api/defi/stablecoin.js) |
| Fees / DEX volumes          | `pages/{fees,dex-volumes}.html` (+ `src/*.js`, `src/*.css`), APIs [`api/defi/fees.js`](../api/defi/fees.js), [`api/defi/dex-volumes.js`](../api/defi/dex-volumes.js) |
| Hacks database              | [`pages/hacks.html`](../pages/hacks.html) + `src/hacks.js` + `src/hacks.css`, API [`api/defi/hacks.js`](../api/defi/hacks.js)            |
| Trending                    | [`pages/markets-trending.html`](../pages/markets-trending.html) + `src/markets-trending.js`, API [`api/coin/trending.js`](../api/coin/trending.js) |
| Markets hub                 | [`pages/markets.html`](../pages/markets.html) + [`src/markets-page.js`](../src/markets-page.js)                                          |
| Crypto news                 | [`pages/markets-news.html`](../pages/markets-news.html) + [`src/markets-news.js`](../src/markets-news.js)                                |
| News digest                 | [`pages/news-digest.html`](../pages/news-digest.html) + [`src/news-digest.js`](../src/news-digest.js), API [`api/news/digest.js`](../api/news/digest.js) |
| Article reader              | [`pages/news-article.html`](../pages/news-article.html) + [`src/news-article.js`](../src/news-article.js)                                |
| News archive                | [`pages/news-archive.html`](../pages/news-archive.html) + [`src/news-archive.js`](../src/news-archive.js)                                |
| News engine + sources       | [`api/_lib/news.js`](../api/_lib/news.js) + [`api/_lib/news-sources.js`](../api/_lib/news-sources.js), endpoints in [`api/news/`](../api/news) |
| Shared news renderers       | [`src/shared/news-render.js`](../src/shared/news-render.js); table primitives in [`src/shared/market-table.js`](../src/shared/market-table.js) |
| Shared design system        | [`src/coin-pages.css`](../src/coin-pages.css) (Inter, Space Grotesk, JetBrains Mono self-hosted in `public/fonts/`)                      |
| Shared formatters           | [`src/shared/coin-format.js`](../src/shared/coin-format.js) — unit-tested in [`tests/coin-format.test.js`](../tests/coin-format.test.js) |
| API proxies                 | [`api/coin/`](../api/coin): one file per `/api/coin/*` endpoint in the table above (`detail.js`, `ohlc.js`, `pool.js`, `markets.js`, `tickers.js`, `categories.js`, `category.js`, `exchanges.js`, `exchange.js`, `derivatives.js`, `rates.js`, `trending.js`, `global.js`, `fear-greed.js`, `gas.js`, `news.js`, `liquidations.js`) |
| Liquidations collector      | [`services/liquidation-collector/`](../services/liquidation-collector) — standalone always-on Node service (not a Vercel function)      |

Routing: `vercel.json` rewrites `/coins`, `/coin/<id>`, `/heatmap`,
`/fear-greed`, `/gas`, and `/compare` to their pages in production; the Vite dev
server mirrors each (including the dynamic `/coin/:id` path). The pre-existing
`/coin` (no id) redirect to `/demo/coin` is untouched.
