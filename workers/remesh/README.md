# remesh — mesh processing (remesh · simplify · repair · convert)

Cleans up and re-topologizes a 3D file, or converts it between formats. Given a
mesh URL it can decimate the triangle count, generate quad-dominant topology,
bake a silhouette-preserving low-poly, repair holes and bad normals, or just
transcode between GLB / OBJ / FBX / STL / PLY / USDZ / 3MF. It backs three.ws's
post-generation tools — Game-Ready export and the remesh stage of the paid 3D
asset pipeline — not the primary generation lanes.

Wraps `trimesh` + `open3d` for geometry, [QuadriFlow](https://github.com/hjwdzh/QuadriFlow)
(MIT) for quad remeshing, [xatlas](https://github.com/jpcy/xatlas) (MIT) for UV
re-unwrap, and headless [Blender](https://www.blender.org/) (`bpy`) for FBX
export. **No GPU required** — everything runs on CPU.

A FastAPI service on Cloud Run. Jobs are accepted immediately (`202`) and polled
— a quad remesh with texture re-bake runs far longer than a request should be
held open.

## Why Blender for FBX

FBX is the only format here that needs Blender: `trimesh` has no FBX writer, so
every other format is written directly and FBX is bridged through a temporary
GLB handed to a one-shot headless Blender subprocess (`blender_fbx.py`). A plain
`convert` of a **rigged** GLB to FBX keeps its bone hierarchy, skin weights, and
blendshapes — that route (`remesh_mode: "triangle"`, `operation: "convert"`,
`output_format: "fbx"`) skips the geometry pipelines entirely so the skeleton
survives. Any geometry-changing op discards the rig and yields a static FBX.

## Modes

| `remesh_mode` | What it does |
|---|---|
| `triangle` (default) | Repair + quadric-error triangle decimation (open3d, trimesh fallback). Geometry only — drops materials. Honors `operation`. |
| `quad` | Field-aligned quad-dominant topology via QuadriFlow, then xatlas UV re-unwrap + source-texture re-bake. Reports a real `quad_ratio`. |
| `lowpoly` | Silhouette-preserving QEM decimation + UV re-unwrap + texture re-bake. |

`operation` (`convert` · `simplify` · `repair` · `full`) applies to `triangle`
mode; `full` (default) runs repair then decimate.

## API

All routes require `Authorization: Bearer $API_KEY`, except `/health`.

### `POST /process` → `202`

```bash
curl -X POST https://$SERVICE_URL/process \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
        "mesh": "https://example.com/model.glb",
        "remesh_mode": "quad",
        "target_faces": 20000,
        "texture_size": 1024,
        "output_format": "glb"
      }'
# → { "task_id": "…", "status": "queued", "mode": "quad" }
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `mesh` | yes | — | `https://` URL to a GLB / GLTF / OBJ / STL / PLY / FBX / OFF / DAE (≤ 128 MB) |
| `remesh_mode` | no | `triangle` | `triangle` \| `quad` \| `lowpoly` |
| `operation` | no | `full` | `convert` \| `simplify` \| `repair` \| `full` (triangle mode) |
| `target_faces` | no | `50000` | `1000`–`500000` |
| `texture_size` | no | `1024` | `512` \| `1024` \| `2048` — atlas size for the re-bake |
| `output_format` | no | `glb` | `glb` \| `obj` \| `stl` \| `ply` \| `usdz` \| `3mf` \| `fbx` |

Remote URLs are fetched through the SSRF guard in
[`worker_security.py`](./worker_security.py) — https-only, with private,
loopback, link-local, and cloud-metadata addresses rejected.

### `GET /tasks/{task_id}`

```json
{
  "task_id": "…",
  "status": "done",
  "result_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/remesh/….glb",
  "texture_url": "https://storage.googleapis.com/…/remesh/….png",
  "mtl_url": null,
  "face_count": 19842,
  "quad_ratio": 0.94,
  "textured": true,
  "mode": "quad",
  "output_format": "glb",
  "bytes": 1830112,
  "elapsed_ms": 41230
}
```

`status` is `queued` | `running` | `done` | `failed`. On failure the response
carries a sanitized `error` string; the full traceback stays in the server log.
`texture_url` / `mtl_url` are populated when a re-bake produces a sidecar PNG or
`.mtl` (e.g. a textured `obj` output).

### `GET /health`

```json
{ "ok": true, "service": "remesh" }
```

Unauthenticated, so Cloud Run's startup probe can reach it.

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager: `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Output bucket; artifacts land under the `remesh/` prefix (`three-ws-avatar-reconstructions`) |
| `MAX_CONCURRENT` | no | `2` | In-flight jobs |
| `QUADRIFLOW_BIN` | no | `quadriflow` | Path to the QuadriFlow executable (built into the image) |
| `BLENDER_TIMEOUT` | no | `300` | Seconds before a Blender FBX export is killed |

## How it ships

Built and deployed by **Google Cloud Build** from
[`cloudbuild.yaml`](./cloudbuild.yaml) to **Cloud Run** — service `remesh-service`
in `us-central1` (project `aerial-vehicle-466722-p5`), 8 vCPU / 16 GiB, port
8080, scale-to-zero (`min 0`, `max 3`), 300 s request timeout, run as the
`avatar-reconstruction-sa` service account. `API_KEY` is mounted from the
`avatar-reconstruction-key` secret; `GCS_BUCKET` is set to
`three-ws-avatar-reconstructions`. There is no local run target — build the image
from [`Dockerfile`](./Dockerfile) (it compiles QuadriFlow from source and
installs the Blender `bpy` wheel) and run the container, or submit the build:

```bash
gcloud builds submit --config workers/remesh/cloudbuild.yaml workers/remesh
```

This is not a GitHub Actions job — three.ws has no Actions; all CI/CD runs on
Cloud Build. See [`docs/ops/gcp-model-workers.md`](../../docs/ops/gcp-model-workers.md)
for how the model/post-gen workers are operated and
[`docs/ops/gcp-production.md`](../../docs/ops/gcp-production.md) for the platform
production runbook.

## How three.ws calls it

The platform never talks to this service directly from the browser. The GCP
provider (`api/_providers/gcp.js`, `remesh` mode) reads its URL from
**`GCP_REMESH_URL`** and the shared key from **`GCP_RECONSTRUCTION_KEY`**, maps
the tool request onto `POST /process` (`resultKey: result_url`), and polls
`GET /tasks/:id` until `done`, surfacing `face_count`, `quad_ratio`, and
`textured` back to the caller. It backs the free `/api/forge-remesh` tool and the
paid `POST /api/x402/pipeline-remesh` stage (`api/x402/pipeline-remesh.js`); a
lane missing either env var drops out cleanly and is reported
`configured: false`.
