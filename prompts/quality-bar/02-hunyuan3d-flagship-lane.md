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

## Live E2E findings (2026-07-16 21:45 UTC, from a real Vertex-image -> /infer run)

A full direct-worker E2E was run against the ACTIVE revision (00005, Ready=True, L4 attached,
GCP_HUNYUAN3D_URL already set on three-ws-api). Result: the task queued forever. Root causes,
read before iterating on task 1:

- **The deployed image's ML stack is incompatible.** Pipeline load fails at
  `from hy3dgen.texgen import Hunyuan3DPaintPipeline` with
  `ImportError: cannot import name 'FLAX_WEIGHTS_NAME' from 'transformers.utils'`
  (diffusers pins an old transformers API), and transformers also logs
  `PyTorch >= 2.4 is required but found 2.3.1+cu121` and missing torchvision. One instance
  died with signal 11 after the failed load. Commit 145c6b0fb's pin fix may resolve this in the
  NEXT image; revision 00006 already failed to go Ready, and 4+ builds were queued at 21:34.
  Verify what the newest image actually contains before rebuilding blind: the fix must yield a
  consistent trio (torch, transformers, diffusers) that hy3dgen.texgen imports cleanly.
- **Queued tasks never fail.** When the background pipeline load dies, `/infer` keeps
  accepting jobs and persisted tasks stay `queued` forever; pollers (and the router's
  failover) get no failure signal. Fix in `main.py`: once `load_error` is set, fail all
  queued tasks and 503 new `/infer` calls so poll-time failover can kick in.
- **Cold pipeline load is 10+ minutes** even when imports succeed: the multi-GB DiT
  safetensors are read through the GCS FUSE mount, which logs stalled-read retries
  (`stalled read-req cancelled after 1.5s`). Mitigate with gcsfuse file-cache/parallel-download
  mount options on the volume, or bake weights into the image. minScale 1 masks it in steady
  state but every deploy and scale-up pays it; the E2E verification in task 3 must wait out or
  eliminate this window.
- Repro harness: a working Vertex `gemini-2.5-flash-image` -> `/infer` E2E script pattern is
  simple: generate the reference via `:generateContent` with `responseModalities:["IMAGE"]`,
  POST `{images:["data:image/png;base64,..."], tier:"high"}` with bearer key from Secret
  Manager `avatar-reconstruction-key`, poll `/tasks/:id`. Health at `/health` reports
  `pipeline_loaded`/`load_error`; poll that first and do not submit until `ready:true`.

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
