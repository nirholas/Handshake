# Database retention — keeping the Neon branch under its storage cap

The platform runs on a Neon Postgres branch with a hard **project-size cap**
(512 MB on the free tier). When a branch reaches that cap Postgres raises
SQLSTATE **53100** — `could not extend file because project size limit … exceeded`
— and every **write** path starts failing (reads still work). In production this
surfaced as a storm of 500s on `/api/cron/smart-money-rollup` plus caught write
failures across `coin-intel-observe`, `launcher-tick`, `flush-usage-events`, and
usage metering.

This doc is the playbook: what fills the branch, what keeps it bounded, and when
to upgrade.

## What fills the branch

Two families grow without bound:

1. **The coin-intel firehose.** `pump_coin_intel` ingests **~15–20k new mints a
   day** (≈30 MB/day), and its mint-keyed satellites grow in lockstep —
   `pump_coin_wallets`, `coin_smart_money`, `smart_money_scored`,
   `pump_coin_outcomes`, `oracle_conviction`, `oracle_conviction_history`. All
   told the family adds **~60 MB/day**. The smart-money judge
   (`api/cron/smart-money-rollup.js`) has to outrun this window: it walks unjudged
   coins oldest-first at 400 per run (raised from 80 on 2026-08-16, when a 309k
   backlog was ageing toward the cliff), because a coin pruned before it is judged
   never folds its buyers into `wallet_reputation` at all.
2. **`avatar_regen_jobs`.** Each reconstruct job's `params` carries the multi-MB
   base64 **source** images. The live path drops them once a job leaves
   reconstruction, but terminal jobs that took another route kept them — 346 rows
   were holding 43 MB.

At ~60 MB/day the firehose alone cannot fit a 14-day window inside 512 MB. That
is a plan-capacity fact, not a bug: **a longer guaranteed history window requires
a larger Neon plan.**

## The two mechanisms

### 1. Graceful degradation (always on)

`isDbCapacityError()` (`api/_lib/db.js`) classifies SQLSTATE 53100. Once
classified, write paths degrade instead of 500-storming:

- **API writes** return a bounded **503 + `Retry-After: 30`** (`wrap` /
  `serverError` in `api/_lib/http.js`), with a single deduped `db:capacity` ops
  alert — no per-request Sentry flood.
- **Crons** skip the tick and return `200 { ok: false, reason: "db_full" }`
  (`wrapCron`), so a full branch never produces a 5xx alert storm.

### 2. `/api/cron/db-retention` (scheduled every 15 min)

Bounded + idempotent. Each tick:

- **Firehose retention** — deletes every mint older than the window (and cascades
  its satellite rows) via `DELETE`, which settles `xmax` in place and therefore
  works **even at the cap**, where an `UPDATE` would itself fail with 53100.
  `wallet_reputation` (the durable, wallet-keyed output) and `pumpfun_graduations`
  (win/loss ground truth) are **never** touched.
- **Ledger windows with their own clocks.** The x402 audit ledger keeps a longer
  window (`X402_AUDIT_RETENTION_DAYS`, tightening to
  `X402_AUDIT_MIN_RETENTION_DAYS` under pressure), and `x402_spent_payments`, the
  replay guard behind `api/_lib/x402/spent-payments.js`, keeps a **fixed** window
  (`X402_SPENT_RETENTION_DAYS`) that the valve never shortens: a shorter window is
  a shorter replay-protection window, and the rows are too small to be why the
  branch is under pressure. `x402_self_facilitator_log` (the settle book, the
  largest table this cron does not touch) is deliberately unmanaged because
  `/api/x402-ring` aggregates it with no time filter for its `lifetime` totals;
  pruning it is a product decision about published revenue figures, not a
  retention one.
- **Avatar job hygiene** — deletes terminal jobs past 30 days and strips base64
  source images from terminal jobs past a day.
- **VACUUM** (plain) of the pruned tables so freed pages become reusable by
  future inserts.
- **Compaction under pressure.** Plain `VACUUM` never shrinks the relation
  *files*, so on Neon `pg_database_size` stays high after a prune and the
  storage-pressure gate (`isStoragePressured` / `requireWriteCapacity`) can
  latch permanently: the July 2026 recurrence had **770 MB** of dead file space
  across the pruned tables while every write-heavy cron sat skipped. When a
  tick starts over the high-water mark, the cron now measures reclaimable space
  per managed table (`pgstattuple_approx`, extension auto-installed) and
  `VACUUM FULL`s the worst offenders, smallest file first (each rewrite needs
  headroom about equal to the table's live size), bounded per tick, and only
  ever on tables this cron itself manages. The rewrites returned
  `pump_coin_intel` 576→194 MB and `oracle_conviction` 386→137 MB in ~2 s each
  during the 2026-07-22 recovery.

**The self-healing valve.** The retention window self-tunes: normally
`PUMP_INTEL_RETENTION_DAYS`, but whenever the branch is at/above
`DB_RETENTION_HIGH_WATER_MB` it tightens to `PUMP_INTEL_MIN_RETENTION_DAYS`, so
the hard cap is **never actually reached**. It relaxes again once GC returns the
freed space and the branch drops back under the mark. When the valve engages it
fires one deduped `db:retention-pressure` alert.

## Tunables

| Env | Default | Meaning |
| --- | --- | --- |
| `PUMP_INTEL_RETENTION_DAYS` | `14` | Normal firehose window (days). Clamped `[2, 365]`. Raise after a Neon plan upgrade. |
| `PUMP_INTEL_MIN_RETENTION_DAYS` | `3` | Floor the valve tightens to under pressure. Clamped `[1, retention]`. |
| `DB_RETENTION_HIGH_WATER_MB` | `470` | Engage the valve at/above this size. Clamped `[128, 100000]`. Production runs `8192` (see the sizing note below). |
| `DB_COMPACT_ENABLED` | `1` | Set `0` to disable the `VACUUM FULL` compaction step entirely. |
| `DB_COMPACT_MIN_FREE_MB` | `25` | Only rewrite a table holding at least this much reclaimable space (and at least 30% of its file). |
| `DB_COMPACT_MAX_TABLES` | `3` | Most tables one tick may rewrite. |
| `X402_AUDIT_RETENTION_DAYS` | `90` | x402 audit ledger window (`x402_autonomous_log` and the audit log). Clamped `[7, 3650]`. |
| `X402_AUDIT_MIN_RETENTION_DAYS` | `30` | Floor the valve tightens the audit window to. Clamped `[1, audit retention]`. |
| `X402_SPENT_RETENTION_DAYS` | `90` | Fixed window for `x402_spent_payments` replay proofs. Clamped `[30, 3650]` so a typo cannot shrink the guard to hours; never tightened by the valve. |

### Sizing the high-water mark (read before changing it)

The mark must sit **above the live data footprint and below the real branch
cap**. Both halves matter, and getting either wrong is a production incident:

- **Too low** and the branch sits permanently over the mark. Every cron built
  with `requireWriteCapacity` preflight-skips forever, the valve pins retention
  at its floor, and the platform quietly stops ingesting while looking healthy.
  This is the failure mode that mattered on 2026-07-28: the mark was set equal
  to the assumed 3072 MB cap while the live footprint was ~2.7 GB, so at 18:42
  a single tick over the line skipped 56 crons in one minute — including
  `economy-rebalance`, the cron that refills the x402 fee wallet. The fee wallet
  starved and every settle returned `fee_wallet_below_floor` for the next four
  hours. `economy-rebalance` is no longer gated for exactly this reason.
- **Too high** and the valve never engages before the branch hits its real cap,
  where writes fail with SQLSTATE 53100 and only `DELETE` still works.

Confirm the real cap before sizing, rather than assuming the tier you signed up
on:

```sh
psql "$DATABASE_URL" -c 'SHOW neon.max_cluster_size'
psql "$DATABASE_URL" -c 'SELECT pg_size_pretty(pg_database_size(current_database()))'
```

As of 2026-07-29 that reads `16TB` against a ~2.5 GB footprint, so the mark is
`8192` on the Cloud Run service: months of headroom at the firehose's ~60 MB/day
while still leaving the valve as a genuine runaway backstop.

```sh
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --update-env-vars DB_RETENTION_HIGH_WATER_MB=8192
```

## Upgrade trigger

The valve keeps the branch **healthy** on the free tier, but at the cost of a
**shorter effective history window** (roughly `PUMP_INTEL_MIN_RETENTION_DAYS`)
whenever storage is tight. If `db:retention-pressure` alerts are frequent and you
want a longer guaranteed window (e.g. the full 14-day judge horizon), **upgrade
the Neon plan** for more storage, then raise `DB_RETENTION_HIGH_WATER_MB` and
`PUMP_INTEL_RETENTION_DAYS` to match.

## Manual reclaim (one-off, at the cap)

`DELETE` frees space without extending a file, so it works at the cap; `UPDATE`
does not. To reclaim immediately, delete the oldest rows in batches, then
`VACUUM` (or `VACUUM FULL <table>` only when that table's **live** data is small
enough that the rewrite fits the remaining headroom). Measure with:

```sql
SELECT pg_size_pretty(pg_database_size(current_database()));
SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public'
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 20;
```

## See also

- `api/cron/db-retention.js` — the cron
- `api/_lib/db.js` — `isDbCapacityError` / `isDbUnavailableError`
- [docs/ops/redis.md](redis.md) — the Upstash cache/limiter quota playbook
