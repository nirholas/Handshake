# 06. A cron declared in `vercel.json` has never run in production

**Severity: P1.** Silent: nothing fails, the job simply never fires. Read
[00-INDEX.md](fix-queue-00-INDEX.md) first.

## Symptom (reproduced 2026-08-01)

```
$ npm run check:cron-drift
Declared crons in vercel.json: 101
MISSING in Cloud Scheduler: 1
  /api/cron/garment-job-sweep  (cron--api-cron-garment-job-sweep)
exit=1
```

The declaration exists at [vercel.json:5946](../../vercel.json#L5946) with
schedule `*/10 * * * *`, and the handler exists at
[api/cron/garment-job-sweep.js](../../api/cron/garment-job-sweep.js). Only the
Cloud Scheduler job is missing, so the sweep has never executed in production.

## Why this matters beyond the audit turning red

`vercel.json` is a live config file: the server reads its `routes` on boot and
[scripts/create-gcp-scheduler.mjs](../../scripts/create-gcp-scheduler.mjs) reads
its `crons` to sync Cloud Scheduler. A declared-but-unsynced cron is a feature
that looks shipped in the repo and is absent in production, which is the exact
failure mode the deploy-gap rule at the top of `ISSUES.md` warns about. Garment
job durability has already produced one incident class in this repo (batches
losing jobs unless paced), and a sweep that never runs is the safety net for it.

## Current state (re-verified 2026-09-02)

`vercel.json` now declares **111** crons, not the 101 in the reproduction above,
and `/api/cron/garment-job-sweep` is still one of them at `*/10 * * * *`.

Steps 2 and 5 are **done and re-verified**; only the live Cloud Scheduler write
remains, and it needs credentials this workspace does not have.

- **Step 2 (is the first tick safe?): yes.** The handler is a thin authenticated
  proxy to the worker's `/sweep`. The worker takes a lock, and claims are atomic
  generation-matched writes bounded by `MAX_CONCURRENT`, so overlapping ticks
  and live instances cannot double-run a job and a first run against a backlog
  cannot stampede. Since 2026-08-14 the call is also bounded by a 120s
  `AbortSignal.timeout`, well under Cloud Scheduler's 320s attempt deadline, so
  a wedged worker cannot stack hung requests every 10 minutes. Nothing to make
  safe: `*/10 * * * *` is correct as declared.
- **Step 5 (where does the drift check live?): done.** `check-cron-drift` is
  registered in `data/guards.json` with `stages: [gate, manual]`,
  `needs: gcloud`, and a `why` that splits the offline expression validation
  (in the gate, as `check:cron-syntax`) from the live comparison (manual, needs
  an authenticated session).
- **Step 1 (which kind of MISSING is this?): answered without gcloud.** An
  unauthenticated `curl https://three.ws/api/cron/garment-job-sweep` answers
  **401**, not 404, on the live revision `three-ws-api-00404-ph7`
  (commit `ad7b54c16`, re-probed 2026-09-02). That is exactly the distinction
  `classifyMissing()` in `scripts/check-cron-drift.mjs` exists to draw: the
  handler is present in the running revision and its cron gate is failing
  closed, so nothing but the Cloud Scheduler write is missing. The job can be
  created immediately; it does not have to wait for a deploy to ship the
  handler first.
- **Steps 3 and 4 are blocked on the owner.** `gcloud auth list` shows
  `nich@sperax.io`, but every API call fails with `Reauthentication failed.
  cannot prompt during non-interactive execution`, and application-default
  credentials fail too. `CRON_SECRET` is not in `.env` or `.env.local` (both
  hold only the QA audit login and `DATABASE_URL`), and the places it does live
  (the Cloud Run service env, Secret Manager) are behind the same dead session.

## The remaining owner step

One interactive login, then one surgical sync. `--only` was added for exactly
this on 2026-09-02: without it the sync re-touches all 111 jobs to repair one.

```bash
gcloud auth login                                    # interactive; only the owner can do this
CRON_SECRET=$(gcloud run services describe three-ws-api \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --format='value(spec.template.spec.containers[0].env.filter("name", "CRON_SECRET").extract("value"))') \
  node scripts/create-gcp-scheduler.mjs --only garment-job-sweep
npm run check:cron-drift                             # expect MISSING: 0
```

The sync is config-only and leaves run state untouched on existing jobs; a job
it CREATES starts ENABLED, which is what this one needs. Then watch the first
two ticks:

```bash
gcloud logging read 'resource.type="cloud_run_revision"
  resource.labels.service_name="three-ws-api"
  textPayload:"garment-job-sweep"' --freshness=1h
```

A 403 means the secret did not match; a 502 `sweep_unreachable` means
`GCP_GARMENT_FORGE_URL` / `GCP_RECONSTRUCTION_KEY` are unset on the service,
in which case the handler answers 200 `skipped: not_configured` instead.

## Verification

```bash
npm run check:cron-drift     # MISSING: 0
```
plus two successful invocations in the Cloud Run logs.

## Done when

Cloud Scheduler carries a job for every cron `vercel.json` declares (111 today,
and the count is derived rather than pinned: `npm run check:cron-drift` reads it
off the file), the sweep has demonstrably run twice without error, and the drift
check has a defined home so the next divergence is caught rather than
discovered.
