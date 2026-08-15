# Unstoppable Agent

A self-sustaining autonomous agent with its own USDC treasury. It earns revenue by serving paid status checks, spends within a budget on its own thinking, tracks its runway, and shifts between `normal`, `conservation`, and `halted` modes based on its balance and burn rate. Once per day it writes a strategic reflection about how the day went. Every paid query of its status directly funds its continued operation, which is the point: it is a live, public experiment in an agent that pays its own way. Watchers follow it on the `/unstoppable` dashboard; agents buy its status over x402.

## How it works

The lifecycle is one `tick()` in [src/loop.js](src/loop.js), called every 5 minutes by the `/api/cron/unstoppable-tick` cron:

1. **Sense**: re-derive the mode from the current balance (`recalcRunway()`), then read the treasury plus 24h earnings, 24h costs, and recent activity. A treasury that is still halted after that recalculation skips the tick. The recalculation has to come first: settling only at the end of a tick made `halted` a one-way trapdoor, so an agent that halted stayed halted however much revenue arrived afterwards.
2. **Think**: if the balance is above the hard floor (100000 atomics, $0.10), ask the LLM for a JSON plan of actions, with a per-tick think budget of 0.1% of balance capped at $0.001 ([src/inference.js](src/inference.js)).
3. **Act**: execute the planned actions: `reflect` (write the daily reflection if missing), `post_status` and `idle` (free, logged for the activity feed), `search` (spends $0.01, only in normal mode with headroom above the floor). If the plan did not ask for `reflect`, the tick calls `maybeReflect()` anyway before settling: the daily reflection is a public promise the `/unstoppable` dashboard renders, so it cannot depend on the planner remembering to ask. `maybeReflect()` is idempotent, so after the first tick of a day it is one existence check.
4. **Settle**: recompute runway from the last-24h burn rate and update the mode: `halted` at or below the floor, `conservation` when runway is under 7 days or burn exceeds the threshold, otherwise `normal` ([src/treasury.js](src/treasury.js)).

State lives in three Postgres tables (created idempotently by the status endpoint): `unstoppable_treasury` (a singleton row, id=1), `unstoppable_activity` (every action, cost, and revenue event), and `unstoppable_reflections` (one row per day).

## Key files

| File | Role |
|---|---|
| [src/loop.js](src/loop.js) | `tick()`: the sense, think, act, settle lifecycle |
| [src/treasury.js](src/treasury.js) | Treasury reads/writes, `recordEarning()`, `recordSpend()`, `recalcRunway()`, the $0.10 hard floor |
| [src/inference.js](src/inference.js) | `think()`: budget-aware LLM planning over financial state |
| [src/earnings.js](src/earnings.js) | `recordRevenue()`, 24h earnings/costs queries, the activity log |
| [src/reflection.js](src/reflection.js) | `maybeReflect()`: once-daily LLM reflection with a statistical fallback |
| [../../api/agents/unstoppable-status.js](../../api/agents/unstoppable-status.js) | `GET /api/agents/unstoppable-status`: the paid status endpoint that funds the agent |
| [../../api/agents/unstoppable-public.js](../../api/agents/unstoppable-public.js) | `GET /api/agents/unstoppable-public`: the free, cached snapshot the dashboard renders |
| [../../api/cron/[name].js](../../api/cron/%5Bname%5D.js) | `handleUnstoppableTick`: the cron handler that imports and runs `tick()` |
| [../../src/unstoppable-dashboard.js](../../src/unstoppable-dashboard.js) | The `/unstoppable` dashboard ([../../pages/unstoppable.html](../../pages/unstoppable.html)), polls status every 60 seconds |

## How to run

Run one tick locally from the repo root (Node 20+, needs `DATABASE_URL`):

```bash
node --env-file=.env -e "import('./agents/unstoppable/src/loop.js').then(m => m.tick()).then(r => console.log(r))"
```

Read the free public snapshot (no auth, no payment, this is what the dashboard renders):

```bash
curl -s https://three.ws/api/agents/unstoppable-public
```

Query the live agent (without an `X-PAYMENT` header this returns the 402 payment quote):

```bash
curl -s https://three.ws/api/agents/unstoppable-status
```

Or watch the dashboard at [https://three.ws/unstoppable](https://three.ws/unstoppable).

## Environment variables

- `DATABASE_URL`: Postgres (Neon), via the shared [../../api/_lib/db.js](../../api/_lib/db.js).
- `ANTHROPIC_API_KEY`: optional operator key for thinking and reflection. Without it, the shared LLM chain in [../../api/_lib/llm.js](../../api/_lib/llm.js) runs on the funded free providers (`GROQ_API_KEY`, `OPENROUTER_API_KEY`, and the rest); with no provider at all the agent idles safely.
- `X402_PRICE_UNSTOPPABLE_STATUS`: optional atomics override for the status price (default 10000, which is $0.01).

## Platform connections

- **Cron**: `/api/cron/unstoppable-tick` runs every 5 minutes (`*/5 * * * *`), declared in `vercel.json` and executed by Cloud Scheduler in production.
- **Two reads, one state**: `GET /api/agents/unstoppable-public` is free, IP rate-limited, edge-cached for one agent tick (300s) and trimmed to the 8 most recent activity rows. It exists so the public dashboard shows real numbers to every visitor instead of an empty paywall notice. The paid route below stays the real-time, 20-row read, and it is the only one that credits the treasury it reports.
- **x402**: `GET /api/agents/unstoppable-status` is a paid, Bazaar-discoverable endpoint (USDC on Base or Solana, listed in [../../api/_lib/x402/ring-catalog.js](../../api/_lib/x402/ring-catalog.js)). Each settled payment calls `recordRevenue()`, which writes an `earn` activity row and credits the treasury.
- **Database**: the status endpoint bootstraps all three tables with `CREATE TABLE IF NOT EXISTS` and seeds the treasury, so the agent needs no separate migration to come alive.
