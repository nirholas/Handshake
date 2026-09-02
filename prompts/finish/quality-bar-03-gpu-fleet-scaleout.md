# QB-03: GPU fleet scale-out and cold-start honesty

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/quality-bar-03-gpu-fleet-scaleout.md`".
It is complete on its own. Also read `prompts/finish/quality-bar-_shared.md` and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end this session with a question, a plan you did not execute, or
   "should I proceed?". The owner is not available and does not want to be asked.
2. Every blocker has a pre-answered route in "Never blocked" at the bottom. Use it, note what
   you did in the report, keep going. If one part is genuinely impossible in this environment,
   ship every other part in full and name the single missing action in the report.
3. CLAUDE.md hard rules apply: no mocks, no stubs, no TODO comments, no fake progress, no
   em-dash or en-dash characters anywhere you write. Stage explicit paths only; other agents
   share this worktree. Do not `git push` unless the owner's message asked for it.
4. GCP spend is pre-approved (credits). Never trade quality for cost.

## Step 0: re-derive current state (do this first, trust nothing below)

This file's claims rot. Measure before you plan:

```bash
gcloud run services list --region us-central1 --project aerial-vehicle-466722-p5 \
  --format="table(metadata.name, status.conditions[0].status)"
timeout 120 gcloud alpha quotas preferences list --project=aerial-vehicle-466722-p5 2>&1 | head -40
gcloud run services describe three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --format=yaml \
  | grep -E "GCP_(TRIPOSG|TEXT2MOTION|HUNYUAN3D)_URL|MODEL_TRELLIS_URL"
curl -s "https://three.ws/api/forge?health" | head -40
```

As of 2026-08-01, `model-triposg`, `model-text2motion`, `model-trellis`, `model-triposr`,
`model-hunyuan3d` and `model-rig` were all Ready, so the original work order's "fix TripoSG"
and "deploy text2motion" tasks are shipped. Confirm that yourself, record the evidence, and
spend the session on what is still open.

The quota listing is slow and has returned empty in this workspace. Do not let it stall you:
`docs/ops/gcp-credits-plan.md` records the fleet position and the pre-approved scaling, and an
update that exceeds the grant fails with an explicit quota error, which is itself a measurement.
Attempt the scale change, read the error if there is one, and report the real ceiling.

## Tasks

1. **Scale ceilings.** Read the granted L4 quota
   (`NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion`). Within the grant, set
   `model-trellis` min 1 / max 3, `model-hunyuan3d` min 1 / max 2, `model-rig` max 2,
   `model-triposr` min 0 / max 2. Verify each service stays Ready after the update
   (`gcloud run services describe <name> --region us-central1 --format="value(status.conditions[0].status)"`).
   If the grant is smaller than the plan needs, scale to what fits, file a fresh preference
   at a smaller ask, and record both.
2. **Cold-start honesty in every polling surface.** `api/_lib/forge-lane-health.js` already
   computes a cold-start ETA. Every surface that polls a generation must render a real state:
   which lane, "GPU waking up, about Ns" with elapsed and remaining, then live stage labels
   (queued, shape, texture, finishing). Surfaces to check and fix: `/forge`
   (`pages/forge.html`, `src/forge*.js`), `/create`, MCP tool responses in `api/_mcp3d/` and
   `api/_mcp-studio/`, and any agent screen showing generation progress. Skeletons, never
   spinners. No fake progress: every number comes from the API response.
3. **Keep-warm only where minScale is 0.** For each such worker add a Cloud Scheduler healthz
   ping during peak hours (14:00 to 04:00 UTC, `*/10`). Crons are Cloud Scheduler jobs synced
   from `vercel.json`'s `crons` array by `scripts/create-gcp-scheduler.mjs`; follow an existing
   job's shape and `docs/ops/gcp-production.md`. Never propose GitHub Actions.
4. **Load test through the router, not the workers.** Fire 10 concurrent real generations at
   `POST https://three.ws/api/forge` across mixed tiers, poll each to a finished GLB, and
   record queue behavior, failover events, p50 and p95 completion. A job that dies silently is
   a defect: fix it (`api/_lib/forge-scale.js` owns concurrency limits) and re-run.
5. **Prove a lane, do not assume it.** A lane counts as live only when a real prompt returned a
   real GLB through `/api/forge` and that GLB parses with geometry. Direct worker curl does not
   count. Save the returned URLs in the report.

## Definition of done

- [ ] Scale ceilings applied within quota (or a smaller-ask request filed and recorded); every
      touched service still Ready.
- [ ] Cold-start and stage states render real data on `/forge` at 320, 768 and 1440 px,
      verified in a real browser via `npm run dev`, zero console errors from your code.
- [ ] Keep-warm scheduler jobs exist for every minScale=0 GPU worker, listed in the report.
- [ ] Load-test table (lane, tier, p50, p95, failovers, dropped jobs) with zero silent drops
      after your fixes.
- [ ] `npm test` green (never pipe it through `tail`, that masks the exit code).
- [ ] `data/changelog.json` entry for the visible speed and reliability gain, holder language,
      validated by `npm run build:pages`.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| `gcloud` auth dead (`invalid_rapt`) | It is the sperax.io Workspace reauth policy, not token expiry. Do every non-gcloud task in full, put the exact gcloud commands in the report as ready-to-run one-liners, and note that one `gcloud auth login` clears them. |
| Quota stuck reconciling | Proceed with everything else; the scale-up commands go in the report. |
| Worker weights missing | Stage from `gs://three-ws-model-weights` or the worker README's source. Staging weights is part of the task. |
| A worker will not bind in time | Use the bind-first plus background-load pattern from `workers/model-trellis/main.py`, plus `--timeout=600` and a generous startup probe. |
| Scheduler job needs a service account | Use the `three-ws@` runtime SA pattern from `docs/ops/gcp-production.md`. |
| A third-party lane is down | Every lane has a failover chain in `api/forge.js`. Use it; adding a missing rung is part of the task. |

## Report format

What shipped, what was already shipped before you started plus the evidence that proved it,
the load-test table, every command that changed cloud state, and the single owner action if one
remains. No recap of this file.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/quality-bar-03-gpu-fleet-scaleout.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
