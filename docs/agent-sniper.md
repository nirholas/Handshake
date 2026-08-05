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
5. **Trade firewall** (`api/_lib/trade-firewall.js`). Before broadcasting, the executor runs a real simulated buy-then-sell on-chain. The classification is leg-aware: only a revert on the **sell** leg has the honeypot shape (you can get in but not out) and stays a fatal block. A revert on the **buy** leg (the payer cannot fund the probe, or the curve moved past the quoted slippage) is a warning, not a honeypot verdict, because it says nothing about sellability; on the pump.fun curve the sell path is the curve program itself, and the authority audit separately catches freeze/mint rugs. The probe is also sized to the payer: when the executor hands over the wallet's known balance, the round-trip quote shrinks to what that wallet can actually simulate (sellability is a property of the coin, not of the probe size), so a thin wallet reads as a thin wallet, not as a honeypot. A wallet that cannot fund even the minimum probe gets a `probe_unaffordable` warning, which counts as critical unproven safety, never a silent pass. The strategy's `firewall_level` decides what a verdict does: `block` aborts the buy on a block verdict or a critical unproven-safety warning, `warn` proceeds with a lowered confidence score.
6. **Execution** (`workers/agent-sniper/executor.js`, the only file that signs). The agent's key is decrypted from its at-rest AES-256-GCM secret box, the v0 transaction is signed and broadcast with the strategy's slippage and priority-fee settings, and an idempotency lock guarantees one buy per mint per strategy. Sizing shrinks instead of sitting out: a buy that would overrun the arm's remaining daily budget is clamped to the day's remainder, and a wallet short of the configured size trades at what it can afford after fee headroom, but only while the wallet stays above an operational floor; below that floor the arm sits out rather than looping on simulations it cannot fund (`resolveEntrySize` in `api/_lib/agent-trade-guards.js`).
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

## Track every wallet, every decision

The case study above audits one trade. [/sniper/experiments](/sniper/experiments) is the live version of that audit for the whole fleet, updated every 30 seconds:

- **Every arm's wallet, in the open.** Each row shows its Solana address (truncated, linked to Solscan) and its real-time SOL balance — no login, no DB query, just what the chain says right now. A "Fleet SOL on hand" tile totals it across every armed wallet.
- **The funding source too.** The fleet's dry wallets are kept above a per-arm funding level by one master wallet (`SNIPER_AUTO_FUND`, `workers/agent-sniper/auto-funder.js`). The trigger and refill target are sized off each arm's own largest per-trade size via `api/_lib/agent-funding-policy.js` (a wallet that cannot cover its arm's trade size is not healthy, however far above a flat floor it sits), and the economy's idle-capital reclaim reads the same two functions, so refill and reclaim cannot ping-pong the same SOL. The master's address and live balance are published in the same view, so funding flow into the fleet is as auditable as the fleet itself.
- **A "ledger →" link on every arm** goes straight to that agent's full Reasoning Ledger (`/reasoning-ledger?agent=<id>&kind=snipe`, backed by `GET /api/ledger/:agentId`): the complete, tamper-evident, hash-chained history of every buy decision that agent has made — the trigger, price impact, firewall verdict, and (for LLM-judged arms) the model's thesis and confidence at the moment it decided, plus the reconciled real outcome once the position closes (win or loss, exact SOL, the sell signature). Nothing is aggregated away; a loss is exactly as visible as a win.
- **The judgment ledger** (rendered lower on the same page) scores every LLM verdict — buys AND skips — against what the coin actually did, independent of position size, so a model's calibration is measurable even before its trades close.

This is deliberately the same infrastructure the case study above uses, generalized: `agent_decisions` + `decision_outcomes` (the reasoning ledger), `sniper_llm_verdicts` (the judgment ledger), and `api/cron/reconcile-decisions` (closes the loop from an open prediction to a proven outcome, then anchors the chain head on-chain via SPL-Memo so the history is independently verifiable at `GET /api/ledger/verify/:agentId`).

## Configuration reference

The strategy row (`agent_sniper_strategies`, armed via `POST /api/sniper/strategy`) is the whole policy. The load-bearing fields:

| Field | What it does |
|---|---|
| `trigger` | `new_mint`, `first_claim`, `intel_confirmed`, `graduation_ride` (buy at migration, sell into pump.fun's 5-minute BOOST buyback window), `oracle_crossing` (buy the first time a coin crosses the strategy's Oracle-conviction bar; see below), alpha/radar variants |
| `per_trade_lamports` / `daily_budget_lamports` | Position size and the hard daily spend ceiling |
| `max_concurrent_positions` | Open-position cap |
| `min_market_cap_usd` / `max_market_cap_usd` | Entry band; tightened by the fleet-wide safety band |
| `require_socials` | Reject coins with no Twitter/Telegram/website |
| `avoid_dev_dump` | Reject coins whose creator already sold (defaults on) |
| `firewall_level` | `block` (abort on a failed simulation) or `warn` |
| `slippage_bps` / `max_price_impact_pct` | Execution guards |
| `stop_loss_pct` | Hard floor below entry, always evaluated first |
| `trailing_stop_pct` | Percent off the position's high-water mark. Arms only once the position has been above breakeven; underwater, the stop-loss alone owns the downside (measured across the fleet's first 90 trades: every below-breakeven trail just realized a loss the stop would have capped) |
| `take_profit_pct` | Profit ceiling. **Set this.** Null means winners are only ever closed by the trailing stop or the clock |
| `max_hold_seconds` | The timeout backstop; closes the position regardless of PnL |
| `initials_out_multiple` / `moonbag_min_pct` | The laddered exit: recover cost at N times entry, let the rest ride |
| `kill_switch` / `enabled` | Two independent off switches |

Exit rules are evaluated in a fixed order (stop-loss, signal-flip, trailing-stop, take-profit, timeout) by a pure, unit-tested function (`workers/agent-sniper/exit-logic.js`), so a backtest and the live worker agree on exactly when a position closes.

### The `oracle_crossing` trigger

Most triggers judge a coin at launch, when the Oracle has no signal yet. `oracle_crossing` inverts that: a watcher (`workers/agent-sniper/oracle-crossing.js`) polls `oracle_conviction` and buys a coin the **first time** its score crosses the strategy's `min_oracle_score` (default 50), provided the coin is young (`SNIPER_CROSSING_MAX_AGE_MIN`, default 90) and the score is fresh. The empirical case, measured over the fleet's first window (2026-07-20..23): coins that crossed conviction 50 pumped or graduated **77.5%** of the time vs an 11.8% base rate; the crossing lands a **median of 2 minutes after launch**; and the median crossing offered 1.23x from the crossing candle with 35% reaching 1.5x. The same data says the median crossing coin eventually decays to 0.32x of the crossing price, so a crossing strategy should always ship with a reachable take-profit or the initials-out ladder. One attempt per (strategy, mint); candidates route through the same `executeBuy` chokepoint (Mayhem gate, firewall round trip, budgets, market-cap clamps) plus an explicit x402 rugpull veto. Full analysis: [the 90-trade postmortem](/blog/autonomous-trading-experiment).

## How the fleet improves itself

The hard-config sniper is the control group: its constants (band edges, stop percentages, hold time) are frozen at arm time, so it cannot react to regime changes. A band that is right at midnight is wrong at noon, and the only fix used to be a human editing numbers. That is no longer the case. The fleet now improves itself through three layers, each running above the same execution stack and each bounded so it can only ever tune what a human owner already tunes.

**Layer 1: LLM-judged entry (`decision_mode = 'llm'`).** An arm can skip the rule shields and instead ask a model (an OpenRouter slug, via the platform's LLM failover chain) to judge each launch, returning `{ buy, confidence, thesis }`. The verdict is persisted and later scored against what the coin actually did (`sniper_evolution_log` / the judgment ledger), so a model's calls are measured independent of trade size. The deterministic rails (firewall, Mayhem exclusion, budgets, concurrency) still apply to LLM arms identically.

**Layer 2: intra-arm optimizer (`api/cron/sniper-optimize.js` + `api/_lib/sniper-optimizer.js`).** On a cadence it reads each arm's own real trading record over a trailing window, including the exit-reason distribution, and proposes bounded adjustments to that arm's *inward* knobs: take-profit, trailing/stop percentages, hold time, entry-quality thresholds, and per-trade size. Every proposal is clamped to a hard range and to a small per-run step, so one run can never lurch an arm to an extreme, and a `per_trade_lamports` proposal is additionally capped at the arm's own daily budget, so the optimizer can never size a bet the budget cannot fund (the drift that used to leave an arm permanently armed but unable to buy). Below `MIN_SAMPLE` closed trades the rules stay quiet, with one exception: an arm with **zero wins** over `MIN_SAMPLE_WINLESS` or more real closes and net losses gets the single de-risking move (shrink per-trade size) and nothing else, so a winless arm can never bleed at full size while waiting to accumulate a "real" sample.

Two rules exist specifically to keep the loop honest about *size*, because `avgPnlPct` is an unweighted mean of percentages while real positions differ by up to 50x. **Rule S** fires when an arm's average percent is positive but its net lamports are negative: arithmetically that is only possible when the larger bets are the worse ones, so the arm's edge does not scale and the response is to shrink the position rather than tune an exit percentage. It runs *before* the scale-up rule and claims `per_trade_lamports` first. And the high-win-rate scale-up path now additionally requires `netPnl >= 0`, so an arm can never be handed a bigger position while it is losing real money just because its hit rate looks healthy. Both encode the fleet postmortem's first lesson: win rate and average percent are vanity metrics; expectancy in lamports is the thing being optimized. It runs **shadow by default** (`SNIPER_OPTIMIZER_MODE`): it persists what it *would* do to `agent_sniper_optimizer_runs` and mutates nothing, so you can watch it make tuning calls before it ever touches a live arm. In `apply` mode it enacts changes only for arms that opted in (`auto_optimize = true`), and logs each change to the agent's tamper-evident Reasoning Ledger (`kind = 'optimize'`) next to the trades it learned from. This is the layer that would have caught the first trade's missing take-profit automatically.

**Layer 3: portfolio evolution (`scripts/sniper-evolve.mjs` + `api/cron/sniper-evolve.js`).** Across arms, it scores each arm's fitness against the ground-truth base rate (what fraction of launches actually win, from `pump_coin_outcomes`) using Wilson confidence bounds, then reallocates the fleet's daily budget toward higher-fitness arms, retires an arm proven worse than a coin flip, and revives a retired arm after a cooldown to re-test it. It runs autonomously on a 12-hour cron (dry-run unless `SNIPER_EVOLVE_APPLY=1`) and is also runnable by hand (`node scripts/sniper-evolve.mjs --apply`); both paths share the one `runEvolve()` engine. Every move is journaled to `sniper_evolution_log` with before/after and evidence.

The division of labor is deliberate and enforced by construction: the optimizer moves per-arm entry/exit knobs and never touches budget or on/off; evolution moves budget and on/off and never touches a per-arm knob. Neither can write a safety field (`firewall_level`, `max_price_impact_pct`, `stop_loss_pct` is bounded, the daily cap); those are code-enforced at the `executeBuy` chokepoint and out of reach.

The design principle is fixed across all three: **models and loops propose, the deterministic pipeline disposes.** No autonomous output ever bypasses the firewall, the budget caps, or the confirmation gates around irreversible actions. The worst a self-tuned parameter can produce is a bad, stop-loss-protected, firewall-vetted, budget-bounded trade, fully logged and reversible with one update.

## The Oracle feedback loop: closing the silos

For a while two learning systems ran without talking to each other. The Oracle/intel engine learns *which launch signals predict a coin pumping* (`intel-learn`, every 15 min) and trained on coarse chart labels: a coin "won" if it hit ATH >= 3x at any point. The sniper optimizer learns *which config makes money* from realized PnL. Neither fed the other, and the Oracle never saw a single real trade result, even though a coin can spike 3x on the chart while the sniper still loses (bought late, timed-out exit). Three bridges now connect them:

- **Bridge 1: realized PnL trains the Oracle.** `api/cron/oracle-realized-labels` derives each traded coin's real win/loss from `agent_sniper_positions` into `oracle_realized_outcomes`, and `trainWeights` prefers that label over the chart label. The Oracle now learns from real money where it has it, and falls back to chart outcomes where it doesn't. Realized labels are scarce but gold-standard.
- **Bridge 2: the optimizer uses the Oracle.** `api/cron/sniper-optimize` joins each arm's trades to the Oracle conviction the coin had at entry, buckets the realized win rate by conviction band, and (Rule O) tunes `min_oracle_score` toward the band where that arm actually wins. This already surfaced a real finding: the fleet had mostly been sniping sub-30-conviction coins and losing (~17% win rate), so the optimizer will raise the conviction floor once it has enough high-conviction trades to prove the lift.
- **Bridge 3: calibration.** `api/cron/oracle-calibrate` measures, per conviction band, whether the Oracle's score matches the *realized* win rate (does an 80 actually win ~80%?) and writes a bounded correction factor to `oracle_calibration`, exposed at `GET /api/oracle/calibration`. The correction is applied through the optimizer's entry-threshold tuning rather than by overwriting the canonical conviction score, which would feed back into its own measurement.

The direction of every bridge is the same: real, realized money is the ground truth, and every layer of judgment is pulled toward what actually paid.

## Try it

- Arm your first strategy: [the sniper tutorial](/tutorials/arm-an-agent-sniper)
- Watch the engine think: [Coin Intelligence and the trading surfaces](./trading-surfaces.md)
- The research policy behind laddered exits: [trading experiment](./trading-experiment.md)
- The story of the first trade, for non-operators: [the blog post](/blog/first-autonomous-trade)
