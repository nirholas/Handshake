# Oracle worker

A long-lived Node process that powers the **Oracle** product (`/oracle`,
`/api/oracle/*`). It does **not** ingest raw pump.fun data — the platform's data
brain (`pump_coin_intel`, `pump_coin_wallets`, `wallet_reputation`,
`coin_smart_money`, `pump_coin_outcomes`) already has full coverage. Oracle adds
the **fusion** and the **action loop** on top.

## What it does

1. **Score loop** (`score-loop.js`) — every `ORACLE_SCORE_INTERVAL_MS`, finds
   recent brain coins missing or stale in `oracle_conviction`, classifies their
   cultural narrative (LLM free-first, heuristic fallback), fuses the four-pillar
   conviction score, and caches it. Keeps the live feed + SSE warm.

2. **Agent loop** (`agent-loop.js`) — every `ORACLE_AGENT_INTERVAL_MS`, runs the
   pure decision (`api/_lib/oracle/agent-eval.js`) for every armed
   `oracle_agent_watch` against each freshly-scored coin and executes when a coin
   clears the owner's bar. Each (agent, mint) acts at most once.

3. **Settle loop** (`settle-loop.js`) — every `ORACLE_SETTLE_INTERVAL_MS`, grades
   open actions against the data brain's ground-truth outcomes
   (`pump_coin_outcomes`). Once a coin an agent acted on resolves
   (graduated / rugged / ATH known), it writes back the win/loss + mark-to-market
   PnL via `api/_lib/oracle/settle.js` and alerts profitable exits. This keeps the
   agent's win-rate ledger honest and feeds the conviction backtest.

## Modes

- `ORACLE_MODE=simulate` (default) — logs realistic actions to
  `oracle_watch_actions`, spends nothing. Safe to run anywhere.
- `ORACLE_MODE=live` — loads each agent's own custodial Solana keypair
  (decrypted via the audited `recoverSolanaAgentKeypair`) and broadcasts a
  pump.fun buy via the same `PumpTradeClient` the production trade path uses.
  Requires `JWT_SECRET`. Every live action is hard-capped at
  `ORACLE_MAX_TRADE_SOL` regardless of a watch's config.

## Env

| var | default | meaning |
|-----|---------|---------|
| `DATABASE_URL` | — (required) | Neon Postgres |
| `JWT_SECRET` | — (required for live) | decrypts agent wallets |
| `ORACLE_MODE` | `simulate` | `simulate` \| `live` |
| `ORACLE_NETWORK` | `mainnet` | `mainnet` \| `devnet` |
| `ORACLE_GLOBAL_KILL` | `0` | `1` halts all agent actions (scoring continues) |
| `ORACLE_SCORE_INTERVAL_MS` | `15000` | score-pass cadence |
| `ORACLE_AGENT_INTERVAL_MS` | `3000` | agent-pass cadence |
| `ORACLE_SETTLE_INTERVAL_MS` | `60000` | settle-pass (outcome grading) cadence |
| `ORACLE_SCORE_BATCH` | `20` | coins scored per pass |
| `ORACLE_RESCORE_AFTER_SEC` | `180` | re-score a coin after this staleness |
| `ORACLE_MAX_TRADE_SOL` | `0.25` | hard per-trade cap (live) |
| `ORACLE_USE_JITO` | `0` | `1` routes live buys through Jito bundles (MEV-protected) |
| `JITO_TIP_SOL` | `0.002` | Jito validator tip in SOL (capped at 0.01) |
| `JITO_BUNDLE_URL` | mainnet block-engine | Jito block-engine bundles endpoint |

## Run

```bash
npm run db:migrate      # applies api/_lib/migrations/20260616120000_oracle.sql
npm run worker:oracle   # simulate by default
```
