# Run Microsoft TRELLIS on Your Own NVIDIA NIM

The free Forge lane uses NVIDIA's **hosted** TRELLIS preview, which only generates from text prompts. To reconstruct a 3D model from **real photos** — and to own the whole pipeline — you run the **TRELLIS NIM container** on your own NVIDIA GPU and point three.ws at it. This tutorial wires up a self-hosted NIM and drives it through the exact contract three.ws uses.

**What you'll build:** your own NVIDIA NIM serving text- and image-to-3D, reachable through the three.ws `/api/forge-nim` endpoint and the live [/forge-nim](/forge-nim) demo.

**Prerequisites:** an NVIDIA GPU (an L4 or better is plenty), Docker with the NVIDIA Container Toolkit, and an [NVIDIA NGC](https://ngc.nvidia.com) account for the API key that pulls NIM containers.

---

## Step 1 — Pull and run the TRELLIS NIM

TRELLIS ships as a NIM container at `nvcr.io/nim/microsoft/trellis` (the `large:image` build accepts real reference images).

```bash
# Log in to NGC with your NVIDIA API key
docker login nvcr.io -u '$oauthtoken' -p "$NGC_API_KEY"

# Run the NIM — it serves an OpenAPI inference server on :8000
docker run --rm --gpus all \
  -e NGC_API_KEY="$NGC_API_KEY" \
  -p 8000:8000 \
  nvcr.io/nim/microsoft/trellis:latest
```

The container exposes two endpoints three.ws relies on:

- `GET /v1/health/ready` — readiness probe (NIM convention).
- `POST /v1/infer` — reconstruct a GLB, returned **synchronously**.

A cold `large:image` build can take a while on its first hit; after that an L4 reconstructs in roughly **15–45 seconds**.

---

## Step 2 — Expose it over HTTPS

three.ws will only talk to a NIM over **https** whose host isn't a private, loopback, link-local, or cloud-metadata address — an SSRF guard, so the proxy can never be turned into an internal-network probe. Put your container behind a TLS terminator with a public hostname:

- a reverse proxy (Caddy/nginx) with a real certificate, or
- a tunnel (Cloudflare Tunnel, `ngrok`), or
- a managed GPU host (Cloud Run, a GPU VM) with HTTPS in front.

The result is a base URL like `https://trellis.yourdomain.com`.

---

## Step 3 — Point three.ws at your NIM

Set two environment variables on your three.ws deployment. Production runs on Google Cloud Run (service `three-ws-api`, region `us-central1`), so the env lives on the Cloud Run service — see the [GCP production runbook](../ops/gcp-production.md) for the full ops flow.

| Variable | What it is |
|----------|-----------|
| `MODEL_TRELLIS_URL` | The public https origin of your NIM, e.g. `https://trellis.yourdomain.com` |
| `NVIDIA_API_KEY` | Bearer token forwarded to the NIM (if your gateway requires auth) |

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars MODEL_TRELLIS_URL=https://trellis.yourdomain.com

gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars NVIDIA_API_KEY=your-ngc-token
```

Confirm three.ws can see it:

```bash
curl "https://three.ws/api/forge-nim?action=health"
# → { "configured": true, "reachable": true, "baseUrl": "https://trellis.yourdomain.com", "endpoint": ".../v1/infer", "detail": "" }
```

`configured` means the URL is set; `reachable` means the readiness probe answered.

---

## Step 4 — Reconstruct from a prompt

`POST /api/forge-nim` is a thin, honest proxy: it shapes the request, forwards it to your NIM's `/v1/infer`, and hands the GLB straight back as base64.

```bash
curl -X POST "https://three.ws/api/forge-nim" \
  -H "content-type: application/json" \
  -d '{ "mode": "text", "prompt": "a glazed ceramic teapot", "tier": "draft" }'
```

Response:

```json
{
  "ok": true,
  "mode": "text",
  "tier": "draft",
  "contract": "artifacts[0].base64",
  "endpoint": "https://trellis.yourdomain.com/v1/infer",
  "bytes": 184320,
  "ms": 21540,
  "glb_base64": "Z2xURgIAAAA..."
}
```

Decode `glb_base64` to a file:

```bash
node -e 'const b=require("fs").readFileSync(0,"utf8");const o=JSON.parse(b);require("fs").writeFileSync("teapot.glb",Buffer.from(o.glb_base64,"base64"))' < response.json
```

`tier` maps to TRELLIS sampling steps — `draft` runs 15/15 (sparse-structure / structured-latent steps), `high` runs 40/40 for more refinement. Prompts are truncated to TRELLIS's 77-character window, so keep them tight.

---

## Step 5 — Reconstruct from a photo

This is the payoff of self-hosting: a NIM accepts a **real reference image** (the hosted preview won't). Send a data URI or a public image URL:

```bash
curl -X POST "https://three.ws/api/forge-nim" \
  -H "content-type: application/json" \
  -d '{ "mode": "image", "image": "https://example.com/chair.jpg", "tier": "high" }'
```

Reference images are capped at **10 MB**. The same `{ glb_base64, bytes, ms }` envelope comes back.

---

## Step 6 — See it in the browser

Open [three.ws/forge-nim](/forge-nim). The demo page calls the same `/api/forge-nim` endpoint, decodes the returned base64 into a Blob, and renders the GLB in a live viewer — text mode and photo dropzone both. It's the fastest way to confirm your NIM is wired correctly, with the NVIDIA NIM wire contract visible end to end: no R2 round-trip, no mocks, the raw bytes straight from your GPU.

---

## The raw NIM contract

If you'd rather call your NIM directly (bypassing three.ws), this is the contract `/api/forge-nim` speaks:

```http
POST {baseUrl}/v1/infer
{
  "mode": "image" | "text",
  "image": "data:image/png;base64,..."   // image mode
  "prompt": "a glazed ceramic teapot",    // text mode
  "ss_sampling_steps": 15,
  "slat_sampling_steps": 15,
  "output_format": "glb",
  "seed": 0                                // optional, for reproducibility
}

200  { "artifacts": [ { "base64": "<glb>" } ] }
```

The proxy normalizes every documented artifact shape (inline `base64`, a bare string, a `data` field, or a URL artifact) to GLB bytes, so your NIM build just needs to return one of them.

---

## Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `configured: false` from health | `MODEL_TRELLIS_URL` isn't set on the deployment |
| `reachable: false` | The NIM's `/v1/health/ready` didn't answer — check the container and your TLS front |
| `nim_timeout` (504) | Cold `large:image` start; retry once the GPU is warm |
| `nim_auth` (502) | The NIM rejected the bearer — check `NVIDIA_API_KEY` or your gateway auth |
| `bad_base_url` (400) | An override `baseUrl` was http, an IP literal, or a private/`.internal` host |

---

## What's next

- **The no-code version** → [Generate 3D Models Free, Powered by NVIDIA](/tutorials/nvidia-3d-free).
- **Batch it from code** → [Generate 3D Models from Code](/tutorials/generate-3d-api).
- **Run the whole backend yourself** → [Self-host the agent backend](/tutorials/self-host-agent-backend).
