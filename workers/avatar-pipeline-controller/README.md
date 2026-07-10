# avatar-pipeline-controller

The CPU orchestrator behind **Scan yourself to 3D**. A FastAPI service that turns
selfie photos into one rigged, animation-ready GLB by fanning out to the GPU
model + rigging workers and surfacing the whole thing as a single job the site
can poll.

The site talks **only** to this controller. It never calls the mesh or rigging
GPU services directly — the controller picks a mesh backend, runs the raw mesh
through UniRig, uploads the final GLB to Cloud Storage, and reports status. It
holds no model weights and runs no inference; all GPU work happens in the
services it calls. It keeps the same external contract the original
`avatar-reconstruction` service exposed, so the backend provider
([`api/_providers/gcp.js`](../../api/_providers/gcp.js), env
`GCP_RECONSTRUCTION_URL`) needed no changes when the pipeline was split into
per-model services.

```
/scan (browser)
   └─ POST /api/avatars/reconstruct        (three-ws-api on Cloud Run)
        └─ controller  POST /reconstruct    (this service, Cloud Run, CPU)
             ├─ mesh model  POST /infer      (Cloud Run, L4 GPU)  Hunyuan3D / TRELLIS / TripoSR / TripoSG
             └─ UniRig      POST /rig        (Cloud Run, L4 GPU)  skeleton + skinning + blendshapes
                  └─ rigged GLB → GCS → GET /jobs/:id returns glb_url
```

## What it does

For each job the controller (`main.py`, `_run_pipeline`):

1. **Picks a mesh backend** — weighted random over the backends whose URL env var
   is set (`_pick_model`), or honours an explicit `model` in the request when
   that backend is configured.
2. **Generates the mesh** — `POST {backend}/infer` with the images, then polls
   `GET {backend}/tasks/:id` (3 s cadence, 300 s timeout) until the raw mesh GCS
   URL is ready.
3. **Auto-rigs** — if `UNIRIG_URL` is set and `SKIP_RIGGING` is off, `POST
   {UNIRIG_URL}/rig` with the mesh URL (`template: "wolf3d_neutral"`,
   `blendshapes: true`), polls to completion (3 s cadence, 180 s timeout). If
   UniRig rejects the job, the pipeline falls back to the unrigged mesh rather
   than failing.
4. **Finalizes** — copies the resulting GLB into the output bucket under
   `avatars/{job_id}.glb` (skipped if it is already there) and writes the final
   `status: "done"` + `glb_url` + timing to Firestore.

Job state lives in the Firestore collection `avatar_pipeline_jobs`, so a job
survives an instance restart and any instance can answer a poll. All
inter-service calls carry the shared bearer secret; failures are recorded as
`status: "failed"` with an opaque, correlation-id-tagged error (`safe_error` in
`worker_security.py`).

> This service exposes **no** `/rig` endpoint of its own — it *calls* UniRig's
> `/rig`. `api/_providers/gcp.js` falls back to `GCP_RECONSTRUCTION_URL` for
> `rerig` jobs only when `GCP_UNIRIG_URL` is unset; in that fallback the rig
> submit hits this controller's non-existent `/rig` and 404s. Set
> `GCP_UNIRIG_URL` so `rerig` reaches the real UniRig worker.

## API

All routes require an `Authorization: Bearer <API_KEY>` header (constant-time
check). `/health` is unauthenticated.

### `POST /reconstruct` → `202`

Request:

```json
{
  "images": ["https://…/selfie1.jpg", "https://…/selfie2.jpg"],
  "body_type": "neutral",
  "model": null,
  "tier": null,
  "path": "image",
  "target_polycount": null,
  "job_id": null
}
```

- `images` — 1 to 6 image URLs (required).
- `body_type` — defaults to `"neutral"`.
- `model` — optional; force a specific configured backend (`hunyuan3d`,
  `trellis`, `triposr`, `triposg`). Ignored if that backend isn't wired.
- `tier` / `path` / `target_polycount` — optional quality-tier provenance
  ([`api/_lib/forge-tiers.js`](../../api/_lib/forge-tiers.js)). `target_polycount`
  (100…1,000,000) is forwarded to backends that honour a poly budget and recorded
  on the job.
- `job_id` — optional caller-supplied id; a UUID is generated if omitted.

Response:

```json
{ "job_id": "6f1c…", "status": "queued", "model": "hunyuan3d" }
```

The pipeline runs in a background task; poll `/jobs/:id` for progress.

### `GET /jobs/{job_id}` → `200` / `404`

Returns the full Firestore job document, e.g.:

```json
{
  "job_id": "6f1c…",
  "status": "done",
  "stage": "done",
  "model": "hunyuan3d",
  "image_count": 2,
  "body_type": "neutral",
  "tier": null,
  "path": "image",
  "mesh_gcs_url": "https://storage.googleapis.com/…/mesh.glb",
  "mesh_time_ms": 42010,
  "rig_time_ms": 18300,
  "glb_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/avatars/6f1c….glb",
  "total_time_ms": 61550,
  "created_at": "2026-07-10T12:00:00+00:00",
  "updated_at": "2026-07-10T12:01:01+00:00"
}
```

`status` progresses `queued → running → done` (or `failed`); `stage` mirrors the
active step (`queued`, `mesh_generation`, `rigging`, `finalizing`, `done`,
`failed`). A failed job carries an opaque `error` string. `404` if the id is
unknown.

### `GET /health` → `200`

```json
{
  "ok": true,
  "pipeline": "avatar_pipeline_controller_v2",
  "backends": ["hunyuan3d", "trellis"],
  "weights": { "hunyuan3d": 0.6, "trellis": 0.4 },
  "unirig": true,
  "skip_rigging": false
}
```

Reports which mesh backends are wired, their normalized routing weights, and
whether rigging is active. It reflects configuration only — it does not probe the
downstream services for liveness.

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret checked on every request and sent to every backend (Secret Manager: `avatar-reconstruction-key`). |
| `GCS_BUCKET` | yes | — | Output bucket for final GLBs (`three-ws-avatar-reconstructions`). |
| `FIRESTORE_PROJECT` | yes | — | Project holding the `avatar_pipeline_jobs` collection. |
| `MODEL_HUNYUAN3D_URL` | one+ | — | Cloud Run URL of the Hunyuan3D mesh worker. |
| `MODEL_TRELLIS_URL` | one+ | — | Cloud Run URL of the TRELLIS mesh worker. |
| `MODEL_TRIPOSR_URL` | one+ | — | Cloud Run URL of the TripoSR mesh worker. |
| `MODEL_TRIPOSG_URL` | one+ | — | Cloud Run URL of the TripoSG mesh worker. |
| `UNIRIG_URL` | no | — | Cloud Run URL of the [unirig](../unirig/) worker. Unset (or `SKIP_RIGGING=true`) returns the unrigged mesh. |
| `MODEL_WEIGHTS` | no | equal | JSON routing weights, e.g. `{"hunyuan3d":0.6,"trellis":0.4}`; normalized to the configured backends. |
| `SKIP_RIGGING` | no | `false` | `true` skips the UniRig stage (testing). |

At least one `MODEL_*_URL` must be set — with zero backends, `/reconstruct`
returns `503 no model backends configured`.

The backend wires to this service through two env vars on the `three-ws-api`
Cloud Run service: `GCP_RECONSTRUCTION_URL` (this controller's URL) and
`GCP_RECONSTRUCTION_KEY` (the same shared secret as `API_KEY`).

## Run

### Local

```bash
cd workers/avatar-pipeline-controller
pip install -r requirements.txt

API_KEY=dev-secret \
GCS_BUCKET=three-ws-avatar-reconstructions \
FIRESTORE_PROJECT=your-gcp-project \
MODEL_TRELLIS_URL=https://model-trellis-…run.app \
UNIRIG_URL=https://unirig-…run.app \
uvicorn main:app --host 0.0.0.0 --port 8080
```

Firestore and Cloud Storage need Application Default Credentials
(`gcloud auth application-default login`). The downstream model services must be
reachable, or `/reconstruct` jobs will fail.

### Production

Ships as the **`avatar-pipeline-controller`** Cloud Run service in
**`us-central1`**, CPU-only (2 vCPU / 2 GiB, `--min-instances 1`,
`--max-instances 4`, 600 s timeout, no GPU — orchestration only). Built and
deployed by Cloud Build from `cloudbuild.yaml`:

```bash
gcloud builds submit --config workers/avatar-pipeline-controller/cloudbuild.yaml \
  workers/avatar-pipeline-controller
```

That build sets `GCS_BUCKET`, `FIRESTORE_PROJECT`, and `SKIP_RIGGING=false` and
mounts `API_KEY` from the `avatar-reconstruction-key` secret, but does **not**
know the backend URLs (they don't exist until the GPU services deploy). The full
pipeline provisioner wires those in afterward and prints the controller URL:

```bash
PROJECT_ID=<gcp-project> SERVICES="hunyuan3d trellis triposr unirig" \
  workers/deploy/deploy-all.sh
```

## Example

Submit a job and poll it:

```bash
CTRL=https://avatar-pipeline-controller-…run.app
KEY=$GCP_RECONSTRUCTION_KEY

JOB=$(curl -sS -X POST "$CTRL/reconstruct" \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"images":["https://storage.googleapis.com/three-ws-avatar-reconstructions/samples/selfie.jpg"],"body_type":"neutral"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')

curl -sS "$CTRL/jobs/$JOB" -H "authorization: Bearer $KEY"
# → {"status":"running","stage":"mesh_generation", …}   then   {"status":"done","glb_url":"…"}
```

Liveness check (any status `< 500` means routable):

```bash
curl -sS "$CTRL/health"
```

## Related

- Full pipeline runbook: [`workers/deploy/README.md`](../deploy/README.md).
- GPU mesh/rig lanes + shared secret:
  [`docs/ops/gcp-model-workers.md`](../../docs/ops/gcp-model-workers.md).
- Cloud Run production runbook:
  [`docs/ops/gcp-production.md`](../../docs/ops/gcp-production.md).
