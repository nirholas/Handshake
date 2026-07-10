# rembg — background removal

Strips the background from an image and returns a transparent PNG. Every mesh
backend reconstructs better geometry from a cleanly cut-out subject, so this runs
ahead of the image→3D models (except [model-triposg](../model-triposg/), which
removes backgrounds in-process).

Uses BRIA RMBG-2.0 (Apache-2.0), with rembg's U2Net family as a fast CPU fallback.

**No GPU required.** `isnet-general-use` / `u2net` take ~1–2 s per 1024 px image on
CPU; a GPU cuts that to ~0.2 s. Only the default model loads at startup — the rest
load lazily on first use, so cold starts stay fast.

## API

All routes require `Authorization: Bearer $API_KEY`, except `/health`.

### `POST /remove` → `202`

```bash
curl -X POST https://$SERVICE_URL/remove \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"image":"https://example.com/portrait.jpg","model":"u2net_human_seg"}'
# → { "task_id": "…", "status": "queued" }
```

| Field | Required | Notes |
|---|---|---|
| `image` | yes | `https://` URL or `data:` URI |
| `model` | no | `u2net` \| `isnet-general-use` \| `u2net_human_seg` \| `silueta` |

Legacy aliases `rmbg2` and `isnet` both resolve to `isnet-general-use`. Pick
`u2net_human_seg` for people — it is trained on human matting.

Remote URLs are fetched through the SSRF guard in [`worker_security.py`](./worker_security.py).

### `GET /tasks/{task_id}`

```json
{ "task_id": "…", "status": "succeeded", "result_url": "https://storage.googleapis.com/…/cutout.png" }
```

### `GET /health`

```json
{ "ok": true, "models_loaded": ["isnet-general-use"], "models_available": ["u2net", "…"], "default_model": "isnet-general-use", "gpu_available": false }
```

`models_loaded` vs `models_available` shows the lazy-load state.

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager: `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Output bucket for PNGs (`three-ws-avatar-reconstructions`) |
| `MODEL` | no | `isnet-general-use` | Model loaded at startup |
| `MAX_CONCURRENT` | no | `4` | CPU-bound, so several fit at once |

> The deployed config sets `MODEL=rmbg2`, which the alias table resolves to
> `isnet-general-use`.

## Deploy

```bash
gcloud builds submit --config workers/rembg/cloudbuild.yaml workers/rembg
```

Cloud Run service `rembg-service` in `us-central1`: no GPU, 4 vCPU, 8 GiB, 60 s
timeout, `min-instances=0`, `max-instances=4`.

## Callers

`GCP_REMBG_URL`.

## Local

```bash
cd workers/rembg
pip install -r requirements.txt
API_KEY=dev GCS_BUCKET=your-dev-bucket uvicorn main:app --port 8080
```

Runs on CPU — no GPU or weights volume needed.
