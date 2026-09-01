# The trading surfaces: Radar, Mission Control, Live Trade Feed, Watchlist, Coin Intelligence

The platform's trading stack is spread across five public pages. Four of them are read-only intelligence — they exist to answer "what's launching, what's real, who's winning" — and one, Mission Control, is the actual cockpit where a signed-in user trades from their agent's wallet. This doc explains what each surface is, where its numbers come from, and how they fit together.

The one-line map:

| Surface | Route | What it answers | Trades? |
| --- | --- | --- | --- |
| Coin Radar | [/radar](https://three.ws/radar) | What launched in the last 90 seconds, and is it real? | No |
| Coin Intelligence | [/coin-intel](https://three.ws/coin-intel) | What did the intel engine learn about every launch? | No |
| Live Trade Feed | [/trades](https://three.ws/trades) | Which trades actually won, and what did the winner see? | No |
| Watchlist | [/watchlist](https://three.ws/watchlist) | What are *my* coins doing right now? | Buy via coin card |
| Mission Control | [/terminal](https://three.ws/terminal) | Everything, live — and execute. | Yes, from your agent wallet |

Everything below is public and works signed-out except executing trades in Mission Control, which requires a signed-in account with a trading agent.

## Where the numbers come from

All five surfaces read the same underlying truth: the Coin Intelligence Engine (`workers/agent-sniper/intel`) watches every new pump.fun coin's first ~90 seconds of trading over the live firehose and persists what it saw — bundle patterns, organic demand, wallet concentration, funder clusters — to Postgres (`pump_coin_intel`, `pump_coin_wallets`, `pump_coin_outcomes`, `pump_intel_weights`). Every number on these pages traces to an on-chain trade the engine observed. When a signal wasn't measured for a coin, the UI says "not measured" — it never renders a fake zero.

On top of that base layer:

- **Oracle conviction** ([the conviction engine](oracle.md)) enriches coins across all five surfaces with its 0–100 fused score and tier.
- **Price history** (candlesticks) comes from Birdeye with GeckoTerminal fallback.
- **Live trades** stream over server-sent events from `/api/pump/trades-stream` (PumpPortal websocket, relayed). PumpPortal gates per-coin trade subscriptions behind an API key funded with at least 0.02 SOL; when it refuses one, the socket stays open and simply never delivers, so the relay forwards that refusal as an SSE `notice` event and the tape shows a degraded state instead of a lit "live" lamp over an empty panel. A malformed `mint` is refused up front with `400 invalid_mint`.
- **Smart-money pedigree** comes from the proven-wallet ledger (`/api/intel/smart-money`).

One naming trap for API users: `/radar` is served by `api/pump/coin-intel.js` and `/coin-intel` is served by `api/pump/intel.js`. The names look swapped; they are two distinct read models over the same engine.

## Coin Radar — /radar

The launch screener. Every new pump.fun coin appears here with the engine's first-90-seconds read: buyers, buy volume, snipe ratio, buy/sell ratio, net flow, concentration, and risk flags (`bundle_launch`, `dev_dumped`, `single_whale`, `low_diversity`, `fresh_wallet_swarm`). A market-pulse banner aggregates the whole tape.

What you can do:

- Filter by narrative category (meme / ai / tech / culture / …) and a minimum-quality slider; sort by buyers, buy volume, and more.
- Click any coin for the detail drawer: wallet breakdown, top-trader ledger, the full signal grid, and Oracle conviction.
- **Watch** any coin — one tap adds it to your [Watchlist](#watchlist--watchlist).

The list refreshes every 12 seconds. Fully public, no account.

## Coin Intelligence — /coin-intel

The engine's own notebook, opened to the public. Where Radar is a screener, Coin Intelligence shows you *how the engine thinks*: a 0–100 quality ring and verdict pill (strong / watch / caution / avoid) per coin, the organic-vs-bundle split, timing entropy, fresh-wallet ratio, funder-cluster bubble map, and classified trader labels (smart_money, whale, serial, creator, sniper, bundled…).

Four tabs:

1. **Radar** — scored launch cards, searchable, filterable by category, verdict, and quality.
2. **Leaderboard** — best-scored coins and confirmed winners.
3. **Smart-Money Traders** — the cross-coin trader board.
4. **What it learned** — the learned per-signal weights and outcome distribution. The engine grades its own predictions against real outcomes and shows you the weights it arrived at.

If the engine is still warming up (fresh deploy, empty tables), the page says so honestly instead of rendering blanks. Public, no account, refreshes every 15 seconds. A caller mistake is answered as one, never as an outage: an unknown `view`, a non-base58 `mint`, or a `minQuality` outside 0-100 gets a `400` (`invalid_view`, `invalid_mint`, `invalid_min_quality`) rather than the "warming up" state. The feed's `q` search runs in SQL over the whole observed feed, and a `verdict` filter (derived after the row is shaped) scans up to 600 recent rows before slicing to the requested page, so `?verdict=strong` on a busy feed no longer answers with the one strong coin that happened to sit on page one. The `traders` and `learning` views are whole-history aggregates and are edge-cached for 5 minutes; the feed stays on a 5-second cache.

## Live Trade Feed — /trades

The proof stream. The left rail is a public feed of closed positions where a platform agent turned a meaningful profit: realized PnL, hold time, exit reason, transaction signatures, Oracle context, and how many copiers followed the trade. Filter by time window (1h → all-time) and minimum PnL (`min_pnl_pct`, default 10). $THREE is pinned at the top of the rail. Each row's `multiple` is derived from the position's cumulative realized percentage rather than exit over entry, because a position that took initials first rewrites its cost basis and books only the closing leg's proceeds. Pages walk a `cursor` (an ISO 8601 timestamp; anything else is a `400 validation_error`) ordered by close time then position id, so two exits sharing a timestamp cannot reorder between pages.

Click any trade (or paste any mint) and the center pane becomes a full analytics workstation for that coin:

- Candlestick chart with live SSE updates, plus the bonding-curve widget
- Intel signal gauges (snipe ratio, top-10 concentration) and holder/cohort distribution
- The **funder bubblemap** — who funded the buying wallets, clustered
- Smart-money pedigree and a wallet-footprint table with Solscan links and DEV tags
- The live trade tape, the outcome badge (with ATH multiple), and the agent's economics on the trade (buyback runs and burns)

Every wallet links to Solscan; every coin links onward to its Oracle page. Public, no account.

## Watchlist — /watchlist

Your coins, on one live board — and deliberately device-local. The list lives in your browser's localStorage (never on our servers, no account needed) and syncs across your open tabs. Every other trading surface's **Watch** toggle writes to this same list.

What you get:

- A live status card per coin (market cap, price, graduation state, buy button), refreshing every 90 seconds
- A summary bar: combined market cap, 24h volume, graduated count
- Oracle conviction badges on every card, plus a **Movers** section showing the biggest 24h conviction swings among your coins
- **Tier-upgrade alerts**: flip the alerts toggle and the page fires a browser notification when any watched coin's Oracle tier upgrades
- A shareable URL — `/watchlist?add=<mint1>,<mint2>` pre-loads coins into a friend's watchlist

Empty state suggests trending coins so the page is never a dead end.

## Mission Control — /terminal

The cockpit. Everything above is fused into one keyboard-first, three-pane terminal — and this is the surface where you can actually pull the trigger, because it trades through your agent's custodial Solana wallet on the server-side guarded path (firewall verdict, MEV protection, spend guards, and the custody audit trail are enforced server-side on every order — the same rails documented in [financial-controls](financial-controls.md)).

The three panes:

1. **Feed** (left) — three switchable sources: the live new-mint firehose (SSE), the intel engine's scored signals, and the sniper's pre-launch radar.
2. **Focus** (center) — the selected coin's identity, market state, firewall verdict, smart-money read, candlestick chart, and live trade tape.
3. **Positions** (right) — your agent's open positions with streaming unrealized PnL, spot holdings, and one-tap quick exit.

The keyboard is the point:

| Key | Action |
| --- | --- |
| `j` / `k` | Move through the feed |
| `b` | Buy at the current size preset |
| `1`–`6` | Switch buy-size presets |
| `s` | Sell the whole position |
| `/` | Filter the feed |
| `x` | Express mode — toggle between confirm-first and instant execution |
| `?` | Shortcut overlay |

Signed-out, Mission Control is a read-only cockpit; the trade ticket becomes "Sign in to trade." Signed in with a trading agent, orders preview and execute against real pump.fun liquidity.

## How the surfaces chain together

The intended loop: **Radar** (or **Coin Intelligence**) surfaces a launch worth a look → **Watch** it → the **Watchlist** alerts you when Oracle's conviction tier upgrades → open it in **Mission Control** and execute → if the trade wins big, it shows up on the **Live Trade Feed** with the full receipt for everyone else to study. Every coin, on every surface, links to its [Oracle page](oracle.md) for the fused conviction verdict — and armed agents can run the same loop autonomously (see [the trading experiment](trading-experiment.md) and [Oracle's agent loop](oracle.md)).

## API quick reference

All read endpoints are public and IP rate-limited:

```bash
# Radar list + market pulse
curl 'https://three.ws/api/pump/coin-intel?stats=1'

# Intel engine: scored feed, leaderboard, learned weights, cross-coin traders, one coin
curl 'https://three.ws/api/pump/intel?view=feed&limit=10'   # views: feed | leaderboard | learning | traders
curl 'https://three.ws/api/pump/intel?mint=<MINT>'

# Proven-wallet pedigree for one coin, or one wallet's reputation (both base58-validated)
curl 'https://three.ws/api/intel/smart-money?mint=<MINT>'

# Winning-trade feed
curl 'https://three.ws/api/trades/feed'

# Oracle conviction for a batch of mints
curl 'https://three.ws/api/oracle/batch?mints=<MINT1>,<MINT2>&network=mainnet'
```

Agents wanting the same intel over MCP: see [docs/mcp.md](mcp.md) (`@three-ws/intel-mcp`, `@three-ws/portfolio-mcp`) — and the paid x402 lanes in [x402-endpoints](x402-endpoints.md).

## Related

- [Meta-Allocator: the ETF of degens](meta-allocator.md): diversify a budget across the top verified leaders
- [Clip Director: every trade becomes content](clip-director.md): turn any closed trade into shareable cards per surface
- [The Trading Copilot — talk to your wallet](trading-copilot.md) — conversational trading over these same numbers
- [Oracle — the conviction engine](oracle.md) · [/oracle/docs](https://three.ws/oracle/docs)
- [The autonomous trading experiment](trading-experiment.md)
- [Financial controls & custody guardrails](financial-controls.md)
- [UX flows: crypto trading & analytics](ux-flows/07-crypto-trading-analytics.md) — screen-by-screen walkthrough
