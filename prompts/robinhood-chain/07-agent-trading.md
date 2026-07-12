# 07 — Autonomous trading agents: `hood-traders`

Read `prompts/robinhood-chain/_shared.md` first. Wave 3: requires core SDK; use `hoodkit`'s
`strategy`/`stream` modules if built (they should be — check `robinhood/hoodkit/`), else the
core SDK directly with a note in your report.

## Mission
Build `robinhood/hood-traders/` — a framework + runnable fleet of autonomous agents that trade
Robinhood Chain memecoins and monitor Stock Token premium/discount, in the spirit of
three.ws/play/arena (autonomous agents, live P&L, every trade real and signed). This is both a
real product and the reference app proving the whole stack.

## Deliverables

1. **Agent framework** (`src/framework/`) — an agent = strategy + wallet + risk budget + journal:
   - Lifecycle: observe (hoodkit streams) → decide (strategy fn) → simulate (`eth_call`) →
     execute (real swap) → journal (SQLite: every decision, tx, PnL mark).
   - Risk layer is NOT optional: per-agent `MAX_POSITION_USDG`, `MAX_DAILY_SPEND_USDG`,
     `MAX_SLIPPAGE_BPS`, global kill switch (SIGINT + `KILL` file + HTTP `/kill`), cooldowns.
   - Modes: `paper` (default — full pipeline, simulation-only, marked clearly in every output)
     and `live` (requires `HOOD_TRADERS_LIVE=1` + funded key). Paper mode is a real simulation
     against live market data, not fake data.
2. **Three real strategies** (`src/strategies/`) — honest, simple, documented with their edge
   hypothesis and failure modes; no ML theater:
   - `launch-sniper` — enter new launchpad coins passing liquidity/holder-distribution filters,
     exit on take-profit/stop/time.
   - `momentum` — volume+price breakout entries on graduated coins, trailing stop exits.
   - `premium-watch` — Stock Token Chainlink-vs-DEX premium tracker that trades the
     convergence ONLY in eligible configuration (`_shared.md` gate), otherwise alerts-only.
     Default: alerts-only.
3. **Live dashboard** (`dashboard/`) — served by the agent process: fleet overview, per-agent
   equity curve, open positions, decision journal (why each trade fired), kill buttons.
   Vanilla JS + the design bar from `_shared.md`. This is the demo and the screenshot.
4. **Deploy** — Dockerfile + Cloud Run (or any always-on host) docs; `docker compose up` runs
   fleet + dashboard locally in paper mode with zero config.

## Requirements
- Vitest: risk-layer tests are the priority (cap breach → refusal; kill switch mid-loop;
  slippage bound; journal integrity). Strategy logic unit-tested on real recorded market
  snapshots captured during your run (capture them yourself from live data; they're inputs to
  deterministic tests, not runtime mocks).
- E2E: run the fleet in paper mode against LIVE mainnet data for ≥ 30 minutes; then execute at
  least one REAL testnet-46630 trade through the full pipeline (faucet funds) — tx hash in report.
- `docs/` static site per `_shared.md`: landing = the dashboard aesthetic with a real captured
  session (clearly labeled paper/live), architecture page (the observe→journal loop), strategy
  docs with honest risk disclosure, "run your own in 5 minutes" quickstart.
- README top: prominent risk disclaimer (autonomous trading, real funds, no guarantees) — plain
  language, not legalese soup.

## Done checklist
- [ ] 30-min live-data paper session evidence (journal excerpt + dashboard screenshot-worthy state).
- [ ] Real testnet trade through the full pipeline. Risk tests green. Kill switch proven (test output).
- [ ] `docker compose up` → working dashboard on first try in a clean checkout.
- [ ] Report: honest assessment of each strategy's edge hypothesis + owner actions (funding for live).
