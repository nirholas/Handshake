# garment-forge: text prompt → rigged, wearable garment GLB + manifest

Turns "a white oxford cotton dress shirt" into an asset the additive wardrobe
can put on **any** humanoid avatar: a garment GLB skinned to the three.ws
canonical skeleton, a manifest that passes every validation rule in
[specs/GARMENT_MANIFEST.md](../../specs/GARMENT_MANIFEST.md), and a thumbnail,
published to the immutable catalog layout in `gs://three-ws-garments/garments/`
(the public bucket [src/garment-catalog.js](../../src/garment-catalog.js)
serves the wardrobe closet from).

The runtime consumer is `attachGarment()` in
[src/avatar-garment.js](../../src/avatar-garment.js): it rebinds the garment's
skin onto the target avatar's skeleton and refuses anything that binds under
`MIN_BIND_COVERAGE` (60%) of its skin weight. This worker measures that same
number before publishing and fails the job loudly rather than emitting a bad
asset.

## Skinning bake-off (why the rig-worker lane)

Two candidate skinning paths were built independently and raced on 2026-07-25:
the same generated shirt was skinned by (A) the rig-worker composite lane this
worker uses and (B) a local proximity weight-transfer
([lib/skin-transfer.mjs](lib/skin-transfer.mjs)), then both were attached to
the parametric base and driven through the canonical walk clip
([scripts/garment-rig-bakeoff.mjs](../../scripts/garment-rig-bakeoff.mjs)).
Cloth-to-body deviation across the gait:

| Path | mean | p95 | max |
|---|---|---|---|
| A rig-worker (production) | **2.87 cm** | **6.36 cm** | 16.12 cm |
| B proximity transfer | 5.88 cm | 13.06 cm | 21.02 cm |

A won decisively and is the only production lane. The proximity lib is kept
solely as the offline test harness for the runtime binder's contract test
(`tests/garment-forge-skin-transfer.test.js`) — see the note in its header.
Re-run the bake-off whenever either path changes.

## How it works

This is a **CPU orchestrator**, not a model host. Every heavy stage runs on a
GPU worker that is already deployed; garment-forge chains them and does the
pure glTF work in between:

1. **Reference image** (`pipeline.generate_reference_image`): the prompt
   becomes a ghost-mannequin product photo via the platform's live Vertex AI
   image lane (`gemini-2.5-flash-image`, the model that replaced the retiring
   Imagen `:predict` family; see `api/_mcp3d/vertex-imagen.js` for the model
   landscape). The photo is posed to match the reference body: worn shape,
   A-pose, front view, plain background. Reference quality drives mesh
   quality; the resolution is held at 2K.
2. **Mesh** (`pipeline.generate_mesh`): the image goes through the deployed
   image→3D failover chain, first healthy rung wins:
   `model-hunyuan3d-21-rtx` (warm primary, full PBR: albedo +
   metallicRoughness + normal) → `model-hunyuan3d-21` (L4 fallback, same
   image) → `model-trellis` (different model, same API contract).
3. **Compose** (`garment_glb.compose_scene`): the garment mesh is scaled and
   placed into its slot's region box on the canonical reference body
   (`assets/refbody.glb`, staged from `public/avatars/parametric-base.glb` at
   build time: A-pose, 1.667 m, 52 mixamorig joints, front +Z). Slot boxes are
   measured against that body in `garment_glb.SLOT_BOXES`.
4. **Rig** (`pipeline.rig_composite`): the *composite* (body + garment) goes
   to the deployed `model-rig` worker (Make-It-Animatable). Rigging the
   composite rather than the garment alone is the load-bearing trick: the
   rigger sees a normally proportioned clothed humanoid, so the skeleton
   lands at body scale and the garment's vertices pick up weights from the
   joints they actually sit on. Rigging a shirt alone would fit a full
   skeleton inside the shirt and shred it on first animation.
5. **Extract** (`garment_glb.extract_garment`): the reference body is
   stripped back out. The binary buffer is rebuilt from scratch (only the
   garment's geometry, skin matrices, and textures survive), and joint names
   are canonicalized (`mixamorig:LeftArm` → `LeftArm`).
   Placement also enforces a **size envelope** (`max_extent` in `SLOT_BOXES`).
   The fit axis pins the invariant dimension, but nothing else bounds the
   others, and a generator asked for "long straight hair" can return a mesh
   1.4 m deep whose width is still a perfect 0.30 (live defect 2026-07-27: it
   floated 36 cm above the crown and measured 78 cm off the body in the gait
   audit). That mesh is malformed, not mis-scaled, so the job fails with the
   measurement instead of publishing it. Hair additionally anchors its TOP to
   the crown, so length hangs down the back rather than straddling the head.
6. **Validate + publish**: skin-weight statistics produce the bind coverage,
   the `occludes` declaration (any REGION_BONES region carrying ≥ 10% of the
   garment's skin weight, then clamped to the slot's plausible region set,
   `SLOT_OCCLUDABLE`: a shirt's waistband graze must not amputate the
   avatar's legs, and headwear/hair may occlude nothing at all), and the
   manifest's `rig.bones`. All 6 manifest validation rules run in-process;
   any failure fails the job. On success `garment.glb`, `manifest.json`, and
   `thumb.webp` (from the reference image) land in
   `garments/<slot>/<id>/v<version>/` and the manifest is appended to
   `garments/catalog.json` under an optimistic generation-match loop.

## API

Same wire shape as `workers/avatar-reconstruction` (bearer `API_KEY`):

```
POST /generate   { prompt, slot, tier?, yaw_deg?, job_id? }
              →  202 { job_id, status: "queued" }
GET  /jobs/:id → { job_id, status, stage, glb_url?, manifest_url?, thumb_url?,
                   coverage?, occludes?, bones?, error?, updated_at }
GET  /health   → { ok, refbody_loaded, mesh_backends, rig_url, active_jobs }
```

`slot` is one of `top, bottom, footwear, outerwear, hair, headwear, glasses,
accessory`. `stage` walks `image → mesh → compose → rig → extract → validate
→ publish` so pollers can show real progress. Job state is durable in GCS
(`garments/jobs/<id>.json`), so polls survive instance restarts and the
service scales to zero.

Example:

```bash
KEY=$(gcloud secrets versions access latest --secret avatar-reconstruction-key)
URL=$(gcloud run services describe garment-forge --region us-central1 --format='value(status.url)')

JOB=$(curl -s -X POST "$URL/generate" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"prompt":"a white oxford cotton dress shirt, long sleeves, buttoned","slot":"top"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["job_id"])')

watch -n 10 "curl -s $URL/jobs/$JOB -H 'authorization: Bearer $KEY' | python3 -m json.tool"
```

A finished job reports the published `manifest_url`, `glb_url`, and the
measured `coverage`.

The platform exposes this worker publicly (rate-limited, key held server-side)
at `POST /api/garment-forge` + `GET /api/garment-forge?job=<id>` via
[api/garment-forge.js](../../api/garment-forge.js) and the
`GCP_GARMENT_FORGE_URL` env var on `three-ws-api`; see the "Generating new
garments" section of [docs/avatar-wardrobe.md](../../docs/avatar-wardrobe.md).

## Deploy

```bash
gcloud builds submit --config workers/garment-forge/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s) .
```

The build stages the reference body out of `public/avatars/` (the repo keeps
one copy), runs `test_garment_glb.py` as a build gate, and deploys the
`garment-forge` Cloud Run service (CPU only, scale-to-zero, runtime SA
`avatar-reconstruction-sa@`, `API_KEY` from the `avatar-reconstruction-key`
secret). The cloudbuild config pins the `three-ws-build@` service account,
as every build in this project must.

One-time infra the service depends on (already applied):

- `avatar-reconstruction-sa@` has project-level `roles/storage.objectAdmin`
  (writes to both buckets) and `roles/aiplatform.user` (Vertex image lane).
- `three-ws-garments` is uniformly public-read with a permissive GET CORS
  policy, satisfying the manifest spec's CORS requirement; job records and
  rig staging stay in `three-ws-avatar-reconstructions`.

## Job durability: the record IS the queue

A job's record in GCS (`garment-jobs/<id>.json`) is not just status for
pollers, it is the work queue. Work is **claimed at execution time**: an
instance only owns a job once it holds a concurrency slot AND wins an atomic
generation-matched write on the record (`status: running`, `attempts+1`,
`owner`). Everything the pipeline needs (prompt, slot, tier, yaw) is persisted
at submit, so any instance can drive a job it never saw submitted.

This exists because the obvious design silently loses work. Handing every
submission to the instance's FastAPI background queue means jobs past
`MAX_CONCURRENT` wait on an in-memory semaphore, and Cloud Run reclaiming that
instance (idle scale-down, revision rollout, crash) takes them with it while
their records sit at `queued`. A 22-piece catalog batch lost 12 that way on
2026-07-26; the same pieces resubmitted two at a time all published.

Recovery paths, in order of speed:

1. **A freed slot drains the backlog.** When a job finishes, the instance
   immediately looks for one more claimable job.
2. **`POST /sweep`** (bearer `API_KEY`) claims up to `MAX_CONCURRENT`
   orphaned jobs and drives them. Called every 10 minutes by
   [api/cron/garment-job-sweep.js](../../api/cron/garment-job-sweep.js) via
   Cloud Scheduler. Overlapping sweeps are safe: the claim is atomic, so a job
   can never be double-run or double-published.
3. **The read-path watchdog** (`GET /jobs/:id`) requeues a job whose owner
   went silent past `JOB_STALE_S` instead of burying it, and only declares
   terminal failure once `JOB_MAX_ATTEMPTS` (default 3) is spent, so a
   reclaimed instance costs an attempt rather than the job.

The claim policy is pure and unit-tested in
[job_queue.py](job_queue.py) / [test_job_queue.py](test_job_queue.py) (22
checks, a Docker build gate): who may claim, who may never be stolen, and
what a stale record becomes.

## Local tests (no GPU, no network)

```bash
python3 workers/garment-forge/test_garment_glb.py   # pure glTF pipeline
python3 workers/garment-forge/test_job_queue.py     # durable-queue policy
```

## Catalog quality audit

`npm run audit:garments` sweeps the LIVE catalog: consumer validation, sha256,
the real `attachGarment()` bind on FOUR different humanoid rigs (the canonical
base plus Mixamo/meshopt, the clip-library reference rig, and a studio body),
and the walk-gait cloth-to-body deviation metric, with per-slot p95 ceilings.
Cross-rig binding is a hard gate, not a nicety: the catalog's whole promise is
that a piece fits whatever humanoid is loaded, so a refusal on any rig fails
the run. Hard failures (validation reject, hash mismatch, attach refusal on any
rig) exit non-zero, so run it after any seeding batch or placement change;
ceiling breaches are review flags, printed with the numbers.

```
npm run audit:garments                          # default 4-rig sweep
node scripts/audit-garments.mjs --avatars a.glb,b.glb   # pick your own rigs
```

Baseline 2026-07-27: 23 entries, all binding at 1.00 coverage on all four
rigs, 0 hard failures.

33 checks over the pure glTF pipeline: canonicalization, placement math,
composition, body-strip + buffer repack, coverage/occludes derivation, and
each of the 6 manifest validation rules failing for its own reason. The same
suite runs inside `docker build`, so a regression cannot ship.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `API_KEY` | (secret) | shared bearer secret (`avatar-reconstruction-key`); also sent to the mesh/rig workers |
| `GCS_BUCKET` | (required) | job records + rig staging (`three-ws-avatar-reconstructions`) |
| `PUBLISH_BUCKET` | (required) | public catalog bucket (`three-ws-garments`) |
| `MESH_WORKER_URLS` | (required) | comma-separated `/infer`-contract mesh workers, priority order |
| `RIG_URL` | (required) | `model-rig` base URL |
| `REFBODY_PATH` | `/app/assets/refbody.glb` | reference body baked into the image |
| `GOOGLE_CLOUD_PROJECT` | (required) | Vertex project |
| `VERTEX_IMAGEN_MODEL` | `gemini-2.5-flash-image` | Vertex image model |
| `VERTEX_IMAGEN_LOCATION` | `global` | Vertex location for the image model |
| `VERTEX_IMAGE_SIZE` | `2K` | reference image resolution |
| `GARMENT_YAW_DEG` | `0` | yaw applied to generator output before placement |
| `MESH_TIMEOUT_S` / `RIG_TIMEOUT_S` | `1200` / `600` | per-stage poll ceilings |
| `MAX_CONCURRENT` | `2` | parallel jobs per instance |

## Provenance and licensing

Generated manifests carry `source.kind: "generated"` with the prompt, the
mesh backend that produced the geometry, and `pipeline: "garment-forge@1"`,
so every catalog entry is reproducible and auditable. The reference body is
CC0 (MakeHuman/MPFB2-derived), Make-It-Animatable is MIT, and published
manifests declare `CC0-1.0`.
