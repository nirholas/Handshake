# agent-sniper

Autonomous pump.fun sniper. A long-lived Node worker that snipes from the
**agent's own** Solana wallet, then manages each position to a stop-loss /
take-profit / trailing-stop / timeout exit. Two triggers arm a strategy:

- **`new_mint`** (default) — holds the PumpPortal new-mint feed open and scores
  each launch as it happens.
- **`first_claim`** — polls the on-chain pump.fun fee-claim stream and fires when
  a creator pulls their accrued creator/delegated rewards for the **first time
  ever** — an irreversible "the creator is live and taking real fees" signal.
  Buys the creator's coin after an owner-set delay.
- **`graduation_ride`** — listens for PumpPortal migration events and buys the
  coin's fresh pump AMM pool the moment it leaves the bonding curve, to sell
  into pump.fun's BOOST window (live 2026-07-21: ~17.6 SOL of buyback+burn
  TWAP'd over the 5 minutes after every non-Mayhem migration). The exit is the
  unchanged exit engine: `max_hold_seconds` set inside the window (e.g. 240 s)
  is the timed sell, stop-loss/trailing-stop stay the rails.

It is deliberately **not** a scheduled cron: periodic ticks can't snipe a launch.

## Architecture

| File | Role |
|------|------|
| `index.js` | Entrypoint. Feed subscription, buy queue, position sweep, feed watchdog, graceful shutdown. |
| `config.js` | Validated env (`loadConfig`). Throws on missing `DATABASE_URL`/`JWT_SECRET`; refuses live mode without a real RPC. |
| `strategy-store.js` | Cached active-strategy list + `countOpenPositions` / `getDailySpend` / `getOpenPositions`. |
| `scorer.js` | Pure `scoreMint(mint, strategy)` entry filter (mc band, creator history, socials, SOL-quote). |
| `claim-scorer.js` | Pure `scoreClaim(claim, strategy)` entry filter for the first-claim trigger (claim-size band, mint resolvable). |
| `first-claim-watch.js` | `startFirstClaimWatch` — polls the fee-claim stream, scores first-ever claims, holds the owner-set delay, snipes via `executeBuy`. |
| `keys.js` | `loadAgentKeypair` — decrypts the agent secret via `recoverSolanaAgentKeypair`, TTL-cached, audited. |
| `trade-client.js` | Wraps `PumpTradeClient`; `signAndSend` assembles a v0 tx, signs with the agent keypair, broadcasts, confirms. |
| `executor.js` | `executeBuy` / `executeSell` — every guardrail, the idempotency lock, the only place that signs. Routes graduated coins through the AMM. |
| `positions.js` | `runPositionSweep` — re-quotes open positions (curve OR AMM) and triggers exits. |
| `graduation-ride.js` | `graduationRideGate` (pure, tested) + `executeBoostRideBuy` — the BOOST-window entry: gate the migration event, wait for the new AMM pool, buy via `executeBuy` with `venue:'amm'`. |
| `amm-exit.js` | `quoteAmmSell` / `buildAmmSellInstructions` / `isGraduated` — post-graduation AMM pricing + sell build (shared with the user-driven path's pool resolution). |
| `exit-logic.js` | `decideExit` / `decideLadderedExit`: the pure exit brain. No I/O and no clock of its own, so it is fully unit-tested and replayable. |
| `reconcile.js` | `reconcileVanishedBag` / `getWalletBaseBalance` makes the CHAIN the source of truth when a sell's confirmation was lost. |
| `mayhem-gate.js` | The Mayhem exclusion gate (guardrail 8), reading `isMayhemMode` off the bonding curve through the rotating RPC chain. |
| `oracle-gate.js` / `oracle-crossing.js` | Oracle conviction gate, and the `oracle_crossing` trigger that fires when a coin's conviction crosses upward. |
| `llm-judge.js` / `judge-knowledge.js` | The `decision_mode='llm'` verdict path, and the tiered budget of what each arm's judge is allowed to see. |
| `prelaunch-radar.js` + `radar-detect.js` / `radar-scorer.js` / `radar-watchlist.js` | Pre-launch creator-wallet radar: on-chain precursor detection, pure scoring, and the watchlist it works from. |
| `alpha-hunt.js` | Pure scorer for the `alpha_hunt` strategy. |
| `swarm.js` | Trading-swarm consensus + settlement loops. |
| `market-maker.js` | Range-based market maker on pump.fun coins, executed through Jito. |
| `launcher.js` / `auto-claimer.js` | Autonomous coin launcher, and the creator-fee auto-claimer for agent-launched coins. |
| `auto-funder.js` | Buy-side auto-funding loop that refills armed agents from the launcher master wallet. |
| `journal.js` | Trade journal, the "learn what works" surface behind the reasoning ledger. |
| `heartbeat.js` / `error-tracker.js` / `alerts.js` | Liveness heartbeat, sliding-window error tracker, and ops alerting. |
| `log.js` / `screen-push.js` | Structured logging, and the fire-and-forget push to the agent screen stream. |
| `recompute-wallet-graph.js` | The Smart-Money Wallet Graph recompute job. |

State lives in two tables (migrations `…20260615020000_agent_sniper.sql` +
`…20260615030000_sniper_first_claim.sql`): `agent_sniper_strategies` (owner-armed
policy, incl. `trigger`, `buy_delay_ms`, and the `*_claim_lamports` filters) and
`agent_sniper_positions` (the sniper's own trade ledger, tagged with the
`entry_trigger` that opened it — *not* `pump_agent_trades`, whose `mint_id` FK
can't hold a stranger-launched mint).

## First-claim trigger

A `first_claim` strategy is armed exactly like a `new_mint` one (POST
`/api/sniper/strategy` with `trigger: "first_claim"`), plus claim-specific knobs:

| Field | Meaning |
|-------|---------|
| `buy_delay_ms` | Wait this long after the claim is observed before buying (0–600000). |
| `min_claim_lamports` | Only fire when the first claim pulled ≥ this — a floor that skips dust. |
| `max_claim_lamports` | Optional ceiling. |
| `first_claim_max_age_seconds` | Ignore claims older than this when first seen (overrides `SNIPER_CLAIM_MAX_AGE_S`). |

The poll loop reuses the SAME executor, idempotency lock, budget/concurrency
caps, and position lifecycle as the new-mint path — only the trigger differs.

## Guardrails

Enforced in `executeBuy`, short-circuiting before any transaction:

1. **Global kill** — `SNIPER_GLOBAL_KILL=1` halts new buys (positions still managed).
2. **Per-agent kill** — `kill_switch` column; killed agents drop out of the active set and any open position exits at market.
3. **Daily budget cap** — `daily_budget_lamports` vs today's committed spend.
4. **Max concurrent positions** — `max_concurrent_positions`.
5. **Mandatory stop-loss** — DB `CHECK (stop_loss_pct > 0)` + runtime filter.
6. **Price-impact circuit breaker** — `max_price_impact_pct` checked against a fresh `quoteForBuy`.
7. **Idempotency** — `INSERT … ON CONFLICT (agent_id, mint, network) DO NOTHING` claims the slot before the tx; one shot per mint per agent.
8. **Mayhem exclusion (owner rule)** — the first gate: never buy pump.fun "Mayhem"-mode tokens, only regular launches. Reads `isMayhemMode` off the on-chain bonding curve (cached per mint) via `mayhem-gate.js`, through the platform's **rotating multi-endpoint RPC chain** with bounded retries; a single throttled provider can no longer starve the gate into permanent "unknown". Applies to **every** trigger path, since it lives in the `executeBuy` chokepoint. `SNIPER_MAYHEM_FILTER=0` disables; strict-on-unknown is the default (`SNIPER_MAYHEM_STRICT=0` restores allow-on-unknown).
9. **Market-cap band (owner rule)** — buy only inside a market-cap window. Enforced at the `executeBuy` chokepoint (`marketCapBandReason`), so `new_mint`, `intel`, `alpha`, `first_claim`, `radar` and `swarm` all obey it. **Fails closed**: a coin whose market cap can't be confirmed inside the band is skipped, not bought. A per-strategy `min/max_market_cap_usd` only *tightens* the fleet-wide floor/ceil (`SNIPER_MIN_MC_FLOOR_USD` / `SNIPER_MAX_MC_CEIL_USD`) — it can never loosen it. On a blind `new_mint` snipe the create-event cap is ~$4k, so a $10k floor correctly rejects brand-new launches; use the `intel_confirmed` trigger to buy a coin *after* it pumps into the band.
10. **Realized-loss circuit breaker (portfolio layer)** — once an agent's **net realized loss over the trailing 24 h** crosses its cap, it stops opening new positions for the rest of the window. Catches a fleet that bleeds one losing entry at a time — each trade passes the per-trade caps yet the wallet still grinds down. A profitable or break-even day never trips it; a DB hiccup never blocks (the lamports caps stay the backstop). The fleet-wide `SNIPER_MAX_DAILY_LOSS_SOL` protects every agent at once and is tightened by an optional per-strategy `daily_loss_limit_lamports`. **The same breaker gates the auto-funder** — a wallet past its loss cap stops being refilled, so the master can't keep pouring SOL after a wallet that only loses.
11. **Agent scoping** — `SNIPER_AGENT_IDS` restricts the worker to a specific set of agents, so a bounded run against the shared DB can't act on every other armed strategy.
12. **Adversarial Risk Officer**: the last gate, and the only one that is not a number. See the section below. **Off by default in the sense that matters**: it reviews, but it does not enforce until an owner arms it.

> **Wallet/funds pre-check.** An agent with no wallet or too little SOL is skipped
> *before* the idempotency claim, so it leaves no `failed` position row — those
> aborts used to dominate the feed. Only post-broadcast failures persist a row.

> **Single-worker assumption.** Budget/concurrency races are prevented by an
> in-process per-agent lock. Run exactly ONE instance. Scaling out requires an
> atomic DB spend reservation instead.

> **Master funding cap.** Set `LAUNCHER_MASTER_DAILY_CAP_SOL` to bound how much SOL
> can leave the launcher master wallet per UTC day across *all* automated funders
> (`api/_lib/launcher-funding.js`). This is a hard backstop that a loose per-call
> cap can't bypass — recommended whenever armed strategies auto-fund from the master.

> **Exit reconciliation (chain over DB).** A sell whose confirmation times out may
> still land. On a RETRY of a previously-failed sell, `executeSell` first reads the
> wallet's real token balance (`reconcile.js`): balance zero means a prior broadcast
> landed, so the worker finds the transaction that emptied the bag and closes the
> position with its actual proceeds (`error = 'reconciled_onchain'`) instead of
> retrying a sell that can only revert (pump error 6023, `NotEnoughTokensToSell`);
> a short balance clamps the sell to what the wallet really holds.
>
> The search covers the DERIVED associated-token address for both token programs,
> not just live token accounts: an emptying sell usually closes the account in the
> same transaction to reclaim rent, and a closed account keeps its signature
> history but disappears from an account listing.
>
> **When the emptying tx cannot be found**, the position parks as
> `reconcile_pending` with `reconcile_pending_since` stamped. A park is not free:
> `countOpenPositions()` counts `opening`/`open`/`closing`, so a parked position
> holds one of its arm's `max_concurrent_positions` slots. Two bounds keep that
> from becoming permanent:
>
> - After `RECONCILE_GIVE_UP_MS` (6 h) the position books `closed` with
>   `error = 'reconcile_unresolved'` and realized P&L left **NULL** — the bag is
>   provably gone but its proceeds are unknowable, and every P&L query filters
>   NULL out, so the slot frees without inventing a number.
> - A `closing` lock older than 10 minutes is released back to `open` by
>   `getOpenPositions()`. `closing` is held for seconds around a broadcast, so an
>   older one is an abandoned attempt from a worker restart; the release keys off
>   `last_quoted_at`, so a position still being worked is never disturbed.
>
> **A settled position can never return to `open`.** A database trigger
> (`sniper_block_resurrect`) coerces the status back and records the attempt in
> `sniper_resurrect_attempts`. The invariant lives in the DB because the worker is
> deployed separately: an old image with the unguarded park cannot violate it, and
> a non-empty recent window in that table means such an image is still running.
>
> To clear positions already parked without waiting for a worker deploy:
> `node scripts/sniper-reconcile-wedged.mjs` (re-reads every real on-chain balance
> and skips anything still holding tokens).

## Adversarial Risk Officer

Every guardrail above answers a question with a number: is the market cap inside
the band, is the impact under the ceiling, does the round-trip simulation revert.
None of them asks the question a human risk desk asks last: *knowing everything
we know, is this specific trade still a good idea?*

`risk-officer.js` is that second opinion, and it is deliberately **adversarial**.
It is not the buy-side judge (`llm-judge.js`) run twice. The judge is looking for
a reason to buy; the officer is shown the proposed trade **plus the judge's own
thesis** and told to assume the trade is bad until the facts prove otherwise.
That asymmetry is the whole value. Running the same optimistic prompt again would
only launder the first answer.

It runs at the end of `executeBuy`, after the quote and after the firewall, so it
sees the real price impact and the real safety verdict rather than estimates.

### Levels

| Level | Behaviour |
|---|---|
| `shadow` (default) | The review runs and is recorded, and **nothing changes**. Fire-and-forget, so it adds **zero latency** to the buy path. |
| `enforce` | Awaited before the broadcast. A `block` severity kills the buy; a smaller `size_adjustment` shrinks it. |
| `off` | Never called. |

Set fleet-wide with `SNIPER_RISK_OFFICER`; a strategy's own `risk_officer_level`
column overrides it. An unrecognised value on a row degrades to `shadow` and
stops there rather than falling through to the env default, so a typo in one
strategy can never silently arm enforcement.

**Shadow is the default on purpose.** Enforcement decides what the live fleet
buys with real SOL, so arming it is an owner decision, not a deploy-time default.
Shadow mode is how that decision gets its evidence: `sniper_risk_reviews`
accumulates the vetoes the officer *would* have cast against the positions that
actually opened, and those positions' realized P&L answers whether it was right.

```sql
-- Would the officer have made money? Join its shadow calls to what happened.
select r.severity,
       count(*)                                            as trades,
       round(avg(p.realized_pnl_lamports) / 1e9, 5)        as avg_pnl_sol
  from sniper_risk_reviews r
  join agent_sniper_positions p on p.id = r.position_id
 where r.level = 'shadow' and p.status = 'closed'
   and p.realized_pnl_lamports is not null
 group by r.severity;
```

If the `block` row's average P&L is meaningfully worse than the `none` row's, the
officer is catching real losers and is worth arming. If it is not, it is noise
and should stay in shadow. That table is the argument, in either direction.

### It fails OPEN, unlike the firewall

The firewall *proves* a coin is not a honeypot, so an unavailable firewall must
block: "couldn't prove it's safe" is not "safe". The officer is a judgment layer
sitting **behind** that proof. If the model is down, timed out, saturated, or
answers with something unparseable, every mechanical gate has already passed and
the trade proceeds unchanged, with a `degraded` row in the ledger. A reviewer
outage must never become a fleet-wide halt.

### Sizing

The officer is told to prefer a smaller size over a full veto when the concern is
size-shaped rather than existential. A size adjustment may only ever **shrink**
the trade: a suggestion at or above the proposed size is ignored, and one below
the network minimum clamps up to that floor rather than aborting, because the
officer asked for less risk, not for no trade. After a cut the trade is re-quoted
so the recorded entry impact describes the buy that was actually sent.

### Which brain reviews

Unset by default, and that default is deliberate: with no model named the officer
asks the platform's own free-first chain (`llmComplete`), which leads with Vertex
Claude on GCP credits where that is enabled. That keeps it independent of the
judge, which routes `strat.llm_model` through OpenRouter. Naming a model
(`SNIPER_RISK_OFFICER_MODEL`, or a strategy's `risk_officer_model`) routes the
review through OpenRouter first and keeps the platform chain as the backstop.
The ledger records both who was asked (`model`) and who actually answered
(`answered_by`).


## Exit reasons

`exit-logic.js` decides *whether* to exit and *what fraction* to sell;
`executeSell` writes the outcome to `agent_sniper_positions.exit_reason`. The
full set the worker can produce:

| Reason | Fired by | Meaning |
|--------|----------|---------|
| `stop_loss` | `decideExit` | Hard stop. Always a FULL exit, and it outranks every other reason. |
| `trailing_stop` | `decideExit` | Gave back `trailing_stop_pct` from the position's peak. |
| `take_profit` | `decideExit` | Reached `take_profit_pct`. |
| `timeout` | `decideExit` | Held past `max_hold_seconds`. |
| `signal_flip` | `decideExit` | Paid x402 sentiment turned confidently bearish on an UNDERWATER position. Opt-in via `SNIPER_EXIT_ON_BEARISH`. |
| `take_initials` | `decideLadderedExit` | The ladder sold enough to recover the initial cost basis. Normally a PARTIAL sell that leaves a moon bag riding; it only books the position closed when the fraction rounds down to a full exit. |
| `liquidity_decay` | `positions.js` | The market went dead: quoted value stopped moving for `SNIPER_LIQUIDITY_DECAY_S`. Exits and frees the concurrency slot. A position already on house money keeps its moon bag. |
| `kill_switch` | `positions.js` | The agent's `kill_switch` column was set; open positions exit at market. |
| `manual` | `/api/sniper/close` | Closed by the owner. |
| `graduated` | exit path | Booked against the post-graduation AMM rather than the dead curve. |
| `error` | `executeSell` | The bag is provably gone but its proceeds are unknowable (`error='reconcile_unresolved'`), so P&L is left NULL rather than invented. |

> **These values are constrained in the database.** `agent_sniper_positions` has a
> CHECK on `exit_reason`, so adding a reason in JavaScript without widening that
> constraint produces a close that the database rejects *after* the sell has
> already landed on-chain. `executeSell` treats any failure of that write as a
> retryable sell and resets the row to `open`, so the position re-sells nothing,
> re-fails, and wedges forever while holding a concurrency slot. This is not
> hypothetical: `liquidity_decay` shipped that way and never once booked an exit.
> `tests/sniper-exit-reason-constraint.test.js` now pins the two lists together;
> a new reason must land in a migration in the same change.

## Decision modes and the experiment fleet

Every strategy row carries a `decision_mode`:

- **`rules`** (default): the scorer/oracle gate chain documented above.
- **`llm`**: no rule shields at all (no market-cap band, no socials requirement,
  no oracle threshold, no creator gates). Each new launch is judged by a model
  (`llm-judge.js`): the strategy's `llm_model` (an OpenRouter slug, e.g.
  `x-ai/grok-4.3`, `anthropic/claude-haiku-4.5`, `openrouter/auto`) returns
  `{buy, confidence, thesis}`; the buy fires only at `confidence >=
  llm_min_confidence` (default 0.6). The thesis is journaled with the position and
  written to the reasoning ledger. Verdicts are shared per (mint, model), a small
  concurrency cap (`SNIPER_LLM_MAX_CONCURRENT`) drops launches instead of queueing
  unboundedly, and the platform's free-first `llmComplete` chain backstops an
  OpenRouter outage. The non-negotiable safety rails (Mayhem exclusion, trade
  firewall round-trip, budgets, concurrency, headroom, spend policy) still apply
  to both modes at the `executeBuy` chokepoint.

The fleet's experiment groups: **rules** (shield-based entries at different
strictness), **oracle** (conviction-gated), **llm** (model-judged), and
**boost** (event-driven — the `graduation_ride` arm above, which trades the
post-migration BOOST buyback window instead of new launches).

Strategies also carry a human `label` + `experiment_group` so deliberately
different rule sets can trade side by side and be compared honestly:
`scripts/seed-sniper-experiments.mjs` shapes the fleet (dry-run by default,
`--apply` writes), `/api/sniper/experiments` aggregates each arm's REAL on-chain
record, and **/sniper/experiments** is the public scoreboard.

Oracle-gated arms get one more fairness rule: a below-threshold conviction score
on a coin younger than `SNIPER_ORACLE_MATURITY_S` (default 900 s) is treated as
*unscored* (fail open, logged as `oracle_immature`): brand-new mints score 15-25
on thin data, which used to disqualify every `min_oracle_score` strategy from
ever sniping a launch.

**Judgment ledger.** Every LLM verdict, buys AND skips, is persisted to
`sniper_llm_verdicts` (one row per mint+model; fire-and-forget) and scored
against `pump_coin_outcomes` an hour later: buy precision (advised buys that
pumped 3x or graduated) and missed winners (advised skips that did). This
measures each model's calls independent of position size or simulate mode; the
scoreboard renders it as the "Judgment ledger" section on /sniper/experiments.

## Environment

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `DATABASE_URL` | ✅ | — | Neon Postgres. |
| `JWT_SECRET` | ✅ | — | Decrypts agent Solana secrets. |
| `SOLANA_RPC_URL` / `HELIUS_API_KEY` | live only | — | Public RPC 429s under the firehose; required for `live`. |
| `SNIPER_MODE` | | `simulate` | `simulate` = real quotes, no broadcast; `live` = real trades. |
| `SNIPER_NETWORK` | | `mainnet` | `mainnet`/`devnet`. |
| `SNIPER_GLOBAL_KILL` | | `0` | `1` halts new buys. |
| `SNIPER_POLL_MS` | | `5000` | Position re-quote cadence. |
| `SNIPER_MAX_GLOBAL_BUYS_PER_MIN` | | `10` | Platform-wide buy throttle backstop. |
| `SNIPER_MAYHEM_FILTER` | | `1` | Enforce the no-Mayhem rule (skip pump.fun Mayhem-mode tokens). `0` disables. |
| `SNIPER_MAYHEM_STRICT` | | `1` | Skip a buy when the bonding curve can't be read even after retries (never buy Mayhem, not "buy when unsure"). `0` restores allow-on-unknown. |
| `SNIPER_ORACLE_MATURITY_S` | | `900` | A below-threshold Oracle score on a coin younger than this counts as unscored (fail open); provisional thin-data scores must not disqualify launch snipes. |
| `SNIPER_LLM_MAX_CONCURRENT` | | `3` | LLM-judge concurrency cap; launches beyond it are skipped with a log line, never queued unboundedly. |
| `SNIPER_LLM_TIMEOUT_MS` | | `9000` | Per-verdict LLM time budget. |
| `OPENROUTER_API_KEY` | llm arms | unset | One key serves every experiment model; the free-first `llmComplete` chain backstops an outage. |
| `SNIPER_AGENT_IDS` | | — | Comma/space-separated agent UUID allowlist. Unset = all agents for the network. |
| `SNIPER_RISK_OFFICER` | | `shadow` | Fleet-wide default level for the adversarial Risk Officer: `shadow` reviews and records without changing the trade, `enforce` lets a veto abort the buy, `off` skips it. A strategy's `risk_officer_level` overrides it. |
| `SNIPER_RISK_OFFICER_MODEL` | | unset | Route the review through OpenRouter on this model. Unset (default) asks the platform's free-first chain instead, which prefers GCP-credit Vertex Claude where enabled. |
| `SNIPER_RISK_OFFICER_TIMEOUT_MS` | | `6000` | Per-review time budget. The review sits between a quote and a broadcast; an officer that answers late has already answered wrong. |
| `SNIPER_RISK_OFFICER_MAX_CONCURRENT` | | `3` | Concurrent reviews. Past the cap the buy proceeds unreviewed (fail open), never queued. |
| `SNIPER_MIN_MC_FLOOR_USD` | | — | Fleet-wide market-cap floor (USD). Buys below it are skipped across every agent; a per-strategy `min_market_cap_usd` only tightens it. Unset = no floor. |
| `SNIPER_MAX_MC_CEIL_USD` | | — | Fleet-wide market-cap ceiling (USD). Buys above it are skipped; a per-strategy `max_market_cap_usd` only tightens it. Unset = no ceiling. |
| `SNIPER_MAX_DAILY_LOSS_SOL` | | — | Fleet-wide realized-loss cap (SOL) per trailing 24 h. An agent past it stops opening positions AND stops being auto-funded. Tightened by per-strategy `daily_loss_limit_lamports`. Unset = no cap. |
| `LAUNCHER_MASTER_DAILY_CAP_SOL` | | — | Hard per-UTC-day ceiling on total master-wallet outflow across automated funders. Unset = no cap. |
| `SNIPER_AUTO_FUND_MIN_SOL` | | `0.02` | Auto-funder: refill an armed agent's wallet when it drops below this. |
| `SNIPER_AUTO_FUND_TARGET_SOL` | | `0.05` | Auto-funder: balance a low wallet is topped up to. |
| `SNIPER_AUTO_FUND_PER_TX_SOL` | | `0.1` | Auto-funder: max SOL moved in one top-up. |
| `SNIPER_AUTO_FUND_DAILY_SOL` | | `1.0` | Auto-funder: max SOL moved per UTC day across **all** agents. |
| `SNIPER_AUTO_FUND_PER_AGENT_DAILY_SOL` | | `0.25` | Auto-funder: max SOL any **single** agent can draw per UTC day — stops one bleeding wallet from consuming the whole fleet budget. `0` = off. |
| `SNIPER_CONFIRM_TIMEOUT_MS` | | `60000` | Per-trade confirmation wait. |
| `SNIPER_CLAIM_POLL_MS` | | `30000` | First-claim trigger: fee-claim poll cadence. |
| `SNIPER_CLAIM_LOOKBACK_S` | | `600` | First-claim trigger: window scanned each poll (must exceed the poll interval). |
| `SNIPER_CLAIM_MAX_AGE_S` | | `300` | First-claim trigger: default freshness gate (per-strategy override available). |
| `SNIPER_LIQUIDITY_DECAY_S` | | `300` | Exit a position whose quoted value has not moved for this long (the `liquidity_decay` exit). `0` disables. |
| `SNIPER_EXIT_ON_BEARISH` | | `0` | Arm the `signal_flip` exit: read paid sentiment on an underwater position and cut it early. |
| `SNIPER_EXIT_BEARISH_MIN_CONFIDENCE` | | `0.7` | Confidence floor a bearish verdict must clear before `signal_flip` fires. |
| `SNIPER_MIN_TRADE_LAMPORTS` | | `10000` | Floor on any single trade; smaller sizes are skipped rather than broadcast as dust. |
| `SNIPER_STRATEGY_REFRESH_MS` | | `15000` | How often the active-strategy cache is refreshed (floor 5000). |
| `SNIPER_FEED_WATCHDOG_MS` | | `180000` | Reconnect the mint feed if it goes silent this long (floor 30000). |
| `SNIPER_HEARTBEAT_MS` | | `30000` | Liveness heartbeat cadence (floor 10000). |
| `SNIPER_HEARTBEAT_SELF_HEAL_MS` | | see `config.js` | How long a stalled subsystem may run before the heartbeat restarts it. |
| `SNIPER_ERROR_ALERT_THRESHOLD` / `SNIPER_ERROR_ALERT_WINDOW_MS` | | see `config.js` | Sliding-window error count and window that trip an ops alert. |
| `SNIPER_ANNOUNCE` | | `1` | Announce worker start/stop. `0` quiets a noisy dev run. |

Subsystem toggles. Each turns a whole side-loop on or off; all default ON except
where noted, so an unset variable runs the full worker:

| Var | Default | Notes |
|-----|---------|-------|
| `SNIPER_INTEL` | `1` | Coin-intel enrichment. `0` for a trade-only worker. Tuned by `SNIPER_INTEL_LLM`, `SNIPER_INTEL_MAX_CONCURRENT`, `SNIPER_INTEL_WINDOW_MS`. |
| `SNIPER_RADAR` | `1` | Pre-launch creator-wallet radar. `0` degrades to feed-only entries. Tuned by the `SNIPER_RADAR_*` family (`_POLL_MS`, `_MAX_AGE_MS`, `_MAX_WATCH`, `_MIN_FUNDING_LAMPORTS`, `_MIN_GRADUATED`, `_SM_MIN_SCORE`, `_WALLETS_PER_TICK`, `_WATCHLIST_REFRESH_MS`, `_DEPLOY_WATCH_TTL_MS`). |
| `SNIPER_MARKET_MAKER` | `1` | Range-based market maker. Cadence via `SNIPER_MM_INTERVAL_MS`. |
| `SNIPER_LAUNCHER` | on iff `AGENT_JWT` | Autonomous coin launcher. Poll cadence via `SNIPER_LAUNCHER_POLL_MS`. |
| `SNIPER_AUTO_CLAIM` | on iff `AGENT_JWT` | Creator-fee auto-claimer. Poll cadence via `SNIPER_AUTO_CLAIM_POLL_MS`. |
| `SNIPER_CROSSING_POLL_MS` / `_MAX_AGE_MIN` / `_SCORE_AGE_MIN` | see `config.js` | Oracle conviction-crossing trigger cadence and freshness bounds. |
| `SNIPER_SENTIMENT_FRESH_MIN` / `SNIPER_RUGPULL_FRESH_MIN` | see `config.js` | How long a cached sentiment or rug-pull read stays usable. |

`config.js` is the authoritative list: every value above is read there through
`num()` / `bool()` with the default shown.

## Run locally

```bash
# from repo root, with env exported (DATABASE_URL, JWT_SECRET, HELIUS_API_KEY)
npm run db:migrate                      # once — creates the two tables
SNIPER_MODE=simulate node workers/agent-sniper/index.js
```

Arm a test agent (owned by you, wallet funded with a little SOL) by inserting a
strategy row, then watch it score → open → exit. Flip to `SNIPER_MODE=live`
with tiny caps to land one real trade. `Ctrl-C` drains in-flight buys and exits.

## Deployment

The worker runs in production as **its own Cloud Run service, `agent-sniper`**
(project `aerial-vehicle-466722-p5`, region `us-central1`), separate from
`three-ws-api`. It has no HTTP port: it is a long-lived background process, so
it runs with `--no-cpu-throttling` and `minScale=maxScale=1` (see the
single-worker assumption above; a second instance would race the budget and
concurrency caps).

**It does not ride along with an API deploy.** A fix merged to `main` keeps
running the old image until this service is explicitly rolled, which has more
than once made a fixed bug look unfixed. Check what is actually running before
concluding anything from behaviour:

```bash
gcloud run services describe agent-sniper --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --format="value(status.latestReadyRevisionName)"
```

Build (from the REPO ROOT, because the Dockerfile copies `api/`, `src/`, `packages/`,
and `agent-payments-sdk/`), then roll the service onto the new image:

```bash
gcloud builds submit --config workers/agent-sniper/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5

gcloud run services update agent-sniper --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --image us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/workers/agent-sniper:latest
```

Both service accounts are pinned deliberately: builds run as `three-ws-build@`
(the project's default compute SA was deleted, so an unpinned build fails before
its first step) and the service runs as `agent-sniper-sa@`. That runtime account
is **not** the API's `three-ws@`, so a permission the API already has is not
automatically available here. It needs `roles/aiplatform.user` of its own for
the Vertex rung of the `llmComplete` chain, without which the LLM judge falls
through to rate-limited free tiers and stops issuing verdicts.

Secrets come from Secret Manager (`sniper-database-url`, `sniper-jwt-secret`,
`wallet-sniper-master-b64`, `OPENROUTER_API_KEY`); the rest are plain env on the
service. Update single keys with `--update-env-vars`, never `--set-env-vars`,
which replaces the entire set.

Some state changes need no deploy at all. The exit-reason CHECK above lives in
the database, so widening it with `npm run db:migrate` takes effect on the
already-running worker immediately.

## Graduated-position exit

A position whose coin **graduates** off the bonding curve mid-hold is exited
automatically through the canonical pump AMM pool — it never parks. The
bonding-curve sell path detects graduation (the SDK's `CoinGraduatedError`), then
re-routes the same exit through `amm-exit.js` (`buildAmmSellInstructions`), which
reuses the platform's pool resolution (`getAmmPoolState`) and `PumpAmmSdk`
(`sellBaseInput`) — identical to the user-driven sell in `api/pump/[action].js`.
The slippage-derived min-out floor is embedded on-chain, so a thin post-graduation
pool can't sandwich the exit.

`runPositionSweep` re-quotes graduated positions off the AMM (not the dead curve),
so stop-loss / trailing / take-profit / timeout keep firing against the real
post-graduation price, and PnL is computed against the live AMM quote. A position
flagged `error='graduated:awaiting_amm_exit'` is re-quoted and exited on the next
sweep — no terminal park state.

To clear a backlog (or force the exit right after deploy instead of waiting for
the next poll), run the one-shot backfill — idempotent, honors `SNIPER_MODE`:

```bash
SNIPER_MODE=simulate node scripts/sniper-backfill-graduated.mjs
```
