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

The parts are a strict **partition** of the input: same faces, redistributed,
never repaired and never invented. (trimesh patches holes while splitting by
default, which grew a real 17031-face forge model to 17050 faces across its
parts and made the manifest contradict its own `source_faces`.)

## Cost

Measured on this repo's dev machine, whole path, load through GLB export, one
job at a time:

| Faces in | Wall clock | Peak RSS |
|---|---|---|
| 20 k | 1.5 s | 122 MB |
| 82 k | 6.8 s | 193 MB |
| 328 k | 23 s | 476 MB |
| 1.3 M | 81 s | 1.5 GB |

Roughly 1.1 KB of peak memory per input face, so the 128 MiB input cap and
`MAX_CONCURRENT=2` sit comfortably inside the 16 GiB instance. `JOB_TIMEOUT_S`
bounds the tail.

These numbers are the point of the 2026-08-11 merge-pass rewrite. The previous
implementation rebuilt the entire label-adjacency map and rescanned the whole
label array on *every single merge*, which is cubic in the number of crease
regions: a 20 k-face mesh took **328 s** in the merge pass alone, and real jobs
in production ran for **2.9 to 4 hours** while repeatedly OOM-killing the 16 GiB
instance. The rewrite keeps regions in a union-find with incrementally
maintained neighbour sets and one lazily-invalidated min-heap, applies exactly
the same merge policy, and writes the label array once at the end. Verified
identical output on 20 of 20 mesh/parameter combinations against the original
implementation.

## Files

| File | Role |
|------|------|
| `main.py` | FastAPI app: request validation, async job queue (`MAX_CONCURRENT` semaphore), GCS upload of the GLB + manifest, durable task records. |
| `segment_core.py` | The geometry engine: `load_concatenated`, `segment`, `build_scene`, `manifest`. Trimesh + numpy + scipy. |
| `test_segment_core.py` | Core-path tests for the geometry engine. No GCS, no network. Run as a Docker build gate. |
| `worker_security.py` | Shared bearer-auth + SSRF-hardened fetch + opaque error helper. Byte-identical copy across all workers, so keep it in sync when editing. |
| `Dockerfile` | `python:3.11-slim` + native libs (`libgl1`, `libassimp5`, `libopenblas`); runs the test gate, then serves via `uvicorn` on port 8080. |
| `cloudbuild.yaml` | Cloud Build to Artifact Registry to Cloud Run deploy. |

## How it ships

Built and deployed by **Cloud Build** to **Google Cloud Run**:

- Service: **`segment-service`**, region **`us-central1`**
- CPU only (`--cpu=8 --memory=16Gi`, no GPU), **kept warm** at
  `min-instances=1` / `max-instances=3`, 300 s request timeout. It is not
  scale-to-zero: Parts Studio calls it the moment a user asks to split a model,
  and a cold start is a visible stall.
- Service account `avatar-reconstruction-sa`; `API_KEY` is mounted from the
  `avatar-reconstruction-key` Secret Manager secret, the **same shared bearer
  secret** every model worker checks (`GCP_RECONSTRUCTION_KEY` on the platform
  side).

```bash
# from repo root, deploy the current tree
gcloud builds submit --config workers/segment/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s) .
```

`SHORT_SHA` is required on a manual submit: the config tags the image with it,
and an unsubstituted tag fails the build. The build runs `test_segment_core.py`
as a gate, so a regressed merge pass never reaches a deployed image.

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
`done`.

**Task records are durable.** Every status change is mirrored to
`segment/<id>.task.json` in `GCS_BUCKET`, and a poll for an id this instance
does not know reads that record. Task state used to live only in the
submitting instance's memory, so with `min-instances=1`/`max=3` a poll routed
to a sibling, or arriving after a restart, returned a bare `404` and the caller
reported a phantom failure. Verified by polling a completed job against a
freshly started instance: it answers `done` with the full manifest, while an id
that never existed still `404`s.

**Failures say what went wrong when they safely can.** A caller's mistake
(unknown `only_part`, a mesh with no triangles, an SSRF-refused URL) returns
the real reason, e.g. `part 'part_99' not found. Available: part_01 (upper-back),
...` or `refused to fetch mesh: host resolves to a disallowed address:
169.254.169.254`. Anything unexpected still returns an opaque,
correlation-id-tagged message with the traceback logged server-side only. The
split is by exception type (`SegmentInputError` / `SegmentTimeout` are echoed,
everything else is not), so a library-internal message can never leak.

### `GET /health` → `200`

`{ "ok": true, "service": "segment" }` — unauthenticated liveness probe.

## Environment

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `API_KEY` | ✅ | n/a | Bearer secret checked on `/segment` and `/tasks` (constant-time). |
| `GCS_BUCKET` | ✅ | n/a | Output bucket for `segment/<id>.glb`, `segment/<id>.parts.json`, and `segment/<id>.task.json`. Deployed as `three-ws-avatar-reconstructions`. |
| `MAX_CONCURRENT` | | `2` | In-process semaphore bounding concurrent segmentation jobs. |
| `JOB_TIMEOUT_S` | | `600` | Wall-clock ceiling per job, covering the mesh fetch and the segmentation. Exceeding it fails the task instead of holding a slot. |
| `TASK_TTL_S` | | `3600` | How long a finished task stays in instance memory. The durable GCS record outlives it. |

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

GCS uploads need real credentials: run with Application Default Credentials
(`gcloud auth application-default login`) pointed at a project that can write
`GCS_BUCKET`. There is no mock storage path.

Uploads retry on transient transport faults. A single
`SSLEOFError: UNEXPECTED_EOF_WHILE_READING` from `storage.googleapis.com` used
to discard an otherwise finished segmentation, because the client library
treats an upload as non-idempotent and does not retry it by default. Every blob
is named after a fresh uuid, so replaying the write is safe.

## Tests

```bash
python3 workers/segment/test_segment_core.py
```

80 checks over the geometry engine: loading and scene concatenation, connected
and crease segmentation, the `max_parts` cap, the face-partition property, run
to run determinism, the time budget, GLB node naming, and the manifest shape.
No GCS, no network, no GPU. The Docker build runs it, so a regression fails the
image rather than the deploy.

Two of them are the load-bearing ones: a **performance** check that fails if the
merge pass regresses toward its pre-2026-08-11 cost, and a **determinism** check
that the same mesh segments identically twice. Determinism is not cosmetic here:
the merge picks the largest neighbour, and resolving ties by Python set
iteration order made the same model produce differently grouped parts between
runs. Ties now break on the lowest label.
