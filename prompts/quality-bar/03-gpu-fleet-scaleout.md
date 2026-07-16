# 03: GPU fleet scale-out and cold-start UX

Read `prompts/quality-bar/_shared.md` first. Its operating clause applies: finish 100%, never ask.

## Mission

Turn the single-GPU-per-model setup into a fleet that absorbs real traffic with credits:
fix the broken TripoSG worker, deploy text2motion, raise scale ceilings once quota lands, and
make every remaining cold start honest and pleasant in the UI. Users should never stare at a
silent spinner because a GPU was cold.

## Tasks

1. **Quota watch, then scale.** Poll `gcloud alpha quotas preferences list
   --project=aerial-vehicle-466722-p5` until `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion`
   grantedValue rises above 3 (increase to 16 filed 07-16). Then: `model-trellis` maxScale 3
   (keep min 1), `model-hunyuan3d` min 1 / max 2 (after prompt 02 lands it), `unirig` max 2,
   `model-triposr` min 0 / max 2. Verify each update leaves the service Ready. If the grant is
   denied or stalls for the whole session, file a fresh preference at a smaller ask (8) and
   document; do everything else regardless.
2. **Fix model-triposg.** It fails Cloud Run health checks (container never binds 8080 in time;
   the swarm fixed the CUDA build in 827e2f5c4, so the remaining issue is startup shape). Apply
   the standard pattern the other workers use (read `workers/model-trellis/main.py`): bind the
   port and return healthz immediately, load weights lazily in a background thread, report
   `loading` status until ready, and set `--timeout=600` plus a generous startup probe on the
   service. Rebuild, deploy to Ready, prove a generation through it, then wire `GCP_TRIPOSG_URL`.
3. **Deploy model-text2motion** (`workers/model-text2motion/`) the same way and set
   `GCP_TEXT2MOTION_URL`. Prove one text→motion clip end to end and note where the product
   consumes it (animation library / `src/animation-retarget.js` consumers).
4. **Cold-start honesty in the UI.** `api/_lib/forge-lane-health.js` already computes cold-start
   ETA. Make sure `/forge` (and every surface that polls a generation: `/ar`, MCP tool
   responses, agent screens) surfaces a real state: "GPU waking up, ~90s" with elapsed/remaining,
   then live stage labels (queued / shape / texture / finishing). No fake progress bars, real
   stages only. Skeleton previews over spinners.
5. **Keep-warm strategy.** With min-instances set, add a Cloud Scheduler ping only where
   min-instances is deliberately 0 (triposr, text2motion): a `*/10` healthz touch during peak
   hours (14:00-04:00 UTC) so first users rarely hit full cold starts. Crons are Cloud
   Scheduler jobs (NOT GitHub Actions); follow an existing job's shape in the runbook.
6. **Load test.** Fire 10 concurrent real generations through the router (mixed tiers) and
   record queue behavior, failover events, and p50/p95 completion. Fix anything that dropped a
   job silently; `api/_lib/forge-scale.js` owns concurrency limits.

## Definition of done

- TripoSG and text2motion Ready and proven through the router with saved outputs.
- Scale ceilings raised per quota (or the denial documented with the retry filed).
- Every generation surface shows real stage/ETA states at 320/768/1440 widths.
- Load test numbers in the report; changelog entry for the user-visible speed/reliability gain.

## Anticipated blockers, pre-answered

- Quota stuck in reconciling all session: proceed with everything else; the scale-up commands
  go in the report as ready-to-run one-liners.
- TripoSG weights missing from `three-ws-model-weights`: fetch the official release weights and
  stage them (record source URL + size).
- Scheduler job creation needs a service account: use the existing `three-ws@` runtime SA
  pattern from `docs/ops/gcp-production.md`.
