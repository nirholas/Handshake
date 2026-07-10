# 04 — Deploy the GPU worker fleet to Cloud Run (self-hosted 3D stack)

## Mission

Deploy the already-written GPU model workers to Cloud Run on our GCP credits and flip the forge
router's self-host backends live: TRELLIS (text/image→3D), Hunyuan3D, TripoSG/TripoSR, UniRig
(auto-rigging), and text2motion. Outcome: the paid forge lane stops paying Replicate (≈100%
margin during the credit window), the free lane stops being throttled by hosted NVIDIA NIM's
rate limits, image→3D opens up on the free lane (hosted NIM preview rejects user images; our
own TRELLIS accepts them), and prompt 05 gets a firehose for catalog seeding. Everything
reverts by unsetting env URLs.

## Prerequisites

- Prompt 01 ran: project set, Cloud Run/Cloud Build/Storage APIs enabled, `gcloud` authed.
- GPU quota: check `nvidia-l4` quota in the target region (`us-central1` unless the existing
  buckets/scripts say otherwise). File an increase immediately if < 4 GPUs — it can take days;
  deploy what fits now and document the pending ask.

## Context (from prior code audit; re-verify everything against the tree)

- Workers, each with `main.py` + `Dockerfile` + `cloudbuild.yaml` targeting Cloud Run L4
  (`--gpu=1 --gpu-type=nvidia-l4`, min-instances 0):
  `workers/model-trellis/` (TRELLIS-image-large), `workers/model-hunyuan3d/`,
  `workers/model-triposg/`, `workers/model-triposr/`, `workers/unirig/` (VAST UniRig —
  skeleton + skinning + ARKit-52 blendshapes; also `rig_glb.py`), `workers/model-text2motion/`.
  Deploy helpers in `workers/deploy/*.sh`; docs in `workers/README.md`, `workers/deploy/README.md`.
- Model weights staged in GCS bucket `three-ws-model-weights`; intermediate output to
  `three-ws-avatar-reconstructions`. Durable public assets stay on Cloudflare R2 (`api/_lib/r2.js`)
  — do not move asset storage to GCS.
- Shared auth between Vercel and workers: bearer `GCP_RECONSTRUCTION_KEY`.
- The router already has the code paths: `api/forge.js` (~2000 lines; lane routing) with
  backends `trellis_selfhost`, `hunyuan3d`, `triposg`; health-aware routing + cold-start ETA in
  `api/_lib/forge-lane-health.js` / `api/_lib/provider-health.js`; scale limits in
  `api/_lib/forge-scale.js`. Rigging goes through `api/_providers/gcp.js`
  (`GCP_RECONSTRUCTION_URL`, `/rig`) and `api/_lib/auto-rig.js`. Direct NIM-protocol path:
  `api/nim-forge.js` (`NIM_TRELLIS_URL`/`MODEL_TRELLIS_URL`).
- Env URLs the router reads (verify exact names in code): `MODEL_TRELLIS_URL`,
  `GCP_HUNYUAN3D_URL`, `GCP_TRIPOSG_URL`, `GCP_RECONSTRUCTION_URL`, `GCP_TEXT2MOTION_URL`.

## Tasks

1. **Pre-flight per worker.** Read each worker's README/cloudbuild/deploy script. Confirm the
   weights it expects exist in `three-ws-model-weights` (stage them if missing — the deploy
   scripts or READMEs describe how). Fix anything stale (base image, CUDA version pins) —
   these were written a while ago; a build that fails on today's Cloud Build gets fixed, not
   skipped.
2. **Deploy all six** via `gcloud builds submit` / the deploy scripts. Generate and set a strong
   `GCP_RECONSTRUCTION_KEY` (Cloud Run env + Vercel env). Configuration decisions:
   - Region: co-locate with the weights bucket.
   - **min-instances 1 for `model-trellis` and `unirig`** during the credit window (cold-start
     on L4 + model load is brutal; instances are ~free on credits). min-instances 0 for the
     rest. Document per-service settings.
   - Concurrency/timeouts per the worker READMEs; requests can run minutes — set Cloud Run
     timeout ≥ 900s where the code expects it.
3. **Health.** Curl each service's health endpoint directly, then confirm the platform's lane
   health (`forge-lane-health.js` / provider-health) registers them once env URLs are set.
4. **Wire Vercel env** (preview first): all five URL vars + `GCP_RECONSTRUCTION_KEY`. Confirm
   `api/forge.js` routing actually selects self-host backends — read the routing logic; if
   selection needs a flag or priority tweak to prefer self-host over Replicate/hosted-NIM,
   make that change **behind `FORGE_SELFHOST_PRIMARY=1`** with fallthrough to today's ladder on
   error, same fail-safe philosophy as the whole program.
5. **End-to-end verification (all five paths, real requests, definition of done):**
   - Text→3D free lane → self-hosted TRELLIS → GLB lands in R2, viewable via the viewer link.
   - Image→3D with a real input image (the thing hosted NIM couldn't do) → GLB.
   - Paid-lane `mesh_forge`-style chain (reference image → reconstruction) → GLB, with logs
     proving **Replicate was not called**.
   - Rig: send a generated GLB through `/rig` (UniRig) → animation-ready GLB; load it and
     confirm the skeleton drives the canonical clips (`src/glb-canonicalize.js` path).
   - text2motion: one text→motion generation → clip JSON.
   Record latency (cold + warm) for each in the runbook.
6. **Scale limits.** Revisit `forge-scale.js` ceilings that exist to protect the hosted-NIM
   free allocation: with self-host primary, raise the free-lane hourly/global ceilings to what
   the deployed GPU count sustains (compute it from measured per-asset latency; show the math).
   Keep abuse/per-IP limits intact. Flag-gate the raised limits with the same
   `FORGE_SELFHOST_PRIMARY` so revert restores today's ceilings.
7. **Cost note.** Compute $/asset from measured latency × L4 Cloud Run pricing; write it into
   `docs/gcp-credits.md` (prompt 08 needs it for the keep/kill decision at expiry).

## Guardrails

- Fallback ladder stays: self-host error → hosted NIM / Replicate / HF exactly as today.
- Don't commit any Cloud Build artifacts or `api/` files mangled by tooling — beware the known
  trap: `npx vercel build` overwrites `api/*.js` in place; check `head -1` of changed api files
  for `__defProp` before committing.
- R2 remains the asset store. GCS is weights/intermediates only.

## Acceptance criteria

- [ ] All six services deployed, healthy, and reachable with the bearer key.
- [ ] All five E2E paths verified with real outputs (GLBs/clips inspected, not just 200s).
- [ ] Replicate absent from paid-lane logs when `FORGE_SELFHOST_PRIMARY=1`.
- [ ] Raised free-lane limits computed and flag-gated.
- [ ] Latency + $/asset table in `docs/gcp-credits.md`; per-service Cloud Run config documented.
- [ ] Flags/URLs unset ⇒ today's behavior (spot-check one path).
- [ ] `npm test` green; `git diff` reviewed.

## Wrap-up

Changelog entry when this hits production (users notice: image→3D on free lane, faster/looser
limits) — plain-language, per CLAUDE.md. Update `STRUCTURE.md` only if a new surface/dir landed.
Commit explicit paths, push `threews` (the only push target). Report: what's live, GPU quota
state, cost table, and the env flips for production.
