# Forge error triage

Answering "what is actually failing in 3D generation, and how often?" from the
outcome ledger, without hand-writing SQL against production.

```bash
npm run forge:errors                      # last 7 days, ranked by class
npm run forge:errors -- --days 30
npm run forge:errors -- --days 7 --json   # machine-readable, same numbers
npm run forge:errors -- --class timeout   # every message in one class
```

Read-only: the script ([scripts/forge-error-report.mjs](../../scripts/forge-error-report.mjs))
runs two SELECTs against `forge_creations` and writes nothing.

## Why this exists next to /api/healthz

`/api/healthz` already carries a Forge generation sensor
([api/_lib/ops/forge-health-sensor.js](../../api/_lib/ops/forge-health-sensor.js)),
and it answers a different question. It looks at a fixed **6 hour** window and
returns `unknown` below **15 attempts**, because it is tuned to page on a burst
of failures and must not page on a quiet afternoon. At forge's real volume that
window is regularly too small to judge at all, so "is generation healthy?" often
answers `unknown` while a failure class has been recurring all week.

Triage needs the other question: over the last week, which class recurs most, on
which lane, and what does the message actually say? That is this report.

The sensor also pre-aggregates its reason in SQL with
`split_part(error, ':', 1)`. That is the cheap version of grouping and it only
holds while messages happen to lead with a stable prefix. It is not enough for a
ranking: `generation timed out after 41 minutes` and
`generation timed out after 63 minutes` are already two separate reasons under
it, and a vendor sentence with no colon becomes its own reason every single time.

## How the ranking groups

`forge_creations.error` stores whatever the lane said, verbatim
(`markFailed` in [api/_lib/forge-store.js](../../api/_lib/forge-store.js) clamps
it to 500 chars and nothing else). Storing the raw text is right: it is the only
forensic record of what a vendor or worker returned. Grouping on it is wrong,
because every message carries the specifics of its own failure (a prediction id,
a task uuid, a signed URL, a byte count, a minute count), so N instances of one
recurring failure count as N distinct classes and the ranking says nothing.

[api/_lib/ops/forge-error-class.js](../../api/_lib/ops/forge-error-class.js)
fixes that in two steps, and the report calls it in JS rather than in SQL for
exactly this reason:

1. **Normalize.** Lowercase, strip URLs, uuids, long hex/base58 ids, then counts
   and durations. Two occurrences of the same failure collapse to one string.
2. **Match a class.** Ordered most-specific first, so `task not found` reads as
   `lost_task` (the self-host lane lost the job) rather than as a generic 404.

Named classes: `timeout`, `lost_task`, `aborted`, `out_of_memory`,
`rate_limited`, `payment_required`, `unauthorized`, `upstream_5xx`,
`not_found_4xx`, `network`, `bad_input_image`, `bad_output_mesh`,
`content_filtered`, `storage`, `generic_failure`.

Anything unrecognized returns `other` keyed by its normalized text, so identical
unknown messages still group together instead of being force-fit into a named
bucket. An empty error is `none`. Same principle as
[api/_lib/forge-classify.js](../../api/_lib/forge-classify.js): high precision,
honest fallback, no invented buckets. Covered by
[tests/forge-error-class.test.js](../../tests/forge-error-class.test.js); when
you add a class, add its case there.

## Reading the output

```
  generations 812   done 731   failed 74   still running 7
  success rate 90.8%

  rank  n     share   class                  worst lane            message
  1     31    41.9%   timeout                selfhost×29           generation timed out after 41 minutes
  2     18    24.3%   lost_task              selfhost×18           task not found: 7f3a2b19c4d5e6f7

  Top class: timeout (timed out before the lane returned)
```

- **worst lane** is the `backend` column: which generation lane produced most of
  that class. A class concentrated on one lane is a lane problem; one spread
  evenly across lanes is a pipeline problem.
- **still running** counts rows in a non-terminal status inside the window. A
  large number here on an old window means jobs are never being finalized, which
  is a `forge-finalize` cron problem, not a generation problem.
- `--class <id>` prints every lane, path, first/last seen, and sample messages
  for one class. That is where you go before touching pipeline code.

## Where the failures come from

- **`timeout`** is usually written by the finalizer, not the lane:
  [api/cron/forge-finalize.js](../../api/cron/forge-finalize.js) marks a job
  `generation timed out after N minutes` once it has been open too long. A rising
  timeout class means jobs are being started and never returning, so check the
  worker's own logs for the same period ([gcp-logs.md](gcp-logs.md)).
- **`lost_task`** means the poll asked the lane for a job it does not know about.
  On a self-hosted worker that is a restarted or scaled-to-zero instance losing
  in-memory task state.
- **`upstream_5xx`, `rate_limited`, `unauthorized`, `payment_required`** are all
  vendor-side and resolve on the vendor's dashboard or in the env, not in code.
  See [production-log-triage.md](production-log-triage.md) for the same
  distinction across the rest of the platform.

## Credentials

The script reads `DATABASE_URL` from `.env.local`, then `.env`, then the shell,
in that order (same as [scripts/apply-migrations.mjs](../../scripts/apply-migrations.mjs)).
Without it, it exits 2 and prints the command that reads production's value off
the Cloud Run service:

```bash
gcloud run services describe three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --format=yaml | grep -A1 DATABASE_URL
```
