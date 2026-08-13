# MASTER 08: The Operator (production hardening and deploy readiness)

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, then add `TARGET: <one line naming the feature>` or the
Storyteller's HANDOFF block. Read [README.md](README.md) for the relay protocol and
`docs/ops/gcp-production.md` for the production ground truth. This file is complete on
its own.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Everything short of the
   deploy itself ships this session; the deploy lands as one prepared command.
2. Production deploys and pushes are owner-gated (CLAUDE.md gate 2) unless the owner's
   current instruction is itself the approval. This stage prepares to one command and
   verifies everything preparable; it does not fire the gate on its own.
3. GCP spend for quality and reliability is pre-approved (credits plan in
   `docs/ops/gcp-credits-plan.md`); new external paid APIs are not. No em-dash or en-dash
   anywhere; explicit-path commits.

## Mission

Make the feature boring in production: observable when it misbehaves, resilient when its
dependencies fail, cheap to run at 100x, and deployable with one command. A feature is not
shipped until the person on call can see it, and not durable until its failure modes have
somewhere soft to land.

## Step 0: re-derive current state

```bash
npm run db:status                          # nothing surprising pending before a deploy
npm run check:rules -- --paths $(git diff --name-only HEAD~15 | tr '\n' ' ')   # relay debt
gcloud run services describe three-ws-api --region us-central1 --project aerial-vehicle-466722-p5 --format=yaml | grep -A30 env   # env vars the feature needs, present or not
gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="three-ws-api" severity>=ERROR' --freshness=6h --limit=20   # error baseline before the feature ships
curl -s https://three.ws/api/version       # what production runs right now
```

Record the production error baseline; after deploy, the same query is the regression check.

## Method

1. **Observability.** The feature's failures are findable in Cloud Run logs by a stable,
   grep-able marker (follow the logging patterns of neighboring handlers). Every external
   call it makes logs failures with enough context to diagnose without a redeploy. If the
   platform's health or status surfaces enumerate subsystems, the feature's lane reports
   there (follow the existing provider-health pattern in `api/_lib/`). Generation-shaped
   features record per-job backend/status/error the way `forge_creations` does.
2. **Resilience.** Every dependency has its failover rung wired and TESTED by killing the
   primary locally and watching the rung catch. Rate limits on any new public endpoint
   (follow the existing rate-bucket patterns). Idempotency on any mutation a retry could
   double-fire. Timeouts on every outbound call; no unbounded hangs.
3. **Cost and capacity.** Estimate the feature's marginal cost per 1,000 uses (compute,
   storage, third-party calls) from real measurements, not vibes. If it adds GPU or worker
   load, check quota headroom (`gcloud alpha quotas preferences list`) and file increases
   now if 10x growth would hit a wall. Prefer GCP surfaces; credits are pre-approved.
4. **Config completeness.** Every env var the feature reads exists on the Cloud Run
   service or is queued in the prepared deploy command (`--update-env-vars`, never
   `--set-env-vars`). Crons the feature needs are in `vercel.json` `crons` (Cloud
   Scheduler syncs from it). Routes it needs are in `vercel.json` `routes`.
5. **Deploy preparation, per the runbook, in order.** `npm run clean:worktrees` first;
   clean detached worktree with the three hardlinked artifacts plus `.env`;
   `npm run build:gcp` (never hand-reordered, never `build:vercel` for the frontend);
   run the `deploy-preflight` subagent and fix everything it reports. The end state: the
   submit command (with its service-account pin and SHORT_SHA substitution), the purge,
   and the verify steps written out, so shipping is paste-and-run.
6. **Rollback story.** One paragraph, pre-written: how to know the feature is misbehaving
   post-deploy (the log query, the smoke command), and the exact rollback command
   (previous revision routing per the runbook). On-call quality, not an essay.

## Definition of done

- [ ] Failure paths produce findable log lines; the grep that finds them is in the report.
- [ ] Every failover rung tested by killing its primary; evidence in the report.
- [ ] New public endpoints rate-limited; mutations retry-safe; outbound calls time-bounded.
- [ ] Cost per 1,000 uses measured and stated; quota headroom confirmed or increase filed.
- [ ] Env, crons, and routes complete; the full deploy command sequence prepared verbatim.
- [ ] `deploy-preflight` subagent run, all findings fixed; `npm test` green (unpiped).
- [ ] Rollback paragraph written; post-deploy verification commands listed
      (`curl -s https://three.ws/api/version`, `npm run smoke:prod`, the log query against
      the Step 0 baseline).
- [ ] `npm run check:rules -- --paths <files you touched>` clean.
- [ ] HANDOFF block emitted, `next-stage: done` (or backward to a stage whose defect this
      stage exposed), owner-notes carrying the single deploy approval ask.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| A needed env var exists nowhere | Wire the feature fully behind it, prove the code path mock-free, put the one-line var ask in owner-notes. The deploy does not wait; the var can land as a config-only update later (those are pre-approved). |
| GPU or quota wall | File the increase immediately, then route around it (lower an idle service's minScale, another region, queue behind capacity). Never park the task on the quota. |
| Disk full during worktree prep | `npm run clean:worktrees --apply`; the symptom masquerades as a git checkout error (runbook step 0 exists because of this). |
| Deploy died mid-build previously | Run `deploy-preflight`; it exists for exactly this. Do not re-submit blind. |
| The error baseline query shows pre-existing production errors | Not yours to inherit silently: note them in open-risks with counts so post-deploy regression checks do not misattribute them to the feature. |
| Cost measurement needs production traffic | Measure locally with realistic payloads for the marginal cost, state the extrapolation honestly, and add the log marker that will let the first week of real traffic confirm it. |

## Report format

1. Solana position first if the feature touches value transfer; then observability,
   resilience, and cost evidence.
2. The prepared deploy sequence, verbatim, ready to paste.
3. The rollback paragraph.
4. The HANDOFF block, owner-notes carrying the single batched approval ask.
