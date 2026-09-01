# Strategy Objects and the Strategy Lab

A Strategy Object is a trade strategy as a first-class thing you can own: a structured, validated rule set (entry conditions, sizing, take-profit, stop-loss, risk caps) that your agent can equip and run on-chain, ranked on a leaderboard by real live performance and forkable by anyone. The Strategy Lab is the workbench: write a strategy as data, validate it, backtest it against real recorded pump.fun history with the same evaluator its live runs use, and run it live or in simulation, end to end. Both run strategies as additional constraints on top of your agent's server-side spend policy, never a way around it.

Pages: [/strategies](https://three.ws/strategies) (the library and leaderboard), [/strategy-lab](https://three.ws/strategy-lab) (the workbench)
API: `GET/POST /api/strategies`, `GET /api/strategies/leaderboard`, `GET/PATCH/DELETE /api/strategies/:id`, `POST /api/strategies/:id/{fork,publish}`, `GET/POST/PATCH/DELETE /api/dca-strategies`, the Lab's `POST /api/pump/strategy-{validate,backtest,run,close-all}`, and the sniper backtester `POST /api/sniper/backtest`

## Why it exists

Most "strategies" in crypto are a screenshot and a promise. three.ws makes a strategy an object with a real schema, a real owner, and a real, on-chain track record. That does three things at once.

First, it makes strategies honest. A Strategy Object's performance is aggregated from real closed positions (`agent_strategy_positions`) across every agent that equipped it. A strategy with no closed trades is labeled "Unproven", never dressed up with a fabricated backtest curve. The leaderboard ranks by verified live ROI, not by claims.

Second, it makes them composable. Because a strategy is data with a validated shape, it can be forked (the rules copy into your library with lineage credited to the author, and you run them under your own spend policy, no wallet access is ever transferred), edited, versioned, published, and equipped on any agent you own.

Third, it makes them safe to run. The strategy's own caps (per-trade size, slippage, concurrency) are layered on top of the agent's server-side spend leash. The runtime sizes a buy from the strategy config, but the trade still passes through the full guard and custody path, so a strategy can never spend past your limits.

## How it works

### The Strategy Object schema

Every strategy is normalized and validated by `api/_lib/strategy-schema.js` before it persists. Free text is impossible; a malformed rule set cannot be saved. The config has four sections:

- **entry**: trigger (`new_launch`), `max_age_minutes`, optional min/max market cap, min liquidity, `require_socials`, creator-history gates (`max_creator_launches`, `min_creator_graduated`), and `require_sol_quote`.
- **sizing**: `amount_sol` per trade and `max_slippage_bps`.
- **exits**: `take_profit_pct`, a mandatory `stop_loss_pct`, optional `trailing_stop_pct`, and `max_hold_minutes`. Validation requires a stop-loss and at least one upside exit.
- **risk**: `max_concurrent_positions` and `cooldown_minutes`.

The schema enforces hard bounds on every field, so a stored config can never carry a nonsense number into the runtime. Two pure, synchronous functions, `matchesEntry` (does this real launch pass the entry gate) and `shouldExit` (should this open position close now), are the same logic the live equipped-strategy runtime (`api/_lib/agent-strategy-runtime.js`) and the assisted scan preview (`POST /api/trading/scan`) both evaluate, so a stored rule means exactly the same thing everywhere it runs. The assisted scan is owner-scoped and rate-limited twice (per IP and per owner, because every match it prices costs an upstream call); when the live launch feed cannot be reached it answers `502 feed_unavailable` rather than an empty scan that looks like "nothing matched".

### The library, leaderboard, and forking

`/strategies` has three surfaces on one page: the marketplace of published strategies (proven first), the leaderboard ranked by real live ROI, and your own library (create, edit, publish, equip, delete). The full-page builder lives in the URL (`?editor=new` or `?editor=<id>`) so it survives reload and the back button. Forking copies the rules only, credits lineage to the author, and gives you fresh ownership; equipping attaches the strategy to an agent you own, which then runs it under its own spend policy.

### The Strategy Lab

`/strategy-lab` is where you build and prove a declarative pump.fun strategy. The Lab speaks its own tiny strategy DSL (a spec with `scan`, `filters`, `entry`, and `exit` predicate rules), and one compiled evaluator powers validation, backtest, and live runs, so they cannot drift:

- **Validate** (`POST /api/pump/strategy-validate`) checks the spec with the same validator the runner uses, so a broken spec is caught with field-level issues before anything runs. No sign-in needed.
- **Backtest** (`POST /api/pump/strategy-backtest`, sign-in required) replays the compiled strategy over real recorded on-chain history: for each candidate mint (from the request's `mints`, the spec's `scan.mints`, or a live scan of new or trending launches served by the pump.fun MCP's `get_new_tokens` and `get_trending_tokens`, which read pump.fun's public feed and the platform's own launch recorder, so no external indexer is needed) it fetches the token's real details, holders, bonding curve, and recent trades, evaluates the entry gate at the first recorded trade, then walks the subsequent real trades to trigger the exit rules. It never synthesizes launches or invents price paths; the response's `data` carries `spent`, `realizedPnlSol`, `roiPct`, `tradeCount`, `winRate`, `maxDrawdownSol`, the per-mint `trades`, and `mintsUsed`.
- **Run** (`POST /api/pump/strategy-run`) executes the strategy for a bounded duration (5 to 600 seconds) and streams events over Server-Sent Events. In **simulate** mode it needs no wallet and spends nothing; in **live** mode it requires auth, an agent you own with a provisioned Solana wallet, and every buy passes a `policyGuard` that calls the same `checkBuyAllowed` spend-policy check the rest of the platform uses.
- **Close all** (`POST /api/pump/strategy-close-all`, sign-in required) exits open strategy positions.

A second, separate backtester serves sniper-style rule sets: `POST /api/sniper/backtest { agent_id, strategy, window_days?, network? }` (auth, agent you own, windows of 7, 30, 90, or 180 days). It replays the real captured launch universe, `pump_coin_intel` (bundle, organic, concentration, quality, category signals) joined to `pump_coin_outcomes` (graduated, pumped, flat, rugged, ATH multiple, last market cap), using the exact scorer and exit priority the live sniper worker runs. Exits are modeled at the two real price points it actually observed (the recorded peak and final multiples), a too-thin window returns an explicit `insufficient_data` verdict instead of a flattering number, and every limitation (survivorship, labeling lag, sample size) is reported in a `caveats` field. Results are cached by strategy hash and linked to the agent for projected-versus-realized comparison.

### DCA and subscription builders

`/api/dca-strategies` runs recurring, scheduled buys (executed by the `run-dca` cron). Each strategy is validated (agent, delegation, token in and out, amount per execution, a daily or weekly period, and slippage capped server-side), and non-GET methods over a cookie session require a CSRF token because these move real funds on a schedule. `PATCH /api/dca-strategies/:id` with `{ "action": "pause" }` or `{ "action": "resume" }` pauses and resumes a schedule: a resume schedules `next_execution_at` a full period out from the resume, so periods missed while paused never fire as a burst of swaps, and it is refused when the signed delegation behind the strategy is no longer active (grant a new one to restart it). A schedule that fails to execute three times in a row (`MAX_CONSECUTIVE_FAILURES`) pauses itself; a relayer that is switched off or rejects our own credentials is a platform outage and is retried without counting toward that limit. Rows carry `paused_at`, `resumed_at`, and `consecutive_failures`, and the per-agent list (`GET ?agent_id=`) returns every strategy whatever its status, so a paused or cancelled one stays visible with its history.

## Walkthrough

1. Open [/strategies](https://three.ws/strategies) and browse the published marketplace, or switch to the leaderboard to see strategies ranked by real live ROI.
2. Click **New strategy**. The full-page builder opens. Set your entry conditions, per-trade size and slippage, a required stop-loss and at least one upside exit, and your risk caps. Save.
3. To prove it, open [/strategy-lab](https://three.ws/strategy-lab), paste or write the spec, and **Validate**. Fix any field-tagged errors it returns.
4. **Backtest** it over real recorded launches and trades. For a sniper rule set, `POST /api/sniper/backtest` replays the captured outcome history and reports its own limitations; read the `caveats` before you trust a number.
5. **Run** it in Simulate mode first: watch the live SSE stream of entries, exits, and logs with no funds at risk.
6. Equip the strategy on an agent you own (or flip the Lab run to Live with that agent), and it trades within that agent's spend policy. Fork, edit, publish, or delete from your library at any time.

## Examples

List published strategies and the live leaderboard:

```bash
curl -s 'https://three.ws/api/strategies?scope=published&limit=10' \
  | jq '.data.strategies[] | {name, proven: .performance.proven, roi: .performance.roi_pct}'

curl -s 'https://three.ws/api/strategies/leaderboard?limit=10' \
  | jq '.data.leaders[] | {rank, name, roi_pct: .performance.roi_pct}'
```

Backtest a sniper rule set against the real captured pump.fun launch history (auth required; bearer tokens skip CSRF):

```bash
curl -s https://three.ws/api/sniper/backtest \
  -H 'authorization: Bearer YOUR_TOKEN' \
  -H 'content-type: application/json' \
  -d '{
    "agent_id": "YOUR_AGENT_UUID",
    "window_days": 30,
    "network": "mainnet",
    "strategy": {
      "take_profit_pct": 100,
      "stop_loss_pct": 40,
      "min_quality_score": 60,
      "require_socials": true
    }
  }' | jq '{sample_size, universe_size, insufficient_data, metrics, caveats}'
```

## Guardrails, states, and limits

- **Strategy caps never override the spend leash.** Per-trade size, slippage, and concurrency are additional constraints on top of the agent's server-side policy. A live run's buys pass `checkBuyAllowed`; a strategy cannot spend past your limits.
- **Simulate versus live.** The Lab defaults to Simulate (no wallet, no funds). Live requires auth, an owned agent with a provisioned Solana wallet, and enforces the spend policy on every buy.
- **A stop-loss is mandatory.** Validation rejects any strategy without a stop-loss and requires at least one upside exit (take-profit, trailing stop, or max hold). Every field is clamped to hard bounds.
- **Proven, not promised.** Performance is aggregated from real closed on-chain positions. No closed trades means "Unproven", not a synthetic curve. The leaderboard ranks by verified live ROI.
- **Backtest honesty.** Both backtesters replay real recorded history with the same evaluator their live path runs; neither invents launches, outcomes, or price paths. The sniper backtester additionally reports its own limitations in `caveats` and returns an explicit `insufficient_data` verdict on a too-thin window.
- **Forking transfers rules, not wallets.** A fork copies the config with lineage credited; the forker runs it under their own spend policy. No wallet access is ever transferred.
- **Deleting is safe.** Deleting a strategy stops equipped agents from running it; open positions stay yours to manage.
- **DCA moves real funds on a schedule.** Create and cancel are CSRF-gated over a session, slippage is capped server-side, and allowed output tokens plus the default chain are operator config, never hardcoded.

## Related

- [Custody you can verify](./custody.md) - the spend limits and audit trail every live run is bounded by
- [Financial controls](./financial-controls.md) - the plain-English rules and firewall layered on the same enforcement point
- [Oracle](./oracle.md) - the conviction engine an entry gate can require before it fires
- [Trading surfaces](./trading-surfaces.md) - where equipped strategies execute through the guarded path
- [Trading arenas](./trading-arenas.md) - competitive surfaces where strategies are put to the test
- [/strategies](https://three.ws/strategies) and [/strategy-lab](https://three.ws/strategy-lab) - the library and the workbench
