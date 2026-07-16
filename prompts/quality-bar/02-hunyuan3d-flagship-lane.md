# 02: Hunyuan3D flagship lane, live and leading

Read `prompts/quality-bar/_shared.md` first. Its operating clause applies: finish 100%, never ask.

## Mission

Get `model-hunyuan3d` fully Ready on Cloud Run, verified end-to-end through the router, and
promoted to the quality-leading lane for paid/high tiers. Hunyuan3D-2 (shape + paint stages)
is the best mesh+texture model we self-host; it is the difference between "decent 3D" and
"looks like a photograph of a real object". Spend and weights are pre-approved.

## Current state (2026-07-16 21:15 UTC, re-verify)

- Revision `model-hunyuan3d-00005` is deploying, blocked on the L4 quota grant (3 granted, all
  held by trellis/triposr/unirig; increase to 16 filed, `gcloud alpha quotas preferences list`).
- The swarm shipped today: tier-mapped generation budgets (d9eb9059c), reconstruct wire shape
  (0c2cd1ec7), build deps (cc921f3d3), pinned ML stack (145c6b0fb), portrait realism cues
  (f131e51b0). Read `workers/model-hunyuan3d/main.py` and its cloudbuild before touching anything.

## Tasks

1. **Land the deploy.** Watch the quota preference; once granted (or after applying the
   documented interim fallback in `_shared.md`: triposr minScale to 0), confirm the revision
   goes Ready. If the container itself fails, read revision logs
   (`gcloud logging read 'resource.labels.service_name="model-hunyuan3d"' --limit 50`), fix,
   rebuild via its cloudbuild.yaml (pin the `three-ws-build@` SA), redeploy. Iterate to Ready.
2. **Weights.** Confirm the exact checkpoints main.py loads exist in `three-ws-model-weights`;
   if missing, download from the official Tencent Hunyuan3D-2 release and `gsutil cp` them in.
   Record sizes and paths in the report.
3. **Direct-worker E2E.** Bearer `GCP_RECONSTRUCTION_KEY`, POST a reference image, get a GLB.
   Verify the paint stage ran (textured, not gray). Time it warm and cold.
4. **Router E2E.** Set/confirm `GCP_HUNYUAN3D_URL` on `three-ws-api` env, confirm
   `api/forge.js` + `api/_lib/forge-tiers.js` route high/paid tiers to it with the tier budgets
   the swarm shipped, and run a real `/api/forge` request to a finished GLB. Confirm poll-time
   failover still degrades to TRELLIS if hunyuan 5xxs (kill-test it once).
5. **Quality tuning.** With credits approved, set high-tier budgets to what the L4 can bear:
   more octree resolution / inference steps on shape, max paint resolution, and multi-view
   conditioning (pairs with prompt 01). Warm-instance it (minScale 1) once quota is 16 so paid
   users never eat a cold start.
6. **Unblock the ChatGPT high tier.** Memory says high-tier-in-ChatGPT was rolled back because
   the HF lane blocks and true high needs this worker. With hunyuan live, re-enable the high
   tier for the GPT lane if the poll handle exists; otherwise document exactly what the GPT
   lane still lacks.
7. **Changelog + docs.** Holder-readable entry ("our most realistic 3D engine is live");
   update `workers/model-hunyuan3d/README.md` (create if missing) and the forge docs.

## Definition of done

- Service Ready, direct E2E and router E2E both proven with saved GLB URLs and screenshots.
- Failover kill-test passed. Tier budgets tuned and recorded. Changelog + READMEs shipped.
- Report includes warm/cold latency, GPU seconds per generation, and estimated credit burn per
  1,000 generations.

## Anticipated blockers, pre-answered

- Quota not granted after your best wait: apply the triposr-minScale-0 fallback, deploy, verify,
  restore triposr minScale 1 if quota later allows, and record the sequence.
- OOM on L4 (24GB): drop paint batch size / enable model CPU offload before dropping quality;
  raising memory does not add VRAM.
- Torch/CUDA wheel drift: the swarm pinned the stack today (145c6b0fb); do not upgrade pins,
  build on them.
