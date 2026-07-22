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
   told the family adds **~60 MB/day**.
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
| `DB_RETENTION_HIGH_WATER_MB` | `470` | Engage the valve at/above this size. Clamped `[128, 100000]`. |
| `DB_COMPACT_ENABLED` | `1` | Set `0` to disable the `VACUUM FULL` compaction step entirely. |
| `DB_COMPACT_MIN_FREE_MB` | `25` | Only rewrite a table holding at least this much reclaimable space (and at least 30% of its file). |
| `DB_COMPACT_MAX_TABLES` | `3` | Most tables one tick may rewrite. |

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
