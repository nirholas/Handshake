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
FBX is bridged through a temporary GLB handed to a one-shot headless Blender
subprocess (`blender_fbx.py`). USDZ has no trimesh writer either, but it needs no
Blender: it is authored directly on a USD stage with `pxr` (`_write_usdz` in
[`main.py`](./main.py)). Every other format trimesh writes itself.

That Blender subprocess exits without running interpreter finalization, and the
worker judges it by the `FACE_COUNT:` marker it prints rather than by its exit
status. Tearing `bpy` down after a scene has been loaded segfaults in this
container: the FBX is written in full, then the process dies during Blender's own
shutdown. Reading that as a failed export is what made every `output_format:
"fbx"` request fail until 2026-08-11.

A plain `convert` of a **rigged** GLB to FBX keeps its bone hierarchy, skin
weights, and blendshapes. That route (`remesh_mode: "triangle"`,
`operation: "convert"`, `output_format: "fbx"`) skips the geometry pipelines
entirely so the skeleton survives. Any geometry-changing op discards the rig and
yields a static FBX.

## Modes

| `remesh_mode` | What it does |
|---|---|
| `triangle` (default) | Repair + quadric-error triangle decimation (open3d, trimesh fallback). Geometry only — drops materials. Honors `operation`. |
| `quad` | Field-aligned quad-dominant topology via QuadriFlow, then xatlas UV re-unwrap + source-texture re-bake. Reports a real `quad_ratio`. An open or non-manifold input is cleaned and rebuilt watertight first (see below); QuadriFlow refuses anything else. |
| `lowpoly` | Silhouette-preserving QEM decimation + UV re-unwrap + texture re-bake. |

`operation` (`convert` · `simplify` · `repair` · `full`) applies to `triangle`
mode; `full` (default) runs repair then decimate.

### What quad mode does to your mesh before QuadriFlow

QuadriFlow needs a watertight manifold, and no real character export is one:
they are assembled from overlapping parts, so seams share edges between more
than two faces, and they are open at the wrists, neck, and hems. Fed such a mesh
QuadriFlow aborts in its index-map solve with `wrong init`, whichever flow solver
it is given. Quad mode therefore runs three preparation steps, each of which
falls through rather than failing the job:

1. `_repair_mesh` fills holes, drops degenerate faces, and merges vertices.
2. `_make_manifold` removes duplicate and non-manifold geometry via open3d.
3. `_watertight_obj` rebuilds an open mesh with
   [Manifold](https://github.com/hjwdzh/Manifold) (MIT, same author as
   QuadriFlow, which is what its README prescribes). A mesh that is already
   watertight skips this, since the rebuild is an approximation.

QuadriFlow then walks a solver ladder (`-mcf -sharp`, `-sharp`, bare) under one
shared wall-clock budget. Falling back to triangle soup is never one of the
rungs: a quad request that cannot be met is reported as failed, with the solver
output in the message.

## API

All routes require `Authorization: Bearer $API_KEY`, except `/health`.

### `POST /process` → `202`

```bash
curl -X POST https://$SERVICE_URL/process \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
        "mesh": "https://three.ws/avatars/cesium-man.glb",
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

A glTF asset that declares `EXT_meshopt_compression` (what `gltfpack` emits, and
what most three.ws avatars ship as) is transcoded to plain glTF by
[`gltf_meshopt.py`](./gltf_meshopt.py) before loading. trimesh has no decoder for
that extension and fails on the compressed asset's fallback buffer, so those
meshes used to fail outright. The `gltfpack` binary is pinned by release tag and
checksum in the [`Dockerfile`](./Dockerfile); set `GLTFPACK_BIN` to run that path
against your own copy locally.

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
| `QUADRIFLOW_BIN` | no | `quadriflow` | Path to the QuadriFlow executable. The image builds it and sets this to `/usr/local/bin/quadriflow` |
| `BLENDER_TIMEOUT` | no | `300` | Seconds before a Blender FBX export is killed |
| `MANIFOLD_BIN` | no | `manifold` | Path to the [Manifold](https://github.com/hjwdzh/Manifold) executable (built into the image). Quad mode rebuilds an open mesh watertight with it before QuadriFlow, which requires watertight manifold input |
| `MANIFOLD_RESOLUTION` | no | `50000` | Octree resolution for that rebuild |
| `MANIFOLD_TIMEOUT` | no | `120` | Seconds before the rebuild is abandoned and the raw mesh is used |

## Build and test locally

The image builds from [`Dockerfile`](./Dockerfile) with no arguments or build
args. It compiles QuadriFlow from source and installs the ~1 GB Blender `bpy`
wheel, so a cold build takes several minutes:

```bash
docker build -t remesh workers/remesh
```

[`test_remesh.py`](./test_remesh.py) is the core-path smoke test: the OBJ bridge
to QuadriFlow, repair, QEM decimation, every `operation`, xatlas UV unwrap,
texture bake and seam dilation, every export format, request validation, a real
QuadriFlow quad remesh, and a rigged GLB to FBX round trip re-checked with
[`verify_fbx.py`](./verify_fbx.py). The Docker build runs it as a gate, so a
regression fails the image instead of reaching Cloud Run. Run it on its own
against the built image:

```bash
docker run --rm remesh python test_remesh.py
```

Serving the container locally additionally needs credentials that can write
`GCS_BUCKET`: results are uploaded straight to GCS, and `storage.Client()` is
constructed at startup, so a container without application-default credentials
fails its startup probe rather than failing per job.

## How it ships

Built and deployed by **Google Cloud Build** from
[`cloudbuild.yaml`](./cloudbuild.yaml) to **Cloud Run**: service
`remesh-service` in `us-central1` (project `aerial-vehicle-466722-p5`), 8 vCPU /
16 GiB, port 8080, kept warm (`min 1`, `max 3`), 300 s request timeout, always-on
CPU (`--no-cpu-throttling`), run as the `avatar-reconstruction-sa` service
account. `API_KEY` is mounted from the `avatar-reconstruction-key` secret;
`GCS_BUCKET` is set to `three-ws-avatar-reconstructions`.

Always-on CPU is load-bearing rather than a tuning knob. `POST /process` answers
`202` and finishes the job in a background task, so every expensive step runs
outside a request; under Cloud Run's default throttling the container is given
almost no CPU there. On 2026-08-09 a 2000-face lowpoly bake that measures around
160 s under active polling took 51,173 s (14 h) once its caller stopped polling,
and on 2026-08-06 a quad job tripped the 600 s QuadriFlow guard for the same
reason.

Submit the build from the repo root. The config's build step sets
`dir: workers/remesh`, which is resolved against the submitted source, so
submitting this directory instead of `.` fails to find the Dockerfile:

```bash
gcloud builds submit --config workers/remesh/cloudbuild.yaml .
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
