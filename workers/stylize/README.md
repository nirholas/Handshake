# Stylize worker

One-click **geometric stylization filters** for 3D meshes. Takes any input mesh
and rebuilds it as a stylized variant using pure geometry processing —
`trimesh` + `numpy` + `scipy` + `open3d`, **no model inference and no GPU**.
That makes it fast and cheap on CPU, and it never depends on a model lane being
warm.

It backs the forge pipeline's post-generation stylize tool: exposed to the web
at [`/api/forge-stylize`](../../api/forge-stylize.js) and to agents over MCP as
`stylize_model`. It is not a primary text/image→3D generation lane — it
transforms a mesh you already have.

## Filters

The catalog is the single source of truth (`STYLE_CATALOG` in
[`main.py`](main.py)); `GET /styles` serves it verbatim so the UI gallery and
the density knob stay in lockstep. Each filter has one density knob with a
default and clamped `min`/`max`:

| Key       | Name          | What it does | Resolution (`default` / `min`–`max`) |
|-----------|---------------|--------------|--------------------------------------|
| `voxel`   | Voxel         | Voxelize the surface and rebuild it as solid, source-colored cubes (Minecraft-style). | 32 / 8–96 |
| `brick`   | Brick         | Voxel grid plus a cylindrical stud on each column's top block — a buildable toy-brick look. | 24 / 8–64 |
| `voronoi` | Voronoi shell | Decimate to a coarse shell, thicken its edges into an open strut-and-node lattice (3D-print ready). | 48 / 12–120 |
| `lowpoly` | Low-poly      | Quadric-decimate, then unweld every face for hard flat shading — the classic faceted game-asset look. | 40 / 8–120 |

Source color/material is preserved where the style allows: each output element
is tinted by sampling the nearest source-face color (vertex colors, texture via
`to_color`, or a material base color), falling back to a tasteful cool-neutral
default when the mesh is untextured. Hard safety caps (`MAX_VOXELS = 60_000`,
`MAX_LATTICE_EDGES = 6_000`, `MAX_MESH_BYTES = 128 MiB`) mean a hostile or huge
input can never exhaust memory — resolution backs off automatically.

Input formats: `.glb`, `.gltf`, `.obj`, `.stl`, `.ply`, `.fbx`, `.off`, `.dae`
(FBX/DAE via `pyassimp`). Output formats: `glb` (default), `obj`, `stl`, `ply`.

## HTTP contract

Bearer-authenticated on `/process` and `/tasks/:id`; `/styles` and `/health`
are public. Jobs are async — `POST /process` returns immediately with a
`task_id`, then you poll `GET /tasks/:id`.

### `POST /process` → `202`

```json
{
  "mesh": "https://…/model.glb",
  "style": "voxel",
  "resolution": 32,
  "output_format": "glb"
}
```

`mesh` is required and must be a public https URL (the worker's
`worker_security.fetch_remote_bytes` rejects private/loopback/metadata hosts —
SSRF defense; `/api/forge-stylize` also pre-validates it). `style` defaults to
`voxel`, `resolution` is clamped to the style's bounds (a missing/`null` value
uses the default), `output_format` defaults to `glb`.

Response:

```json
{ "task_id": "…uuid…", "status": "queued", "style": "voxel", "resolution": 32 }
```

### `GET /tasks/:id` → `200`

```json
{
  "task_id": "…uuid…",
  "status": "done",
  "result_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/stylize/<id>.glb",
  "face_count": 14400,
  "style": "voxel",
  "resolution": 32,
  "output_format": "glb",
  "bytes": 512340,
  "elapsed_ms": 1830
}
```

`status` is `queued` → `running` → `done` | `failed`. On failure the body
carries a sanitized `error`. Unknown ids return `404`. The finished mesh is
uploaded to the `GCS_BUCKET` under `stylize/<task_id>.<format>` and served from
its public GCS URL.

### `GET /styles` → `200`

The filter catalog (key, name, description, resolution bounds) — drives the UI
gallery. Public, no auth.

### `GET /health` → `200`

```json
{ "ok": true, "service": "stylize", "styles": ["voxel", "brick", "voronoi", "lowpoly"] }
```

## Environment

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `API_KEY` | yes | — | Bearer secret for `/process` + `/tasks`. In production it is the shared model-worker key (Secret Manager `avatar-reconstruction-key`, mounted by `cloudbuild.yaml`). |
| `GCS_BUCKET` | yes | — | Output bucket for stylized meshes (prod: `three-ws-avatar-reconstructions`). |
| `MAX_CONCURRENT` | no | `2` | In-process semaphore bounding concurrent jobs. |

## How it ships

Deployed as the Cloud Run service **`stylize-service`** in **`us-central1`**,
built by Cloud Build from [`cloudbuild.yaml`](cloudbuild.yaml) (CPU-only:
`--cpu=8 --memory=16Gi`, `--min-instances=0 --max-instances=3`, 300 s timeout,
run SA `avatar-reconstruction-sa`). Scale-to-zero means the first request after
idle pays a container cold start.

```bash
gcloud builds submit --config workers/stylize/cloudbuild.yaml .
```

three.ws reaches it through [`api/_providers/gcp.js`](../../api/_providers/gcp.js)
(`stylize` mode) when **`GCP_STYLIZE_URL`** points at the service URL and the
shared **`GCP_RECONSTRUCTION_KEY`** is set. If either is missing the lane drops
out of routing and `/api/forge-stylize` returns `503 unconfigured` — nothing is
faked. See [`docs/ops/gcp-model-workers.md`](../../docs/ops/gcp-model-workers.md)
for the model-worker fleet, its shared bearer secret, and routing.

> Ops context: three.ws's own front end and API run on Cloud Run service
> `three-ws-api` (also `us-central1`); the model workers like this one are
> separate Cloud Run services built by Cloud Build. There are no GitHub Actions
> — builds and deploys run through Cloud Build. See
> [`docs/ops/gcp-production.md`](../../docs/ops/gcp-production.md).

### Run locally

```bash
cd workers/stylize
pip install -r requirements.txt
API_KEY=dev-secret GCS_BUCKET=your-dev-bucket \
  uvicorn main:app --host 0.0.0.0 --port 8080
```

(Uploads need Application Default Credentials with write access to
`GCS_BUCKET`.) The container image installs `libassimp` + `libgl` system libs
so FBX/DAE input and headless mesh IO work.

## Usage example

Stylize a GLB into voxels, then poll for the result:

```bash
BASE="https://stylize-service-XXXXXXXX-uc.a.run.app"   # or http://localhost:8080
KEY="$GCP_RECONSTRUCTION_KEY"

# 1. submit
TASK=$(curl -s -X POST "$BASE/process" \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"mesh":"https://storage.googleapis.com/three-ws-avatar-reconstructions/example.glb","style":"voxel","resolution":32,"output_format":"glb"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["task_id"])')

# 2. poll until done
curl -s "$BASE/tasks/$TASK" -H "authorization: Bearer $KEY"
```

Or, through the platform (no worker URL/secret needed by the caller):

```bash
curl -s -X POST https://three.ws/api/forge-stylize \
  -H 'content-type: application/json' \
  -d '{"mesh_url":"https://…/model.glb","style":"lowpoly","resolution":40}'
# → 202 { "job_id", "status":"queued", "style", "resolution", "output_format" }
# poll: GET https://three.ws/api/forge-stylize?job=<job_id>
```

## Files

| File | Role |
|------|------|
| [`main.py`](main.py) | FastAPI app: filters, color sampler, task queue, GCS upload, routes. |
| [`worker_security.py`](worker_security.py) | Shared bearer-auth, SSRF-safe fetch, error sanitizer. |
| [`requirements.txt`](requirements.txt) | Pinned deps (`trimesh`, `open3d`, `scipy`, `pyassimp`, …). |
| [`Dockerfile`](Dockerfile) | `python:3.11-slim` + assimp/GL system libs; uvicorn on `:8080`. |
| [`cloudbuild.yaml`](cloudbuild.yaml) | Cloud Build → Artifact Registry → Cloud Run deploy. |
