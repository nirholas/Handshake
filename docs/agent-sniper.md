# Agent Sniper: autonomous on-chain trading, fully explained

Every three.ws agent has its own custodial Solana wallet. The Agent Sniper is the subsystem that lets that wallet trade autonomously: it watches the pump.fun launch firehose in real time, scores every new coin against an owner-armed strategy, runs an on-chain safety simulation before committing a single lamport, executes the buy from the agent's own wallet, manages the position through a strict exit ladder, and writes every decision it takes to a hash-chained reasoning ledger you can audit later.

This doc explains the whole system, walks through the first live trade an agent closed on the platform (a real +42.38% exit, receipts included), and lays out where the system goes next.

Related surfaces: [the trading surfaces](./trading-surfaces.md) (Radar, Coin Intelligence, Mission Control), [trading experiment](./trading-experiment.md) (the laddered-exit research policy), [agent wallets](./agent-wallets.md) (how custody works), and the worker itself at `workers/agent-sniper/` (its README is the operator reference).

---

## The pipeline, end to end

A snipe is not one decision. It is a chain of gates, and a coin must pass every one of them:

1. **Trigger.** A long-lived worker holds the PumpPortal new-mint feed open (`trigger: "new_mint"`), or watches for a creator's first-ever fee claim (`trigger: "first_claim"`), or fires from intel/alpha/radar signals. It is deliberately not a cron: a periodic tick cannot snipe a launch.
2. **Entry scoring** (`workers/agent-sniper/scorer.js`, pure function, no I/O). The coin must be SOL-quoted, inside the strategy's market-cap band, pass creator-history checks, and carry socials if the strategy demands them. Every skip is recorded with a reason string, so you can see why a coin was passed over, not just which ones were bought.
3. **Fleet safety band.** Worker-level env clamps (`SNIPER_MIN_MC_FLOOR_USD` / `SNIPER_MAX_MC_CEIL_USD`) tighten every strategy at once. A per-strategy bound can only narrow this band, never widen it. Unknown market cap fails closed: the sniper never buys a coin it cannot price.
4. **Mayhem gate** (`workers/agent-sniper/mayhem-gate.js`). Pump.fun "Mayhem mode" tokens are excluded by owner rule. The flag is not in the firehose, so the worker reads it from the on-chain bonding curve, one cached RPC read per mint.
5. **Trade firewall** (`api/_lib/trade-firewall.js`). Before broadcasting, the executor runs a real simulated buy-then-sell on-chain. If the token cannot be sold back (honeypot), or the round trip loses abnormally (rug mechanics), the strategy's `firewall_level` decides: `block` aborts the buy, `warn` proceeds with a lowered confidence score.
6. **Execution** (`workers/agent-sniper/executor.js`, the only file that signs). The agent's key is decrypted from its at-rest AES-256-GCM secret box, the v0 transaction is signed and broadcast with the strategy's slippage and priority-fee settings, and an idempotency lock guarantees one buy per mint per strategy.
7. **The decision ledger.** Every trade appends an entry to `agent_decisions`: the inputs (trigger, firewall verdict and score, price impact, size), a plain-language rationale, a falsifiable prediction, and a mechanically computed confidence. Entries are hash-chained (`prev_hash` to `entry_hash`), so the reasoning history cannot be silently rewritten.
8. **Position management** (`workers/agent-sniper/positions.js` + `exit-logic.js`). A sweep re-quotes every open position against the bonding curve (or the AMM after graduation), updates the high-water mark, and decides exits in strict priority order: **stop-loss, then signal-flip, then trailing-stop, then take-profit, then timeout**. The laddered variant recovers initial cost at a configured multiple and lets a moon bag ride the trailing stop.
9. **Custody audit.** Key recovery, the spend, and the exit each write an `agent_custody_events` row, and the wallet's balance is committed into the platform's custody attestation Merkle tree every epoch.

Nothing in this pipeline is a mock. The firewall simulation is a real on-chain simulation, the buy is a real mainnet transaction, and the ledger rows reference real signatures you can open in any explorer.

## Case study: the first live trade

On 2026-07-19 at 02:26:00 UTC, the platform's own agent ("three", trading from its custodial wallet `3334ZPryymmAuoRx13pBfB2kepL2ULexoirjwqhFKrsc`) sniped a brand-new pump.fun launch on a `new_mint` trigger and closed it 30 minutes later at **+42.38%**.

The full record, straight from the database and the chain:

| Field | Value |
|---|---|
| Entry | 2026-07-19 02:26:00 UTC, 0.05 SOL committed |
| Entry price impact | 0.05% (ceiling was 10%) |
| Execution | protected route, landed in 1,709 ms, priority fee 1,000 microlamports, no MEV tip |
| Firewall | simulated buy-and-sell verdict `allow`, score 100 |
| Ledger confidence | 0.698 |
| Peak | +46.5% (73,231,688 lamports) |
| Exit | 2026-07-19 02:56:04 UTC, reason `timeout`, full position |
| Realized | +21,191,138 lamports = +0.0212 SOL = **+42.38%** |
| Buy signature | [`3Y6NqS8…CEGrzRY`](https://solscan.io/tx/3Y6NqS8CV3K1j5sBZYsuQjpipZeY2wckCz3h99vGA6ZbwJgMpeUjkVm43zffeV52Kc2jWRUn4d4rzcTxoCEGrzRY) |
| Sell signature | [`mLmGA7F…jeyhH`](https://solscan.io/tx/mLmGA7FeHFUEDdQagavVZCH2aExmMssjsVxWiRCSxRZwvbxDS1Xfnvan63ab5FkrKnQ7koEu4yxwgVJYXajeyhH) |
| Live decision ledger | [three.ws/ledger/4c0e4d18-0544-4c95-a0db-a16896b029be](https://three.ws/ledger/4c0e4d18-0544-4c95-a0db-a16896b029be) |

The decision-ledger rationale the agent recorded at entry, verbatim:

> "Sniped $BITS on a new_mint trigger with 0.05% price impact; firewall verdict allow (score 100). Committed 0.0500 SOL expecting a profitable exit."

The strategy that produced it was armed on 2026-07-10 with: 0.05 SOL per trade, 0.2 SOL daily budget, one concurrent position, a $5k to $25k market-cap band, socials required, dev-dump avoidance on, firewall on `block`, 30% stop-loss, 25% trailing stop, no take-profit, and a 30-minute maximum hold.

### What the trade actually teaches

Honesty is the point of publishing this, so here is the unvarnished read:

- **The safety stack did its job.** The firewall's simulated round trip is what separates "sniping new launches" from "donating to rug creators". Score 100 meant the token was provably sellable before the buy was broadcast.
- **The exit was luck-shaped.** The position exited on `timeout`, not on a profit rule. With `take_profit_pct` unset, nothing could lock in the +46.5% peak; the position simply ran out its 30-minute clock while still green. A configured take-profit or a tighter trailing stop converts that from luck into policy.
- **One trade is not a track record.** This strategy scanned launches for roughly nine days before one coin passed every gate. That selectivity is the system working as designed (most new mints fail the socials gate, the band, or the firewall), but it also means the sample size is one. Treat the 42% as an existence proof of the pipeline, not an expected return.
- **Small size was correct.** 0.05 SOL per trade meant the whole experiment risked less than a coffee. The pipeline is now proven end to end; size can scale deliberately.

### Audit it yourself

Every layer of the trade above is independently checkable. You do not need our word for any of it:

- **The agent's public reasoning ledger** is live at [three.ws/ledger/4c0e4d18-0544-4c95-a0db-a16896b029be](https://three.ws/ledger/4c0e4d18-0544-4c95-a0db-a16896b029be). It renders this exact decision with its rationale, prediction, confidence, and (once reconciled) the real outcome, hash-chained to the agent's prior history and independently verifiable via `GET /api/ledger/verify/4c0e4d18-0544-4c95-a0db-a16896b029be`. The API behind it: `GET /api/ledger/4c0e4d18-0544-4c95-a0db-a16896b029be?kind=snipe`.
- **The two transactions** resolve on any Solana explorer: [buy](https://solscan.io/tx/3Y6NqS8CV3K1j5sBZYsuQjpipZeY2wckCz3h99vGA6ZbwJgMpeUjkVm43zffeV52Kc2jWRUn4d4rzcTxoCEGrzRY) and [sell](https://solscan.io/tx/mLmGA7FeHFUEDdQagavVZCH2aExmMssjsVxWiRCSxRZwvbxDS1Xfnvan63ab5FkrKnQ7koEu4yxwgVJYXajeyhH).
- The position row lives in `agent_sniper_positions` with entry/exit prices, the peak, and the realized PnL.
- The reasoning entry lives in `agent_decisions`, hash-chained to the agent's prior history.
- The spend and key-recovery events live in `agent_custody_events`, and the wallet appears in the epoch custody attestations (`custody_attestation_leaves`).

## Configuration reference

The strategy row (`agent_sniper_strategies`, armed via `POST /api/sniper/strategy`) is the whole policy. The load-bearing fields:

| Field | What it does |
|---|---|
| `trigger` | `new_mint`, `first_claim`, `intel_confirmed`, alpha/radar variants |
| `per_trade_lamports` / `daily_budget_lamports` | Position size and the hard daily spend ceiling |
| `max_concurrent_positions` | Open-position cap |
| `min_market_cap_usd` / `max_market_cap_usd` | Entry band; tightened by the fleet-wide safety band |
| `require_socials` | Reject coins with no Twitter/Telegram/website |
| `avoid_dev_dump` | Reject coins whose creator already sold (defaults on) |
| `firewall_level` | `block` (abort on a failed simulation) or `warn` |
| `slippage_bps` / `max_price_impact_pct` | Execution guards |
| `stop_loss_pct` | Hard floor below entry, always evaluated first |
| `trailing_stop_pct` | Percent off the position's high-water mark |
| `take_profit_pct` | Profit ceiling. **Set this.** Null means winners are only ever closed by the trailing stop or the clock |
| `max_hold_seconds` | The timeout backstop; closes the position regardless of PnL |
| `initials_out_multiple` / `moonbag_min_pct` | The laddered exit: recover cost at N times entry, let the rest ride |
| `kill_switch` / `enabled` | Two independent off switches |

Exit rules are evaluated in a fixed order (stop-loss, signal-flip, trailing-stop, take-profit, timeout) by a pure, unit-tested function (`workers/agent-sniper/exit-logic.js`), so a backtest and the live worker agree on exactly when a position closes.

## Where this goes next

The hard-config sniper is the control group. Its constants (band edges, stop percentages, hold time) are frozen at arm time, which means it cannot react to regime changes: a band that is right at midnight is wrong at noon, and the only fix is a human editing numbers.

The next phase is an **LLM-piloted strategist** running above the same execution stack:

- A reasoning model (via the platform's existing LLM failover chain) periodically reads live market state: launch cadence, graduation rate, intel-engine quality distributions, the agent's own recent ledger outcomes.
- It emits a strategy adjustment as structured output: the same fields documented above, never freeform code. The deterministic gates (firewall, fleet band, Mayhem exclusion, budget ceilings) stay hard and non-negotiable; the model only tunes what a human owner tunes today.
- Every adjustment lands in the same hash-chained decision ledger with the model's stated rationale and a falsifiable prediction, so LLM-tuned and hand-tuned strategies are comparable line by line.
- Configurations run head to head with real, small, capped budgets, and their ledgers decide which policy survives.

The design principle is fixed: **models propose, the deterministic pipeline disposes.** No model output ever bypasses the firewall, the budget caps, or the confirmation gates around irreversible actions.

## Try it

- Arm your first strategy: [the sniper tutorial](/tutorials/arm-an-agent-sniper)
- Watch the engine think: [Coin Intelligence and the trading surfaces](./trading-surfaces.md)
- The research policy behind laddered exits: [trading experiment](./trading-experiment.md)
- The story of the first trade, for non-operators: [the blog post](/blog/first-autonomous-trade)
