# Oracle worker

The engine behind the **Oracle** product (`/oracle`, `/api/oracle/*`). It does
**not** ingest raw pump.fun data: the platform's data brain (`pump_coin_intel`,
`pump_coin_wallets`, `wallet_reputation`, `coin_smart_money`,
`pump_coin_outcomes`) already has full coverage. Oracle adds the **fusion** and
the **action loop** on top.

## What it does

1. **Score loop** (`score-loop.js`): finds recent brain coins missing or stale in
   `oracle_conviction`, classifies their cultural narrative (LLM free-first,
   heuristic fallback), fuses the four-pillar conviction score, and caches it.
   Keeps the live feed + SSE warm. Bounded by `ORACLE_SCORE_BATCH` per pass.

2. **Agent loop** (`agent-loop.js`): runs the pure decision
   (`api/_lib/oracle/agent-eval.js`) for every armed `oracle_agent_watch`
   against each freshly-scored coin and executes when a coin clears the owner's
   bar. Each (agent, mint) acts at most once. Also fires the Telegram lanes
   (personal signal, entry, conviction-drop, follower fan-out).

3. **Settle loop** (`settle-loop.js`): grades open actions against the data
   brain's ground-truth outcomes (`pump_coin_outcomes`). Once a coin an agent
   acted on resolves (graduated / rugged / ATH known), it writes back the
   win/loss + mark-to-market PnL via `api/_lib/oracle/settle.js` and alerts
   profitable exits. This keeps the agent's win-rate ledger honest and feeds the
   conviction backtest.

## Where it runs

**In production the three loops run inside the API container, not as a
standalone process.** `api/cron/oracle-score.js` imports these exact modules and
drives one pass of each; Cloud Scheduler hits it every 2 minutes
(`cron--api-cron-oracle-score`, defined in the `crons` array of `vercel.json`).
There is no `oracle` Cloud Run service and no Dockerfile here on purpose: the
loops are cheap, DB-bound, and idempotent, so a stateless 2-minute tick is
equivalent to the in-process timers and costs nothing to keep alive.

The cron drives the passes with an explicit 15-minute look-back window instead
of the worker's in-memory cursor, which is what makes it safe across stateless
invocations. Everything else (config validation, execution, alerts, settlement)
is shared code, so the two run modes cannot drift.

Three sibling crons close the learning loop around it, all on the same
scheduler: `oracle-realized-labels` (every 30 min, realized fleet PnL as
training labels), `oracle-calibrate` (every 6 h, conviction-band calibration),
and `oracle-digest` (daily 08:00 UTC, Telegram digest).

The long-lived process (`index.js`) remains the supported way to run the same
loops continuously, on your own box or any host that keeps a Node process alive.
It is what you want for local development and for a faster cadence than 2
minutes.

## Modes

- `ORACLE_MODE=simulate` (default, and what production runs today): logs
  realistic actions to `oracle_watch_actions`, spends nothing. Safe to run
  anywhere.
- `ORACLE_MODE=live`: loads each agent's own custodial Solana keypair (decrypted
  via the audited `recoverSolanaAgentKeypair`) and broadcasts a pump.fun buy via
  the same `PumpTradeClient` the production trade path uses. Requires
  `JWT_SECRET`, and a watch must itself be armed in live mode. Every live action
  is hard-capped at `ORACLE_MAX_TRADE_SOL` regardless of a watch's config.

## Env

No `ORACLE_*` or `JITO_*` var is set on the production Cloud Run service, so
production runs on every default below.

| var | default | meaning |
|-----|---------|---------|
| `DATABASE_URL` | (required) | Neon Postgres |
| `JWT_SECRET` | (required for live) | decrypts agent wallets |
| `ORACLE_MODE` | `simulate` | `simulate` \| `live` (anything else reads as `simulate`) |
| `ORACLE_NETWORK` | `mainnet` | `mainnet` \| `devnet` |
| `ORACLE_GLOBAL_KILL` | `0` | `1` halts all agent actions (scoring continues) |
| `ORACLE_SCORE_INTERVAL_MS` | `15000` | score-pass cadence (long-lived process only) |
| `ORACLE_AGENT_INTERVAL_MS` | `3000` | agent-pass cadence (long-lived process only) |
| `ORACLE_SETTLE_INTERVAL_MS` | `60000` | settle-pass cadence (long-lived process only) |
| `ORACLE_SCORE_BATCH` | `20` | coins scored per pass |
| `ORACLE_RESCORE_AFTER_SEC` | `180` | re-score a coin after this staleness |
| `ORACLE_MAX_TRADE_SOL` | `0.25` | hard per-trade cap (live) |
| `ORACLE_USE_JITO` | `0` | `1` routes live buys through Jito bundles (MEV-protected) |
| `JITO_TIP_SOL` | `0.002` | Jito validator tip in SOL (capped at 0.01) |
| `JITO_BUNDLE_URL` | mainnet block-engine | Jito block-engine bundles endpoint |

The alert lane the agent loop fires lives in `api/_lib/oracle/alerts.js` and
reads its own config: `TELEGRAM_BOT_TOKEN` (unset disables every Telegram lane),
`TELEGRAM_ORACLE_CHAT_ID` (the public signals channel), `ORACLE_ALERT_MIN_TIER`
(default `strong`) and `ORACLE_FEED_MIN_SCORE` (default `56`).

## Run

```bash
npm run db:status       # preview pending migrations before applying anything
npm run db:migrate      # APPLIES every pending migration, no dry run
npm run worker:oracle   # simulate by default
```

The Oracle's own schema is the `*_oracle*.sql` set in `api/_lib/migrations/`
(starting at `20260616120000_oracle.sql`); `db:migrate` applies whatever is
pending repo-wide, not just those, so read `db:status` first.

`npm run worker:oracle` loads `.env` from the repo root via Node's
`--env-file-if-exists`, so it works from a clean checkout with the usual
`DATABASE_URL` in place and still boots when there is no `.env` (env exported by
the host). It fails loudly at boot when `DATABASE_URL` is missing, or when
`ORACLE_MODE=live` is set without `JWT_SECRET`.

To watch the loops without any agent acting:

```bash
ORACLE_GLOBAL_KILL=1 npm run worker:oracle
```

## Tests

`tests/oracle/worker-loops.test.js` covers this directory: config validation,
the simulate execution path (capped size, no keypair ever loaded), the kill
switch and armed-watch fan-out, and settlement write-back. The pure engines it
calls have their own suites in `tests/oracle/`.

```bash
npx vitest run tests/oracle
```
