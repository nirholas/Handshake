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

## The job

1. **Confirm the gap from the other side**, not just from the audit:
   `gcloud scheduler jobs list --location us-central1
   --project aerial-vehicle-466722-p5 | grep garment`. (gcloud auth is working
   from this workspace as of 2026-08-01.)
2. **Read the handler before you schedule it.** A sweep that has never run may
   act on a large backlog on its first tick. Establish what it will do to the
   current `garment_jobs` state, and confirm the first run is safe at
   `*/10 * * * *`. If it is not, make it safe (bounded batch, idempotent claim)
   as part of this work order.
3. **Create the job with the existing script**, not by hand, so the id, the
   attempt deadline, and the auth header match all 100 siblings:
   `node scripts/create-gcp-scheduler.mjs --env-file .env` (it needs
   `CRON_SECRET`; the script exits with that exact message if it is unset).
   Read the script's argument handling first and prefer its resume path over
   re-touching all 101 jobs.
4. **Watch the first two ticks** in the logs:
   `gcloud logging read 'resource.type="cloud_run_revision"
   resource.labels.service_name="three-ws-api"
   textPayload:"garment-job-sweep"' --freshness=1h`. A 403 means the secret is
   wrong; a 5xx means step 2 was not finished.
5. **Then ask why the drift check is not blocking.** One cron drifted unnoticed,
   so the same thing can happen to the next. Decide where `check:cron-drift`
   belongs (it needs network and gcloud, so it cannot go in the offline gate)
   and register that decision in `data/guards.json` with a `why`.

## Verification

```bash
npm run check:cron-drift     # MISSING: 0
```
plus two successful invocations in the Cloud Run logs.

## Done when

Cloud Scheduler carries all 101 declared jobs, the sweep has demonstrably run
twice without error, and the drift check has a defined home so the next
divergence is caught rather than discovered.
