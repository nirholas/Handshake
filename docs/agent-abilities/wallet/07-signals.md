# 07 · Signals

> A copy-trading marketplace where only provably profitable agents can sell signals — and one red button kills any subscription instantly.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

The Signals tab turns your agent's trading record into a business — and lets it follow other proven traders. If your agent has a verified on-chain track record, you can publish a paid signal feed: set a USDC price per signal or a flat rate per epoch, choose whether to broadcast entries, exits, and position sizes, and earn real USDC every time a follower's agent receives your call. If it hasn't earned that right yet, the tab shows exactly what's left to prove, with live progress bars that unlock publishing automatically. On the other side, it lists every feed your agent follows — what it pays, how it sizes copies, how many trades it has mirrored, and how much it has actually spent — with instant controls: pause, sync now, stop, and a one-click kill that halts all payments and trading on the spot.

## How it works

Publishing is gated by the same verification math that powers the trader leaderboard: the platform reads the agent's real closed positions on Solana and only grants publishing to wallets with 12+ closed trades across 5+ coins, low churn, and positive realized profit. Signals are never typed by the seller — a background job runs every two minutes, watches each publisher's actual position ledger, and emits an entry when a position opens and an exit when it closes, each bound to the real on-chain transaction. Delivery to each subscriber settles the USDC payment first (from the follower agent's own custodial wallet to the publisher's payout address, with daily ceilings and idempotency so nothing double-charges), then auto-mirrors the trade through the same guarded execution engine every other trade uses: spend caps, price-impact limits, a rug/honeypot firewall, and MEV-aware execution. Simulate mode runs the identical pipeline without paying or trading, and marketplace rank comes from proven realized outcomes — wins, losses, follower ROI, and fill latency — regressed toward neutral until a feed has enough closed signals to trust.

## Every feature

- Owner-only Signals tab inside the Agent Wallet hub — never visible to visitors
- Network-aware: follows the wallet's mainnet/devnet switch and reloads automatically
- Publish-eligibility scorecard with animated progress bars: closed trades (need 12+), unique coins traded (need 5+), churn rate (must be 40% or lower), and realized profit (must be positive)
- Automatic unlock — the publish form appears the moment the agent's on-chain record clears the verification bar, no application or review
- Feed title field (80-character cap)
- Per-signal USDC pricing (defaults to $0.25 a signal)
- Per-epoch USDC pricing as a flat-rate alternative — one payment covers the whole window
- Epoch length presets: 1 hour, 6 hours, 1 day, 1 week
- Emit entries toggle — publish when the agent buys
- Emit exits toggle — publish when the agent sells
- Reveal sizing toggle — choose whether followers see position sizes
- Minimum conviction filter (0–1): only publish the agent's higher-than-usual-sized bets; conviction is computed from real bet size versus the agent's typical entry, never self-declared
- Visibility control: Public (ranked in the marketplace directory) or Unlisted (link-only)
- Pause / resume the entire feed with one button
- 'View public feed' link to the shareable ranked feed page
- Edit-in-place: the same form saves changes to an already-published feed
- Following list: every feed this agent subscribes to, each as a rich card
- Status pills on every subscription: Live (green), Simulate, Paused (amber), Killed (red)
- Per-subscription economics at a glance: price per signal or per epoch, base SOL size, size-scaling multiplier, max SOL per trade, executed fill count, and total USDC actually spent
- Kill now — one red button instantly halts all further payments and trades for that subscription
- Resume after a kill (kills never silently expire — resuming is an explicit choice)
- Pause / resume a subscription without losing its history
- Sync now — pull and deliver any pending signals on demand, with a toast reporting how many were delivered
- Stop — end a subscription while keeping its delivery history
- Simulate mode: mirrors the publisher's sizing on paper without paying or trading, for trust-building before going live
- Live mode: pays real USDC per signal or per epoch from the agent's own wallet and auto-mirrors entries and exits
- Per-signal billing charges entries only — exit signals ride free once the entry was paid
- Follower sizing formula: your base SOL × the publisher's size multiple × your scaling factor, hard-capped by your max-per-trade — dust-sized orders are skipped
- Copy-exits option: mirrored exits sell the follower's full holding of that coin
- Slippage control (up to 50%, default 3%) and a per-trade rug/honeypot firewall set to block or warn
- New subscriptions start at the live edge — you are never charged for or made to mirror a backlog of old signals
- Every signal binds to a real on-chain transaction (buy/sell signatures, linkable on Solscan) — publishers cannot hand-write signals
- Marketplace ranking by confidence-regressed proven edge: a feed needs 10 closed signals for full statistical weight, so one lucky call can never top the board; sortable by edge, ROI, hit rate, subscribers, or newest
- Feed accountability stats tracked from real deliveries: hit rate, average realized return, follower ROI, signal-to-fill latency, subscriber count
- Automatic delivery every 2 minutes via a background job, plus the manual Sync button
- Designed states throughout: loading skeletons, a retry-able error card, and an empty state that links to the signal marketplace
- Accessibility built in: ARIA progress bars, live-region status messages, keyboard focus rings, and reduced-motion support

## Guardrails & safety

The whole tab is owner-only, and every write is authenticated, CSRF-protected, rate-limited, and scoped to an agent the caller owns. Publishing is hard-gated server-side: only a verified on-chain track record (12+ closed trades, 5+ unique coins, churn at or under 40%, positive realized profit) can create a feed — an unproven wallet gets refused with the exact thresholds it still has to meet, so sellers can never self-declare edge. Prices are capped at $1,000 per signal/epoch, epochs bounded between 1 hour and 30 days, and a feed must set at least one price and emit at least entries or exits. Subscriber inputs are clamped: base size 0.001–10 SOL, scaling 0.01–20x, max per trade 0.001–50 SOL, slippage 0–50%; an agent cannot subscribe to its own feed. The instant kill halts payments and trades before either fires, and pausing never clears a kill — only an explicit resume does. New subscriptions are never billed for pre-existing signals. If a payment fails or hits a cap, the trade is skipped — unpaid alpha is never traded. Every mirrored buy passes the same guard stack as manual trades: per-trade SOL cap, daily budget, the owner's plain-English spend policy, price-impact cap, rug/honeypot firewall (blocking by default), and an SOL fee-headroom check. Deliveries and payments are idempotent end to end (unique delivery keys plus custody-ledger idempotency), so retries, cron overlaps, and double-clicks can never double-pay or double-trade.

## Screenshot-worthy (shot list)

- The 'prove it' scorecard: four live progress bars showing exactly how far an agent is from earning the right to sell signals — closed trades, coins traded, churn, and profit — with publishing unlocking automatically the moment the bar clears. No application, no review, just receipts.
- The red 'Kill now' button on every subscription and its toast — 'Killed — no further pay or trade.' One click and the platform guarantees not another cent leaves the wallet and not another trade fires.
- A subscription card showing real money in motion: a green Live pill, '$0.25/signal', '34 fills', 'spent $8.50', right next to the caps that protect it — 'base 0.05 SOL · 1x · max 0.25 SOL'.

## API surface

- `GET /api/signals/feeds?agent_id=&network= (feed + publish eligibility for this agent)`
- `POST /api/signals/feeds (create/update feed; also { id, status } to pause/resume)`
- `GET /api/signals/subscribe (list this owner's subscriptions with live spend/fill stats)`
- `POST /api/signals/subscribe ({ id, killed } instant kill, { id, status } pause/resume/stop, { id, action:'sync' } deliver now)`
- `Driven server-side by GET /api/cron/signal-fanout (every 2 minutes, cron-secret protected)`
