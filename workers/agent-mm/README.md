# agent-mm — Launch Copilot market-maker engine

A long-lived worker that runs the autonomous, **rules-based, non-manipulative**
fair-launch market-maker behind the Launch Copilot. When a launcher attaches a
`market_maker_policies` row to a coin launched through three.ws, this worker:

- **Seeds** the configured initial buy once.
- **Defends the floor** — buys a bounded slice when the live price falls through
  `floor_price × (1 − floor_band%)`, within the dip-buy + daily budgets.
- **Recycles profit** — sells `recycle_pct` of managed inventory into a spike
  above `floor_price × (1 + take_profit_band%)`, locking realized SOL.
- **Rebalances** — trims back toward the inventory ceiling.
- **Manages graduation** — on the curve→AMM handoff it runs the policy's
  `graduation_action` exactly once: `provide_lp` (deposit inventory + paired SOL
  as real LP), `distribute` (liquidate inventory to SOL for the owner), or `hold`
  (keep inventory and continue two-sided on the AMM). No parked inventory.

## It adds no new way to move funds

Every buy/sell is routed through `executeAgentTrade` — the same
quote → **firewall** → **spend-guard** → custody-claim → **MEV-protected** sign →
confirm pipeline a manual trade uses. The worker only decides *when* and *how
much*, inside the policy's published limits. The kill switch halts it instantly,
and the owner can always withdraw the remaining inventory + SOL.

## Anti-manipulation (enforced in code, every action)

- **No wash-trading / round-trips** — no action, and never a side flip, inside
  `min_action_interval_seconds` (× 2 for a flip). Floor `30s`.
- **Can't dominate volume** — a single action is capped to `max_volume_pct` of
  *live* market volume (ceiling `33%`). If volume can't be measured, it won't act
  above a tiny conservative slice — it never paints a no-volume tape.
- **Bounded, non-reflexive sizing** — defend buys capped by budgets, wallet SOL,
  and the inventory ceiling; recycle sells by `recycle_pct` and the volume cap.

A policy that requests values outside these caps is **refused at create time**
(`api/_lib/market-maker.js → assertPolicySafe`), with a plain-language reason the
UI surfaces.

## Run

The worker reads its configuration from the process environment and loads no
`.env` file of its own, so export one first:

```bash
set -a && . ./.env && set +a
npm run worker:mm          # simulate (default, safe — real quotes, no spend)
npm run worker:mm:live     # live fills from agent wallets
```

It boots, logs one JSON line per event, and sweeps every `MM_POLL_MS`. With no
active policy attached the sweep is silent (nothing to decide) and only the
`bot_heartbeat` row advances, which is how you confirm it is alive:

```sql
SELECT worker, mode, last_beat_at, meta FROM bot_heartbeat WHERE worker = 'agent-mm';
-- meta.sweeps increments every poll; meta.lastSweepMs is the last sweep's duration
```

### Environment

| Var | Default | Notes |
|---|---|---|
| `MM_NETWORK` | `mainnet` | `mainnet` \| `devnet` |
| `MM_MODE` | `simulate` | `live` requires `SOLANA_RPC_URL` or `HELIUS_API_KEY` |
| `MM_GLOBAL_KILL` | `0` | halt all actions (policies intact) |
| `MM_POLL_MS` | `15000` | re-evaluation cadence |
| `MM_CONCURRENCY` | `4` | agents evaluated in parallel per sweep |
| `MM_HEARTBEAT_MS` | `30000` | `bot_heartbeat` liveness (0 disables) |
| `MM_VOLUME_WINDOW_S` | `300` | window for the live-volume cap |

Required at boot (`config.js` refuses to start without them):

| Var | Why |
|---|---|
| `DATABASE_URL` | Policies, the action ledger, heartbeats. Any standard alias (`POSTGRES_URL`, `NEON_DATABASE_URL`, …) resolves too. |
| `JWT_SECRET` | Consumed transitively by the wallet layer. Required in both modes. |
| `SOLANA_RPC_URL` **or** `HELIUS_API_KEY` | **Live mode only.** Boot fails without one: a public RPC rate-limits under continuous re-quote load and would silently drop fills. |

Optional but recommended: `WALLET_ENCRYPTION_KEY` (the real custodial-wallet key;
without it `api/_lib/agent-wallet.js` falls back to the legacy `JWT_SECRET`
scheme with a warning) and `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
(live screen frames for the arena floor line and the `/agents-live` badge; the
sweep runs fine without them, viewers just fall back to the DB activity poll).

When `PORT` is set the worker binds a tiny liveness endpoint on it that answers
`{ ok, worker, bootAt, mode, network, globalKill }`, so a Cloud Run startup probe
passes. Nothing else is served on it.

## Tests

```bash
npx vitest run tests/agent-mm-engine.test.js tests/market-maker.test.js tests/agent-mm-render.test.js
```

- `tests/agent-mm-engine.test.js` covers the engine's core decision path: the
  intent ladder, every anti-manipulation gate (interval, side-flip, volume cap,
  dust floor), the budget/inventory/wallet clamps, simulate-vs-live routing, and
  the three graduation branches. The chain + DB edges are substituted; the
  rulebook it reads (`GUARDS`) is the real one, so tightening a cap fails these
  tests.
- `tests/market-maker.test.js` covers the policy rulebook and its create-time
  refusals.
- `tests/agent-mm-render.test.js` covers the outcome to screen-event projection.

## Deploy

**Not currently deployed.** No `agent-mm` service exists in `us-central1` on
`aerial-vehicle-466722-p5` (checked 2026-08-11 with `gcloud run services list`),
and no policy has been attached yet (`market_maker_policies` is empty), so there
is nothing for a hosted sweep to act on. Until a launcher attaches one, run it
locally with the command above; deploying is a single owner-approved command
whenever the first policy lands.

The target shape is Cloud Run as a **background-daemon service**. It isn't
request-driven, but `index.js` binds the liveness endpoint on `$PORT` so the
startup probe passes; `--no-cpu-throttling` + `--min-instances=1` (both already
in `cloudbuild.yaml`) keep the sweep timer ticking between probes. Build and
deploy from the repo root:

```bash
# one-time secret setup is documented at the top of cloudbuild.yaml
gcloud builds submit --config workers/agent-mm/cloudbuild.yaml . \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

The `SHORT_SHA` substitution is not optional on a manual submit: the config tags
and deploys the image by that value, and gcloud leaves it empty outside a trigger,
which pushes a tag ending in a bare colon and then deploys an image that does not
exist. The build also runs as the pinned `three-ws-build@` service account (the
project's default compute SA was deleted), which `cloudbuild.yaml` already sets.

It ships in `MM_MODE=simulate` (real quotes, no broadcast). Flip
`_MM_MODE=live` (build substitution) or update the running service's `MM_MODE`
only after the RPC secret is set and agent wallets are funded. It can equally run
as a Cloud Run **Job** — jobs get no startup probe, so `PORT` is unset and no
listener binds; the sweep loop is unaffected either way.
