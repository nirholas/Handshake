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
default when the mesh carries no color of its own. (That fallback is gated on
trimesh's `visual.defined`, because trimesh otherwise hands back a stock flat
gray for an uncolored mesh, which reads as a real color and is not one.) A mesh
with no size at all is refused rather than stylized into invisible geometry.
Hard safety caps (`MAX_VOXELS = 60_000`,
`MAX_LATTICE_EDGES = 6_000`, `MAX_MESH_BYTES = 128 MiB`) mean a hostile or huge
input can never exhaust memory — resolution backs off automatically.

Input formats: `.glb`, `.gltf`, `.obj`, `.stl`, `.ply`, `.fbx`, `.off`, `.dae`
(FBX/DAE via `pyassimp`). Output formats: `glb` (default), `obj`, `stl`, `ply`.

A glTF asset that declares `EXT_meshopt_compression` (what `gltfpack` emits, and
what most three.ws avatars ship as) is transcoded to plain glTF with
[`gltfpack`](https://github.com/zeux/meshoptimizer) before loading: trimesh has
no decoder for that extension and fails on the compressed asset's fallback
buffer, so every filter used to fail on those meshes. The binary is pinned by
release tag and checksum in the [`Dockerfile`](Dockerfile); point `GLTFPACK_BIN`
at your own copy to run that path locally.

## HTTP contract

Bearer-authenticated on `/process` and `/tasks/:id`; `/styles` and `/health`
are public. A missing, malformed, or wrong `Authorization: Bearer <key>` header
is a `401`. Jobs are async: `POST /process` returns immediately with a
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
its public GCS URL; that upload retries transient transport failures, so a TLS
blip no longer discards work the worker already did.

Task records are instance-local and bounded: the most recent
`MAX_TRACKED_TASKS = 500` are kept, oldest finished ones evicted first, and a
queued or running job is never evicted. Poll promptly and keep the `result_url`,
which is durable; the record behind it is not (a restart clears it either way,
and `api/_providers/gcp.js` already maps that `404` to a terminal
`gcp_task_missing`).

### `GET /styles` → `200`

The filter catalog (key, name, description, resolution bounds) — drives the UI
gallery. Public, no auth.

### `GET /health` → `200`

```json
{ "ok": true, "service": "stylize", "styles": ["voxel", "brick", "voronoi", "lowpoly"] }
```

### OIN routes (only with `OIN_ENABLED=true`)

The same filters are also offered over the Open Inference Protocol
([`specs/OPEN_INFERENCE_PROTOCOL.md`](../../specs/OPEN_INFERENCE_PROTOCOL.md)),
so an outside node operator can run this worker and return signed receipts:
`GET /.well-known/oin` (signed advertisement of the `mesh.stylize` capability),
`POST /oin/jobs`, `GET /oin/jobs/:id`. The job envelope carries the mesh URL as
`input.data` and the style as `input.model`, with `params.resolution` and
`params.output_format` as the knobs; the response commits to the artifact's
`sha256` and byte length, signed with `OIN_SIGNING_KEY`. Jobs use the same
bearer secret as `/process`. With the flag unset none of these routes exist.

## Environment

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `API_KEY` | yes | — | Bearer secret for `/process` + `/tasks`. In production it is the shared model-worker key (Secret Manager `avatar-reconstruction-key`, mounted by `cloudbuild.yaml`). |
| `GCS_BUCKET` | yes | — | Output bucket for stylized meshes (prod: `three-ws-avatar-reconstructions`). |
| `MAX_CONCURRENT` | no | `2` | In-process semaphore bounding concurrent jobs. |
| `GLTFPACK_BIN` | no | `gltfpack` | Path to the meshopt decoder. The image ships it on `PATH`. |
| `OIN_ENABLED` | no | unset | `true` mounts the OIN routes (see below). Anything else leaves the worker byte-for-byte its pre-OIN self. |
| `OIN_SIGNING_KEY` | with OIN | (none) | base64 Ed25519 seed. With `OIN_ENABLED=true` and no key the worker refuses to boot, so a node can never advertise a key it cannot sign with. |
| `OIN_NODE_ID` | no | `three-ws-stylize` | Node identity in the advertisement. |
| `OIN_RESULT_DIR` | no | unset | Write OIN artifacts to this directory instead of GCS. Set it and the worker skips the GCS client entirely, so a local run needs no cloud credentials. |
| `OIN_RESULT_BASE_URL` | with `OIN_RESULT_DIR` | (none) | Public base URL the directory is served from; the signed `output.url` is built from it. |

## How it ships

Deployed as the Cloud Run service **`stylize-service`** in **`us-central1`**
(live base URL `https://stylize-service-lp642k3kpa-uc.a.run.app`), built by Cloud
Build from [`cloudbuild.yaml`](cloudbuild.yaml) (CPU-only: `--cpu=8
--memory=16Gi`, `--min-instances=1 --max-instances=3`, 300 s timeout,
`--no-cpu-throttling`, run SA `avatar-reconstruction-sa`, build SA
`three-ws-build@` as every build in this project must pin). It is kept warm
rather than scaled to zero: a job itself finishes in under ten seconds, so a cold
start on top of it would be the dominant stall in an interactive edit. CPU
throttling stays off because the work happens in a background task after the
`202`, where a throttled container would crawl while still holding one of the
two concurrency slots.

Submit from the **repo root** and pass `SHORT_SHA` explicitly, since the config
tags images with it and `gcloud builds submit` does not populate it:

```bash
gcloud builds submit --config workers/stylize/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s) .
```

The build runs [`test_stylize.py`](test_stylize.py) as a gate, so a regression in
any filter stops the image instead of reaching a user mid-edit.

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
so FBX/DAE input and headless mesh IO work, plus the pinned `gltfpack` binary
for meshopt input.

To run it as a self-hosted OIN node with no cloud account at all, keep results
on disk and skip GCS entirely:

```bash
API_KEY=dev-secret GCS_BUCKET=unused \
OIN_ENABLED=true OIN_SIGNING_KEY="$(python3 -c 'import base64,os;print(base64.b64encode(os.urandom(32)).decode())')" \
OIN_RESULT_DIR=/tmp/oin-artifacts OIN_RESULT_BASE_URL=http://localhost:8080/artifacts \
  uvicorn main:app --host 0.0.0.0 --port 8080
```

## Tests

```bash
python3 workers/stylize/test_stylize.py
```

[`test_stylize.py`](test_stylize.py) covers the core path with no GCS, no
network, and no server: the catalog and its resolution bounds, request
validation, scene loading, color preservation and the untextured fallback, all
four filters (geometry, tint, and the shape property each one promises), the
zero-extent refusal, the `MAX_VOXELS` / `MAX_LATTICE_EDGES` backoff, an export
round-trip in every output format, the SSRF gate, the `401` contract, the upload
retry policy, the meshopt decode, the OIN protocol primitives, and the OIN job
executor end to end against a real result sink. It needs `trimesh`, `numpy`,
`scipy`, `pillow`, `fastapi` (its `TestClient`, so `httpx` too), `pydantic`, and
`google-cloud-storage`. Two dependencies are optional locally and present in the
image, so the Docker build gate is what exercises their paths: `open3d`
(`_decimate` falls back to trimesh without it) and `gltfpack` (without it the
suite pins the readable failure instead of round-tripping a compressed asset).

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
| [`main.py`](main.py) | FastAPI app: filters, color sampler, mesh loading, task queue, GCS upload, routes, OIN executor. |
| [`test_stylize.py`](test_stylize.py) | Core-path unit suite; also a Docker build gate. |
| [`worker_security.py`](worker_security.py) | Shared bearer-auth, SSRF-safe fetch, error sanitizer. |
| [`oin.py`](oin.py) | OIN protocol layer: canonicalization, job digests, Ed25519 signing, the `/oin/*` routes. Vendored copy, kept byte-identical across workers. |
| [`oin_upload.py`](oin_upload.py) | OIN result sinks: GCS in production, a local directory for self-hosted runs. |
| [`requirements.txt`](requirements.txt) | Pinned deps (`trimesh`, `open3d`, `scipy`, `pyassimp`, `pynacl`, …). |
| [`Dockerfile`](Dockerfile) | `python:3.11-slim` + assimp/GL system libs + pinned `gltfpack`; uvicorn on `:8080`. |
| [`cloudbuild.yaml`](cloudbuild.yaml) | Cloud Build → Artifact Registry → Cloud Run deploy. |
