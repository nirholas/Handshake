# Forge: text and image to 3D, on a free-first engine grid

Forge is three.ws's text-and-image-to-3D generator. Type a prompt, drop in one to four photos of an object, or sketch a shape and name it, and Forge returns a downloadable, textured GLB you can orbit, view in AR, and take anywhere. It runs on a grid of real generation engines with live health status, and it is free-first by design: text prompts default to a zero-cost NVIDIA lane, photos default to a zero-cost reconstruction lane, and the paid engines stay explicitly selectable for when you want a specific vendor.

Page: [/forge](https://three.ws/forge) and the feature landing [/features/forge](https://three.ws/features/forge) · API: `/api/forge`

## Why it exists

Every other text-to-3D tool makes you choose a vendor, buy credits, and hope the one model they wired up is the right one for your prompt. Forge inverts that. It treats generation as a routing problem over many engines, picks the best free lane for the input you gave it, degrades gracefully when an upstream is down, and only ever charges for higher quality, never to recover a vendor bill. The result is a single surface where a first-time visitor can make a real 3D model in seconds with no account, no key, and no cost, while a power user can pin a specific engine, bring their own key, or push a High-tier generation through multi-view fusion.

Forge is the public, auth-free twin of the 3D Studio MCP server (`api/mcp-3d.js`), so anything the page can do, an agent can do over MCP or a plain HTTP call.

## How it works

A generation request is described by two orthogonal axes, resolved in `api/_lib/forge-tiers.js`, the single source of truth shared by the endpoint, the catalog the UI renders, and every provider param builder.

**The path** is how geometry is produced:

- `image` (image-intermediate, the fast default): text is painted into a reference view (FLUX/Imagen) and reconstructed to a mesh, or your own photo is reconstructed directly.
- `geometry` (geometry-first): a native 3D model emits mesh directly from the prompt or a single photo, so detail isn't capped by what one image implies. This is the Meshy and Tripo text-to-3D path.
- `sketch` (sketch-conditioned): a drawing plus a prompt naming what it depicts drives TripoSG-scribble straight to geometry, no photo and no intermediate view.

**The tier** is how much geometric budget to spend:

| Tier | Poly target | Textures | Price (direct USDC) | Notes |
| --- | --- | --- | --- | --- |
| Draft | 12,000 | none | $0.05 | Fast, low-poly. Blockout and iteration. |
| Standard | 30,000 | 2K | $0.15 | Balanced, multi-angle reference fusion. The default. |
| High | 200,000 | PBR + HD | $0.50 | Maximum detail, deepest sampler budget, multi-view fusion. |

### The engine grid

Each backend declares which paths it serves, whether it needs a bring-your-own-key (BYOK) credential, and its per-(path, tier) cost and latency estimates so the UI can show the trade-off before you commit. The live registry (`BACKENDS` in `api/_lib/forge-tiers.js`):

- **TRELLIS (free)** on NVIDIA NIM (Microsoft TRELLIS). The default lane for text prompts at Draft and Standard. Zero vendor cost. Text-only: it rejects user photos, so photo submissions route elsewhere.
- **Hunyuan3D / TRELLIS (free)** on Hugging Face Spaces. The free photo-to-3D lane and a High-tier engine, with automatic failover across Hunyuan3D 2.1, Hunyuan3D 2, TRELLIS, and TripoSR. Queue waits vary.
- **TRELLIS (self-host)** and **Hunyuan3D (self-host)**, our own scale-to-zero Cloud Run GPU workers. Zero vendor cost, so free-first routing prefers them first. Self-host TRELLIS is a native single-hop image-to-3D lane; Hunyuan3D leads on people and organic subjects.
- **TripoSG (self-host)**, the sketch-only scribble worker. Untextured geometry from a drawing.
- **TRELLIS** on Replicate, a paid platform lane. Selectable explicitly and used as the last-resort fallback only on deployments with no free engine configured.
- **Meshy 6**, **Tripo v3.1**, **Rodin (Hyper3D)**, BYOK geometry-first engines with quad topology and a real poly target. You supply your own key.
- **Stable Fast 3D** (Stability, BYOK) and **Replicate (your account)** (BYOK), single-image reconstruction lanes.

### Free-first routing with live health

Routing (`resolveBackendIdWithHealth`) walks an ordered list of every free lane that could serve the request on this deployment, most preferred first: the tier's named free engine, then the per-path fallback chain (our own GPU workers, then the free external Spaces, then the free NVIDIA lane as the final health-gated safety net). Draft and Standard text prompts name NVIDIA TRELLIS; High names our self-host Hunyuan3D worker. A subject classifier reorders the two self-host PBR lanes for hard-surface versus organic prompts. Every entry is env-gated, so the list degrades cleanly on partial deployments.

Health is real. The UI fetches `/api/forge?health=1` after load and disables any lane whose upstream is down, with the actual reason, instead of failing after you have typed a prompt and clicked Generate. A short circuit-breaker cooldown sidelines a degraded lane (for example the free NIM lane after a gateway timeout) so subsequent requests skip it and go straight to a working engine; the cooldown expires on its own so a recovered lane is retried promptly. There are no mock paths: if a selected backend isn't configured the endpoint returns a clean `backend_unconfigured` error, never a fake result.

### Background generation and resume

Generation is a job. `POST /api/forge` returns a `job_id`; the client polls `GET /api/forge?job=<id>` until the status is `done` or `failed`. The lanes that complete inline within one request (free NVIDIA NIM, HuggingFace Spaces, BYOK-sync) can instead answer the POST directly with `status:'done'`, the `glb_url`, and a null `job_id`, and they retry once automatically on a failed result. Because the in-flight job id is written to `localStorage`, closing the tab or navigating away does not lose the generation: returning to Forge within a 30-minute window resumes polling the same job. Finished models for your browser are surfaced from a gallery on load, and a share link always wins over a resume.

## Walkthrough

1. Open [/forge](https://three.ws/forge). No login, no wallet, no key required.
2. Pick an input mode: **Describe it** (text), **From photos**, or **From a sketch** (the sketch tab appears only when the TripoSG worker is configured).
3. For text, type a prompt like `a weathered brass diving helmet`. For photos, add one to four images of the same object from different angles; each uploads straight to object storage via a presigned URL and the public URLs are fused with multi-view conditioning.
4. Optionally open the quality controls and pick a tier (Draft, Standard, High) and an engine. The default engine carries a **FREE** pill. Down lanes are disabled with the reason shown.
5. Click Generate. A real elapsed-driven progress line runs against the catalog's ETA estimate for the chosen path, tier, and engine.
6. When the model lands, orbit it in the viewer, view it in AR, download the GLB, or run the post-generation tools (stylize, optimize, Game-Ready retopology, split).
7. Keep going on the same result: **Rig for animation** adds a humanoid skeleton (POST `/api/forge?action=rig`) and hands off to Pose Studio or IRL placement; **Restyle materials** re-skins the surface with a free-text instruction or a preset chip (chrome, wood, gold, neon, marble, rust) via `/api/material-studio`, keeping the mesh untouched; **Iterate** makes a shape-changing edit from a plain-language instruction ("make the helmet red", "add a backpack") via `/api/forge-iterate` — the same conversational core the `refine_model` MCP tool uses — and keeps every version in a branchable lineage strip; **Place IRL** opens `/irl?avatar=<glb_url>` to anchor the model in AR at a real-world location.

## Examples

Forge's read and generate surface is plain HTTP. No key is required for the free lanes.

```bash
# Read the tier/backend/cost matrix the UI renders.
curl 'https://three.ws/api/forge?catalog=1'

# Probe live backend health (which lanes are up right now).
curl 'https://three.ws/api/forge?health=1'

# Start a free text-to-3D generation. The free NVIDIA lane often completes
# inline, answering with status "done", a glb_url, and a null job_id; slower
# lanes answer with a job_id to poll instead.
RESP=$(curl -s -X POST 'https://three.ws/api/forge' \
  -H 'content-type: application/json' \
  -d '{"prompt":"a weathered brass diving helmet","tier":"draft"}')
echo "$RESP" | python3 -c 'import sys,json;j=json.load(sys.stdin);print(j.get("glb_url") or j["job_id"])'

# If you got a job_id, poll it until the status is "done" or "failed".
curl "https://three.ws/api/forge?job=<JOB_ID>"
```

Image-to-3D over the API sends public image URLs instead of a prompt:

```bash
curl -X POST 'https://three.ws/api/forge' \
  -H 'content-type: application/json' \
  -d '{"image_urls":["https://…/front.jpg","https://…/side.jpg"],"tier":"standard"}'
```

A minimal poll-until-done loop in JavaScript:

```javascript
const start = await fetch('https://three.ws/api/forge', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'a low-poly campfire', tier: 'draft' }),
}).then((r) => r.json());

let job = start;
while (job.status !== 'done' && job.status !== 'failed') {
  await new Promise((r) => setTimeout(r, 4000));
  job = await fetch(`https://three.ws/api/forge?job=${start.job_id}`).then((r) => r.json());
}
console.log(job.glb_url); // downloadable, textured GLB
```

## States and limits

- **Loading**: a real elapsed counter driven by the catalog ETA for the resolved path, tier, and engine. Cold self-host GPU workers add an honest spin-up estimate rather than a stalled bar.
- **Down lane**: disabled engine button with the real upstream reason; routing skips it via the circuit-breaker cooldown.
- **Unconfigured backend**: a clean `backend_unconfigured` error, never a mock.
- **Resume**: an interrupted job is pollable again for 30 minutes from the same browser.
- **Every result** reports the path, tier, and backend that produced it, so you always know which engine ran.
- **The High tier is $THREE hold-or-pay gated** in the handler regardless of which free engine serves it: we charge for quality, not to recover vendor cost. A verified $THREE tier pass also lifts the free-lane quota.
- **BYOK engines** (Meshy, Tripo, Rodin, Stability, Replicate) require your own key; they are never billed to a platform account.
- **Photo input** accepts up to four views of one object; text-only engines are filtered out of the photo modes automatically.
- Rate limits are per client IP on the shared 3D generation buckets.

## Measuring realism

Any change that could affect output quality (a tier's sampler budget, a new
lane, a prompt-enhancement change) should be checked against the realism
benchmark before and after: `node scripts/quality-bench.mjs` runs a fixed
23-prompt set through this real `/api/forge` path and scores the result with
Vertex Gemini vision; `node scripts/quality-bench.mjs --compare=latest,previous`
exits nonzero on a >1.0 mean-score drop. See
[data/quality-bench/README.md](../data/quality-bench/README.md) and the
dashboard at [/quality-bench](https://three.ws/quality-bench) (internal).

## Related

- [The Forge pipeline](./forge-pipeline.md) is the architecture deep dive: the engine grid, routing, failover, job lifecycle, workers, and payments, end to end. [How the Forge works](./how-forge-works.md) is the same story in plain language.
- [Image to 3D](./image-to-3d.md) is the photo lane opened directly at [/image-to-3d](https://three.ws/image-to-3d).
- [/forge-max](https://three.ws/forge-max) is the maximum-quality lane opened directly: the same Forge with the High tier pinned on arrival (200k-poly target, 4K PBR and HD textures, subject-aware engine routing). `?tier=draft|standard|high` presets the quality selector on any Forge URL the same way. The High tier's $THREE hold-or-pay gate applies unchanged; BYOK engines (your own Meshy, Tripo, or Rodin key) are exempt as always. For DamagedHelmet-class artist benchmarks, remember the ceiling is the current state of generative 3D, not the routing: this lane maxes every budget the engines expose, and [Measuring realism](#measuring-realism) is how we track that ceiling moving.
- [Diorama](./diorama.md) forges a whole scene of Forge objects into one explorable world.
- The 3D generation architecture: [3D pipeline](./3d-pipeline.md), [3D asset pipeline](./3d-asset-pipeline.md), [3D API](./3d-api.md).
- Pages: [/create](https://three.ws/create) (the avatar creator), [/scene](https://three.ws/scene) (Scene Studio), [/restyle](https://three.ws/restyle) (re-skin a GLB), [/gallery](https://three.ws/gallery).
