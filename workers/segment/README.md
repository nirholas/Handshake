# segment

Part-segmentation service — split a 3D model into addressable, named parts. A
CPU-only FastAPI worker (no GPU, like the remesh lane) that takes one mesh URL
and returns a GLB whose nodes are the parts, plus a JSON parts manifest.

It backs a **post-generation tool**, not a primary generation lane: once the
forge pipeline has produced a model, Parts Studio splits it so each part can be
hidden, recoloured, replaced, or exported on its own.

## What it does

Segmentation is pure geometry — deterministic, GPU-free, and topology-agnostic
(see `segment_core.py` for the rationale on why this beats a learned part-net or
convex decomposition here):

1. **Connected components first.** Anything physically disjoint — wheels, eyes,
   a weapon, loose accessories — separates immediately and perfectly.
2. **The minima rule inside each component.** Human perception segments objects
   at concave creases (Hoffman & Richards, 1984). The worker cuts the
   face-adjacency graph along strong concave edges and takes the connected
   components of what remains — finding the natural seam between a limb and a
   torso, a handle and a body, a wheel-arch and a fender.
3. **Cleanup.** Tiny shards merge back into their largest neighbour; the part
   count is capped by repeatedly folding the smallest part into its largest
   neighbour, so the output is a handful of meaningful parts, not a thousand
   crease fragments.

Each part is named by its spatial region (`top`, `lower-left`, `core`, …),
tinted a distinct golden-ratio-stepped hue so segmentation is visible even on an
untextured mesh, and emitted as a separate named GLB node (`part_01`, `part_02`,
…). `only_part` exports a single part on its own.

Supported input formats: `.glb`, `.gltf`, `.obj`, `.stl`, `.ply`, `.fbx`,
`.off`, `.dae`. Input is capped at 128 MiB and fetched through the SSRF-hardened
`worker_security.fetch_remote_bytes` (https-only, private/loopback/metadata IPs
rejected, redirects re-validated per hop).

## Files

| File | Role |
|------|------|
| `main.py` | FastAPI app: request validation, async job queue (`MAX_CONCURRENT` semaphore), GCS upload of the GLB + manifest, task-status store. |
| `segment_core.py` | The geometry engine: `load_concatenated`, `segment`, `build_scene`, `manifest`. Trimesh + numpy + scipy. |
| `worker_security.py` | Shared bearer-auth + SSRF-hardened fetch + opaque error helper. Byte-identical copy across all workers — keep it in sync when editing. |
| `Dockerfile` | `python:3.11-slim` + native libs (`libgl1`, `libassimp5`, `libopenblas`); serves via `uvicorn` on port 8080. |
| `cloudbuild.yaml` | Cloud Build → Artifact Registry → Cloud Run deploy. |

## How it ships

Built and deployed by **Cloud Build** to **Google Cloud Run**:

- Service: **`segment-service`**, region **`us-central1`**
- Runs on CPU only — `--cpu=8 --memory=16Gi`, no GPU — scale-to-zero
  (`min-instances=0`, `max-instances=3`), 300 s request timeout.
- Service account `avatar-reconstruction-sa`; `API_KEY` is mounted from the
  `avatar-reconstruction-key` Secret Manager secret — the **same shared bearer
  secret** every model worker checks (`GCP_RECONSTRUCTION_KEY` on the platform
  side).

```bash
# from repo root, deploy the current tree
gcloud builds submit --config workers/segment/cloudbuild.yaml .
```

The platform wires it in through `api/_providers/gcp.js` (`segment` mode): set
**`GCP_SEGMENT_URL`** to this service's Cloud Run URL and **`GCP_RECONSTRUCTION_KEY`**
to the shared bearer secret. Read the URL after deploy with:

```bash
gcloud run services describe segment-service --region us-central1 \
  --format='value(status.url)'
```

When `GCP_SEGMENT_URL` is unset the lane degrades cleanly — `/api/forge-segment`
returns `503 unconfigured` rather than faking a result.

## Reached from

- **Web:** `/api/forge-segment` (`api/forge-segment.js`) → the `/segment` Parts
  Studio viewer (`pages/segment.html`, `src/segment.js`). The API handler
  re-validates the mesh URL against SSRF on its own side before handing it off.
- **Agents:** the x402-priced `segment_model` MCP tool.

Both route through `api/_providers/gcp.js`, which maps the platform job envelope
onto this worker's native `POST /segment` + `GET /tasks/:id` contract.

## HTTP API

All routes except `/health` require `Authorization: Bearer <API_KEY>`.

### `POST /segment` → `202`

```json
{
  "mesh": "https://…/model.glb",          // required, https URL
  "method": "auto",                        // auto | connected | crease (default auto)
  "max_parts": 24,                         // 2–64   (default 24)
  "min_part_faces": 64,                    // 4–100000 (default 64)
  "crease_angle": 40.0,                    // 5–170 degrees (default 40)
  "only_part": "part_03"                   // optional: export just this part id/name
}
```

`method`:
- `connected` — split only at physically disconnected shells.
- `crease` — minima-rule crease segmentation over the whole mesh.
- `auto` (default) — connected components, then crease-split any component large
  enough to plausibly hold multiple parts.

Response: `{ "task_id": "<uuid>", "status": "queued" }`.

### `GET /tasks/:id` → `200`

```json
{
  "task_id": "…",
  "status": "queued | running | done | failed",
  "result_url": "https://storage.googleapis.com/<bucket>/segment/<id>.glb",
  "manifest_url": "https://storage.googleapis.com/<bucket>/segment/<id>.parts.json",
  "parts": [
    {
      "id": "part_01",
      "name": "top",
      "region": "top",
      "face_count": 812,
      "vertex_count": 431,
      "bbox": { "min": [x,y,z], "max": [x,y,z] },
      "centroid": [x,y,z],
      "volume": 0.031,
      "color": "#e8a13f"
    }
  ],
  "part_count": 6,
  "source_faces": 24188,
  "method": "auto",
  "warnings": ["capped to 24 parts; 3 smaller fragments were combined"],
  "bytes": 184320,
  "elapsed_ms": 2140,
  "error": null
}
```

`result_url`/`manifest_url` and the enriched fields appear once `status` is
`done`. On failure, `error` carries an opaque, correlation-id-tagged message
(the full traceback is logged server-side only, never returned).

### `GET /health` → `200`

`{ "ok": true, "service": "segment" }` — unauthenticated liveness probe.

## Environment

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `API_KEY` | ✅ | — | Bearer secret checked on `/segment` and `/tasks` (constant-time). |
| `GCS_BUCKET` | ✅ | — | Output bucket for `segment/<id>.glb` + `segment/<id>.parts.json`. Deployed as `three-ws-avatar-reconstructions`. |
| `MAX_CONCURRENT` | | `2` | In-process semaphore bounding concurrent segmentation jobs. |

## Run locally

```bash
cd workers/segment
pip install -r requirements.txt

export API_KEY=dev-secret
export GCS_BUCKET=three-ws-avatar-reconstructions   # needs GCS write creds (ADC)
export MAX_CONCURRENT=2

uvicorn main:app --host 0.0.0.0 --port 8080
```

Then submit a job and poll it:

```bash
# start
curl -s -X POST http://localhost:8080/segment \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mesh":"https://storage.googleapis.com/three-ws-avatar-reconstructions/example.glb","method":"auto","max_parts":12}'
# → {"task_id":"…","status":"queued"}

# poll
curl -s http://localhost:8080/tasks/<task_id> \
  -H "Authorization: Bearer $API_KEY" | jq .
```

GCS uploads need real credentials — run with Application Default Credentials
(`gcloud auth application-default login`) pointed at a project that can write
`GCS_BUCKET`. There is no mock storage path.
