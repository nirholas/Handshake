# model-rig: auto-rigging worker (Make-It-Animatable engine)

Turns a static humanoid GLB into a fully animation-ready avatar: Mixamo-named
skeleton, per-vertex skinning weights, and the ARKit-52 expression blendshapes,
with the original materials and PBR textures preserved byte-for-byte.

This service replaced the retired `unirig` deployment, whose live instance
produced generically named 22-bone skeletons (unusable by the platform
retargeter), no blendshapes, and 20-minute latencies. The cutover is done:
`GCP_UNIRIG_URL` on `three-ws-api` points here, the old Cloud Run service is
deleted, and its worker directory was removed on 2026-08-11. The env var keeps
its historical name.

## How it works

1. **Predict**: [Make-It-Animatable](https://github.com/jasongzy/Make-It-Animatable)
   (MIT, CVPR 2025) infers joint positions, skinning weights, and pose for the
   52-bone Mixamo skeleton, fingers included, in under a second of GPU time
   (`engine_mia.py`). MIA is used purely as a predictor; its Blender/FBX export
   path is never invoked, so the visual mesh never round-trips through a
   converter that would degrade materials.
2. **Graft**: `rig_glb.py` writes the skeleton, `JOINTS_0`/`WEIGHTS_0`, and
   inverse bind matrices straight into the original GLB bytes (pure
   pygltflib/numpy; unit-tested without a GPU). Bones are named `mixamorig:*`,
   which `src/glb-canonicalize.js` maps 1:1 onto the platform's canonical bone
   set (proven by the `rig worker skeleton` cases in
   `tests/glb-canonicalize.test.js`) so a freshly rigged avatar drives the
   entire pre-baked clip library at 100% coverage.
3. **Expressions**: `blendshapes.py` transfers the 52 ARKit expression shapes
   from the [ICT-FaceKit](https://github.com/ICT-VGL/ICT-FaceKit) template head
   (MIT) onto the avatar's head region (nearest-surface correspondence with
   distance falloff), written as glTF morph targets with `targetNames`. This
   powers emotions and lipsync (`src/voice/arkit-blendshapes.js`,
   the embodiment stage) on generated avatars.

## API

Identical to the previous rig worker so `api/_providers/gcp.js` needs no code
change:

```
POST /rig        { mesh_gcs_url, template?, blendshapes?, job_id? }
                 -> 202 { task_id, status: "queued" }        (Bearer API_KEY)
GET  /tasks/:id  -> { task_id, status, rigged_gcs_url?, error?, elapsed_ms? }
GET  /health     -> { ok, model, gpu_available, gpu_name, model_loaded, queued }
```

Every task runs under a hard timeout (`TASK_TIMEOUT_S`, default 420 s): a task
finishes or fails, it can never sit in `running` forever. Task state is
in-memory by design; run with `min-instances = max-instances` so pollers reach
the owning instance (a restart 404s the poll and the platform fails the job
cleanly).

## Deploy

One-time asset staging (2.2 GiB of checkpoints from Hugging Face, the Mixamo
bone templates, and the baked ARKit template; ~2.3 GB total under
`gs://three-ws-model-weights/make-it-animatable/`):

```bash
bash workers/rig/stage-assets.sh
```

Build + deploy (Cloud Build pins the `three-ws-build@` service account):

```bash
gcloud builds submit --config workers/rig/cloudbuild.yaml \
  --substitutions=SHORT_SHA=manual$(date +%s) .
```

Service: `model-rig`, us-central1, 1x L4 (`--no-gpu-zonal-redundancy`), one
warm instance against the per-region L4 quota in `docs/ops/gcp-credits-plan.md`.

`_MIN_INSTANCES` and `_MAX_INSTANCES` must stay equal. Task state is in this
service's memory, so a second instance lets Cloud Run route `GET /tasks/:id` to
an instance that does not own the task and 404 a job running fine on the other.
The config said `max = 2` until 2026-08-11; the live service picks the fix up on
its next deploy.

## Cutover (already applied)

`GCP_UNIRIG_URL` on `three-ws-api` already resolves to this service. Re-run
this only after a redeploy that changes the service URL:

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars GCP_UNIRIG_URL=$(gcloud run services describe model-rig \
      --region us-central1 --format='value(status.url)')
```

Verify end-to-end (a static humanoid in, canonical rigged GLB out):

```bash
curl -sX POST "https://three.ws/api/forge?action=rig" \
  -H 'content-type: application/json' \
  -d '{"glb_url":"https://three.ws/avatars/mannequin.glb"}'
# poll the returned job_id via /api/forge?job=... and inspect the GLB:
# skins=1, bones named mixamorig:* (canonicalized at ingest), morph targets
# with ARKit targetNames present.
```

The old `unirig` Cloud Run service is already retired, freeing one L4 toward
the quota ceiling.

## Local tests (no GPU needed)

The three Python suites need only `numpy scipy pygltflib trimesh Pillow` (a
subset of `requirements.txt`; no torch, no CUDA, no GCP), and must be run from
this directory because they import the worker modules by name:

```bash
cd workers/rig
python3 test_rig_glb.py     # skin authoring: skeleton, weights, morph targets
python3 test_blendshapes.py # ARKit transfer: head mask, alignment, falloff
python3 test_pipeline.py    # core path: the 52-bone Mixamo + ARKit-52 contract
npx vitest run tests/glb-canonicalize.test.js   # from the repo root
```

`test_pipeline.py` runs the two stages composed the way `main.py._rig_sync`
composes them and asserts what the platform consumes: the exact 52 Mixamo bone
names, their hierarchy, unit-sum skin weights, 52 ARKit morph targets on the
head primitive and none on the body, and the source texture surviving
byte-for-byte. `tests/glb-canonicalize.test.js` pins the same 52 names from the
JavaScript side, so a drift on either side fails a test.

## Licensing

Every component is commercially clean, worldwide: Make-It-Animatable (MIT),
ICT-FaceKit (MIT), and this service's own code. No SMPL/FLAME research
licenses, no Hunyuan territory carve-outs, in the rigging path.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `API_KEY` | (secret) | shared bearer secret (`avatar-reconstruction-key`) |
| `GCS_BUCKET` | (required) | output bucket for rigged GLBs |
| `MIA_DIR` | `/app/mia` | Make-It-Animatable checkout |
| `ARKIT_TEMPLATE` | `/app/assets/arkit_template.npz` | baked ICT template |
| `MAX_CONCURRENT` | `1` | parallel rig jobs per instance |
| `TASK_TIMEOUT_S` | `420` | per-task hard timeout |
| `WEIGHTS_ROOT` | `/weights/make-it-animatable` | staged assets, read by `entrypoint.sh` |

`entrypoint.sh` copies the checkpoints and Mixamo templates from `WEIGHTS_ROOT`
(the FUSE-mounted weights bucket) onto local disk before serving, rather than
symlinking them: `torch.load` over gcsfuse does slow random reads and blew past
the startup probe.

## Failure modes

A task always reaches `done` or `failed`, never limbo. What a `failed` task
reports, and what to do about it:

| Reported `error` | Cause | Fix |
|---|---|---|
| `input is not a binary glTF...` | `mesh_gcs_url` returned something that is not a `.glb` (usually an error page) | fix the URL; the worker rejects it before touching the GPU |
| `input GLB contains no triangles...` | a point cloud or curves-only export | rig a surface mesh; the predictor cannot sample an empty face list |
| `rigging timed out after 420s` | `TASK_TIMEOUT_S` elapsed | retry, or raise the timeout for very dense meshes |
| `internal error (ref <id>)` | anything unexpected | grep the service logs for the correlation id; the full traceback is there |

Uploads of the finished GLB retry on transient network faults
(`DEFAULT_RETRY`); the default policy retries nothing without a generation
precondition, which once discarded a completed rig on a dropped connection.
