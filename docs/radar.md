# Coin Radar: every pump.fun launch, scored in its first 90 seconds

Coin Radar is a live screener for pump.fun. Every new coin appears here with the Coin Intelligence Engine's read of its first roughly 90 seconds of trading: bundle versus organic demand, wallet concentration, dev behaviour, fresh-wallet swarms, and risk flags, plus a 0 to 100 quality score. It answers one question fast, before the candle prints: is this launch real, or is it a coordinated exit dressed up as a crowd?

Page: [/radar](https://three.ws/radar)

API: `/api/pump/coin-intel` (feed, market pulse, per-coin detail). The detail drawer also reads `/api/oracle/coin` for conviction context.

> Naming trap for API users: `/radar` is served by `api/pump/coin-intel.js`, and `/coin-intel` is served by `api/pump/intel.js`. The names look swapped. They are two distinct read models over the same engine.

## Why it exists

The most dangerous moment on pump.fun is the first minute, when the tape is thin and a bundle of bot wallets can manufacture the look of organic demand. A human cannot audit funder graphs and timing entropy in real time. The Coin Intelligence Engine does, on the live firehose, and Radar is its screener: a scannable board that turns raw first-90-seconds behaviour into a quality score and a short list of named risks, so you can filter out the coordinated launches and focus on the ones with a real crowd. It is the top of the [trading surfaces](./trading-surfaces.md) funnel: Radar surfaces a launch worth a look, you watch it, and if it earns conviction you open it in [Mission Control](./terminal.md) to act.

## How it works

The page mounts `mountRadar` from `src/radar.js` and polls `/api/pump/coin-intel` every 12 seconds (paused when the tab is hidden), rendering a market-pulse strip, a filterable grid or list of coins, and a detail drawer. It uses no streaming; it is a REST poller.

The scores are not computed by the API, which is a pure read model over the Postgres table `pump_coin_intel` (plus `pump_coin_wallets` and `pump_coin_outcomes`). They are produced upstream by the engine in `workers/agent-sniper/intel/`. A watcher holds its own PumpPortal websocket, subscribes to each new mint's trades, and observes a **90-second window** (`windowMs = 90_000`) with the creator's launch buy seeded as trade zero. When the window closes, a deterministic, pure signal function scores it and enrichment (classification, funder-graph clustering, smart-money cross-reference) is folded in before the record is persisted. A serverless cron twin shares the exact same finalize path, so records are byte-identical however they were produced.

The core signal math, measured from the first observed trade (burst window 3s, snipe window 5s):

- **Bundle score (0 to 1).** Needs at least 4 buys and 4 in the 3-second burst; blends burst density and clustering (the share of near-identical buy sizes, since bots fund identical amounts), scaled by a wallet multiplier.
- **Organic score (0 to 1).** A weighted blend of buyer diversity, timing entropy, the inverse of bundle, the inverse of snipe ratio, and the inverse of top-1 concentration, then discounted if the dev sold or fresh wallets dominate, and adjusted by funder connectivity.
- **Snipe ratio.** Share of buy volume landing within the first 5 seconds.
- **Concentration.** Per-wallet net buy share; reported as top-1, top-5, and top-10.
- **Dev behaviour.** `dev_sold` is set when the creator had any sell; `dev_buy_sol` comes from the launch transaction.
- **Fresh wallets and clusters.** Fresh-wallet ratio is the share of buyers with at most one prior transaction (null below 3 known); connectivity is the largest common-funder cluster over known funders.

Those roll into a **quality score (0 to 100)**: start from organic times 100, subtract for bundle, top-1 concentration, a dev sell, and fresh-wallet ratio, add a small bonus for unique buyers, then add smart-money bonuses that stack per proven wallet in (+8 for the first, +6 for the second, +4 for the third, up to +18 total), and clamp.

**Risk flags** are named, not numeric: `bundle_launch` (bundle 0.6+), `dev_dumped`, `single_whale` (top-1 0.5+), `low_diversity` (fewer than 5 buyers), `fresh_wallet_swarm` (fresh ratio 0.7+), `sell_pressure`, `sniped` (snipe 0.85+ with fewer than 8 buyers), and `coordinated_cluster` (connectivity 0.4+).

The UI colors quality as Healthy at 70 and up, Mixed from 40 to 69, and High risk below 40; a null score renders "Unscored," never a fake zero.

## Walkthrough

1. Open [/radar](https://three.ws/radar). The pulse strip aggregates the whole tape (24h and 1h observed counts, the healthy/mixed/risky split, smart-money-touched and flagged shares).
2. Use the toolbar to filter by narrative category, drag the minimum-quality slider, toggle smart-money-only or news, and hide flagged coins (a client-side drop of danger-flagged launches). Sort by newest, quality, smart money, buyers, or volume. All filters serialize to the URL for shareable views.
3. Press `/` to focus search and type a name, ticker, or mint. Press `g` or `l` to switch grid and list, `r` to refresh.
4. Click any coin for the drawer: the full signal grid, the top-50 wallet ledger, the smart-money notable roster, the outcome (if labeled), and an asynchronously injected Oracle conviction section.
5. Every mainnet coin links to its full page at `/oracle/coin/<mint>`: the card's "Full intel →" button goes there directly, and the drawer carries an "Open full page →" link in its header. The full page renders in the markets-hub design (the same system as `/coin/:id`) with the live price chart, the complete Launch Intelligence read (this engine's signal grid, risk flags, and trader ledger), Oracle conviction, live market intel, agent transactions, and a live trade tape.
6. On a coin worth tracking, use Watch to add it to your [Watchlist](https://three.ws/watchlist), then open it in [Mission Control](./terminal.md) to trade.

## Examples

The feed is public and IP rate-limited.

```bash
# The radar feed: newest launches with the engine's first-90s read
curl 'https://three.ws/api/pump/coin-intel?limit=60&network=mainnet&sort=new'

# The market-pulse aggregate (independent of your filters)
curl 'https://three.ws/api/pump/coin-intel?stats=1&network=mainnet'

# One coin's full intel plus its top-50 wallet ledger
curl 'https://three.ws/api/pump/coin-intel?mint=<MINT>&wallets=1&network=mainnet'
```

```javascript
// Pull the feed and keep only clean, smart-money-touched launches
const { coins } = await fetch(
  'https://three.ws/api/pump/coin-intel?limit=60&network=mainnet&smart_money=1'
).then((r) => r.json());

const clean = coins.filter(
  (c) => (c.quality_score ?? 0) >= 70 && !(c.risk_flags || []).includes('bundle_launch')
);
console.log(clean.map((c) => `${c.symbol} q${c.quality_score}`));
```

## States and limits

- **Auth.** None. The feed, pulse, and detail reads are fully public over CORS and IP rate-limited (`mcpIp`).
- **No streaming.** Radar polls every 12 seconds and shows a "Live, updated Ns ago" indicator; polling pauses when the tab is hidden and refetches on return.
- **Warm-up.** A coin has no score until its 90-second observation window closes and finalize runs. Coins older than the engine's deploy, or mid-observation, return 404 on the detail read and render a "Not observed" state.
- **Honest nulls.** A signal that was not measured is null and renders "not measured," never a fabricated 0. The market-pulse path degrades to zeros and empties gracefully if the engine tables are cold.
- **Empty and error states.** The board has designed loading (skeleton grid), empty ("Radar is clear, waiting for the next launch"), no-match, and error (with a retry) states. Which of empty and no-match you get is decided by your filters, not by the response shape: most filters (search, category, minimum quality, smart money, news) run server-side, so an over-tight filter comes back as an empty feed, and the board still names it as a filter result. The no-match state lists every active filter as a removable chip, so you can drop the one that is too tight instead of resetting the board. On a silent poll failure it keeps the prior coins and only blanks to an error when nothing is cached.
- **The pulse strip has its own state.** It is a separate request from the feed. If it fails with no earlier value to keep showing, the strip says the 24h aggregate did not load and offers a retry, and the live feed below keeps working; it never sits on a loading shimmer indefinitely.

## Related

- [The trading surfaces: Radar, Mission Control, Live Trade Feed, Watchlist, Coin Intelligence](./trading-surfaces.md)
- [Oracle: the conviction engine](./oracle.md) fuses this intel into a single conviction score
- [Smart Money Radar](./smart-money.md) is the pedigree layer Radar surfaces inline
- [Mission Control](./terminal.md) is where a Radar find gets traded
- [Coin pages](./coin-pages.md) cross-link the per-mint intel and conviction views
- Pages: [/radar](https://three.ws/radar) · [/coin-intel](https://three.ws/coin-intel) · [/watchlist](https://three.ws/watchlist)
