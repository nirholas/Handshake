# 03 · Portfolio

> Your agent's entire trading life — net worth, holdings, P&L, and risk — on one live screen that never fakes a number.

## What it does

The Portfolio tab is the agent wallet's command center: one real-time view of everything the wallet holds and has done. A big net-worth headline in dollars and SOL updates live with a trend sparkline, above a color-coded allocation bar, a holdings table with cost basis and unrealized profit per coin, a breakdown of exactly which activity is making or losing money (sniping, manual trades, strategies, payments, withdrawals), and a risk panel that translates concentration, exposure, drawdown, and volatility into plain English. Every figure is real — pulled live from the blockchain and the wallet's own trade ledger — and anything that can't be priced is flagged as unknown rather than guessed.

## How it works

The tab calls an owner-gated portfolio endpoint that fuses three real data sources: live on-chain holdings valued through Helius (with rotating public Solana RPC fallbacks) and the Jupiter price API which understands pump.fun bonding curves; the sniper position ledger whose realized P&L is proven by on-chain transaction signatures; and the custody/spend ledger recording every outbound trade, payment, and withdrawal. A FIFO lot engine, computed in exact raw token units, matches every sell against the oldest buys and attributes realized and unrealized profit to the source that opened each lot — sniper, discretionary, or strategy. After the first snapshot, a server-sent-event stream re-values the whole portfolio every 20 seconds and pushes fresh net worth, holdings, attribution, and risk to the browser, which feeds the live sparkline; the stream cleanly self-terminates and auto-reconnects to stay within platform limits. Risk metrics (Herfindahl concentration, volatile-sleeve exposure, reserve share, max drawdown, per-trade volatility) are computed in pure deterministic functions so the API and the stream can never disagree.

## Every feature

- Live net-worth headline in USD with the SOL equivalent and the current SOL price
- Real-time sparkline of net worth built from the live stream (up to 40 points), colored green or red by trend, with gradient fill and endpoint dot
- Pulsing 'live' indicator while the stream is connected
- 'Updates paused' button when the stream closes, with one-click reconnect
- Realized P&L and Unrealized P&L summary pills, signed and color-coded
- Allocation composition bar: SOL in Solana violet, $THREE in platform green, stablecoins in teal, volatile positions in a rotating warm palette
- Allocation bar caps at 7 segments and folds the tail into a '+N more' bucket to stay legible
- Per-segment hover tooltips with symbol, percentage, and dollar value, plus a swatch legend and priced-asset count
- Holdings table with token logo (graceful placeholder fallback), symbol, and type sub-label (Native / $THREE / Stable / token name)
- Per-holding amount, live USD value, FIFO cost basis in SOL, and unrealized P&L in SOL and percent
- 'Illiquid' warning badge on any holding with no live market price — value shown as unknown, never guessed
- One-click 'Trade' button on every token that copies the mint address and jumps straight to the Trade tab with a confirmation toast
- P&L attribution card breaking profit down by source: Sniper, Discretionary, and Strategy object, each with realized + unrealized split and a proportional green/red magnitude bar
- Separate outflow rows for x402 payments and withdrawals so spending is never confused with trading losses
- Methodology note stating sniper P&L is on-chain actuals while discretionary P&L is derived from recorded trade quotes
- Risk panel with five metric tiles: Reserve (dry powder), Concentration, Tape exposure, Max drawdown, and Realized volatility
- Heat-colored risk meters that shift green → lime → amber → red as a metric worsens
- Hover help text on every risk tile explaining the metric in plain language
- Plain-language risk flags at info / warn / danger levels (e.g. concentration over 60%, memecoin exposure over 75%, drawdown over 35%)
- SOL and stablecoins counted as reserve, never as concentration risk — a fresh all-SOL wallet reads 'dry powder ready to deploy', not a false alarm
- Positive all-clear flag when no elevated risk is detected
- Mainnet / devnet network switcher support — switching networks resets the sparkline and reloads; devnet SOL is priced while devnet tokens are honestly marked unpriceable
- Live SSE stream that re-values the portfolio every 20 seconds with heartbeat pings and automatic reconnection
- Designed empty state with 'Deposit funds' and 'Make a trade' shortcuts into the neighboring tabs
- Designed error state with a Retry button
- Skeleton loading state while the first snapshot loads
- Staggered entrance animation on first paint only (never replayed on live updates), fully disabled under reduced-motion preferences
- Responsive layout: amount and cost-basis columns collapse on small phones, tables scroll horizontally, nothing breaks at 320px
- Screen-reader support: labeled sparkline, spoken allocation summary, labeled risk cells, and visible focus rings
- Stream automatically closes when the tab is hidden and reopens when shown, saving bandwidth

## Guardrails & safety

Owner-only at two layers: the tab is hidden from non-owner viewers in the wallet hub, and the server independently requires a signed-in session or bearer token and verifies the requester owns the agent before returning anything (401/403/404 otherwise) — attribution comes from the spend ledger, which is owner-sensitive. Reads are rate-limited to 60 per minute per user. The surface is strictly read-only: no on-chain action can be triggered from this tab (the Trade button only hands off to the Trade tab). Honesty guarantees are enforced in code: USD values degrade to null when price feeds are down rather than being invented, holdings with no live market are flagged illiquid instead of valued, and tokens deposited from outside get an honest 'unknown' cost basis rather than a fabricated one. The live stream self-terminates before the platform's execution cap so clients always get a clean close and reconnect.

## Screenshot-worthy (shot list)

- The net-worth headline with its live sparkline and pulsing 'live' dot — the line literally turns green or red with the trend as 20-second revaluations stream in
- The allocation bar: the whole portfolio's composition in one color-coded strip — Solana violet, $THREE green, stablecoin teal, and warm hues for the memecoin sleeve — with hover tooltips per slice
- The risk panel's plain-English verdicts: heat-colored meters plus flags like '90% of net worth is held in SOL / stable reserve — dry powder ready to deploy' instead of jargon or false alarms

## API surface

- `GET /api/agents/:id/portfolio?network=mainnet|devnet`
- `GET /api/agents/:id/portfolio/stream?network=mainnet|devnet (SSE)`
