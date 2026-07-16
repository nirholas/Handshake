# 06 - Quality eval harness: generation quality can never silently regress again

Read `README.md` in this directory first (never-stop contract, standing approvals, shared
context). Never end a turn with a question. GCP spend is pre-approved (this harness burns GPU
seconds nightly by design); no new third-party APIs.

## Mission

Prompts 01-03 raised generation quality. Nothing currently guarantees it stays raised: the
only organic signal is download rate, and a bad worker deploy would show up as user complaints
days later. Build the regression harness: a fixed golden-prompt set generated nightly on every
live lane, scored, trended, and alerting on regression. Run it last, after 01-03 land, so the
goldens capture the improved baseline.

## Current state (verified 2026-07-16; re-verify)

- Every generation already gets a quality score in its metadata (mesh-degeneracy check + score,
  shipped in the forge quality work; find it via `grep -rn "quality_score\|qualityScore" api/`).
- `forge_creations` table records every generation (tier, lane, score, sizes, timings).
- Cron pattern: `vercel.json` `crons` array is the source of truth; production runs Cloud
  Scheduler jobs hitting `/api/cron/<name>` with `Authorization: Bearer $CRON_SECRET`.
  IMPORTANT (memory 07-09): a NEW cron needs its Cloud Scheduler job created manually
  (`scripts/create-gcp-scheduler.mjs`); adding it to vercel.json alone does nothing in prod.
- Autonomous-agent health-check precedent to copy: the x402 Granite health check
  (every 6h, real calls, verdict recorded, public feed at `/api/x402/granite-health`).
- Lanes to cover: selfhost TRELLIS (draft/standard), Hunyuan3D (high), hosted NIM (failover),
  HF Spaces lane (failover), avatar chain (generate -> rig).

## Tasks

1. **Golden set.** 8 object prompts + 4 human prompts, fixed seeds where lanes support them
   (`seed` param exists on the forge API). Include the eval prompts from 01/02 so history is
   comparable. Store the set in `data/` as the single source.
2. **Nightly cron** `/api/cron/forge-quality-eval`: for each lane in rotation (spread lanes
   across the week if a full nightly sweep is too heavy; document the rotation), run the
   golden set through the real production path, record per-item: lane, revision (worker
   `/health` can expose image tag; add it if missing), score, tri count, texture size, GLB
   bytes, wall time. Persist to a new `forge_quality_runs` table (migration in the existing
   migrations dir; follow neighboring migration style).
3. **Regression rule.** Median score of a lane drops > 10% vs its 7-day median, or any golden
   fails to generate: mark the run regressed, write an ops alert through the existing alerting
   path (the Granite health check shows the pattern), and flag it on the internal health check.
4. **Trend surface.** Page at `/quality` (or a dashboard-next page if that fits existing
   patterns better): per-lane score trend, last-run table, per-golden thumbnails
   (rendered through the cinematic stage from prompt 03). Public is fine; it is a flex.
   Register in `data/pages.json`, row in `STRUCTURE.md`, changelog entry.
5. **Wire and prove.** Create the Scheduler job, trigger it manually once
   (`gcloud scheduler jobs run`), watch it complete, verify rows + page render from the real
   run. Then trigger a synthetic regression (temporarily point one lane's score threshold up)
   to prove the alert fires, and revert.

## Guardrails

- The eval must use the production request path (real `/api/forge` calls with an internal
  bypass key if one exists; check `api/_lib/` for the partner-key pattern), not worker-direct
  calls, so routing regressions are caught too.
- Nightly GPU cost is intentional but bounded: cap a run at ~30 generations; the rotation
  covers the rest.
- Never let eval traffic pollute user-facing galleries or `forge_creations`-driven surfaces:
  tag eval records and filter them everywhere the table feeds UI (grep every consumer).
- New cron = manual Scheduler job creation (see above). Do not assume.

## Acceptance criteria

- [ ] One full real nightly run recorded end to end (row counts + screenshots of /quality).
- [ ] Synthetic regression fired the alert and the health-check flag (evidence in report).
- [ ] Eval records invisible on all user-facing surfaces (list the consumers you checked).
- [ ] Scheduler job exists in GCP and in `vercel.json` crons; both shown in the report.
- [ ] Committed with changelog + docs (`docs/` entry for the harness, page registered); `npm test` green.
