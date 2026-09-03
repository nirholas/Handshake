# Forge: text and image to 3D, on a free-first engine grid

Forge is three.ws's text-and-image-to-3D generator. Type a prompt, drop in one to six photos of an object, or sketch a shape and name it, and Forge returns a downloadable, textured GLB you can orbit, view in AR, and take anywhere. It runs on a grid of real generation engines with live health status, and it is free-first by design: text prompts and photos both default to our own zero-cost GPU reconstruction workers, free hosted lanes stand behind them, and the paid engines stay explicitly selectable for when you want a specific vendor.

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

- **TRELLIS (free)** on NVIDIA NIM (Microsoft TRELLIS). Zero vendor cost, and the last free lane in the chain: it serves a text prompt when every self-host worker and Space is cold or down. Text-only, so it rejects user photos and photo submissions route elsewhere.
- **Hunyuan3D / TRELLIS (free)** on Hugging Face Spaces. The free photo-to-3D lane and a High-tier engine, with automatic failover across Hunyuan3D 2.1, Hunyuan3D 2, TRELLIS, and TripoSR. Queue waits vary.
- **TRELLIS (self-host)** and **Hunyuan3D (self-host)**, our own scale-to-zero Cloud Run GPU workers, and the named defaults: TRELLIS at Draft and Standard, Hunyuan3D at High. Zero vendor cost, so free-first routing prefers them first. Self-host TRELLIS is a native single-hop image-to-3D lane; Hunyuan3D leads on people and organic subjects.
- **TripoSG (self-host)**, the sketch-only scribble worker. Untextured geometry from a drawing.
- **TRELLIS** on Replicate, a paid platform lane. Selectable explicitly and used as the last-resort fallback only on deployments with no free engine configured.
- **Meshy 6**, **Tripo v3.1**, **Rodin (Hyper3D)**, BYOK geometry-first engines with quad topology and a real poly target. You supply your own key.
- **Stable Fast 3D** (Stability, BYOK) and **Replicate (your account)** (BYOK), single-image reconstruction lanes.

### Free-first routing with live health

Routing (`resolveBackendIdWithHealth`) walks an ordered list of every free lane that could serve the request on this deployment, most preferred first: the tier's named free engine, then the per-path fallback chain (our own GPU workers, then the free external Spaces, then the free NVIDIA lane as the final health-gated safety net). Draft and Standard name our self-host TRELLIS worker; High names our self-host Hunyuan3D worker. The free NVIDIA NIM lane is never a named default: reconstructing straight from a truncated prompt with no photoreal reference is the realism hole this ordering closes, so it trails as the final health-gated fallthrough (and stays explicitly selectable). A subject classifier reorders the two self-host PBR lanes for hard-surface versus organic prompts. Every entry is env-gated, so the list degrades cleanly on partial deployments.

Health is real. The UI fetches `/api/forge?health=1` after load and disables any lane whose upstream is down, with the actual reason, instead of failing after you have typed a prompt and clicked Generate. A short circuit-breaker cooldown sidelines a degraded lane (for example the free NIM lane after a gateway timeout) so subsequent requests skip it and go straight to a working engine; the cooldown expires on its own so a recovered lane is retried promptly. There are no mock paths: if a selected backend isn't configured the endpoint returns a clean `backend_unconfigured` error, never a fake result.

### Background generation and resume

Generation is a job. `POST /api/forge` returns a `job_id`; the client polls `GET /api/forge?job=<id>` until the status is `done` or `failed`. The lanes that complete inline within one request (free NVIDIA NIM, HuggingFace Spaces, BYOK-sync) can instead answer the POST directly with `status:'done'`, the `glb_url`, and a null `job_id`, and they retry once automatically on a failed result. Because the in-flight job id is written to `localStorage`, closing the tab or navigating away does not lose the generation: returning to Forge within a 30-minute window resumes polling the same job. Finished models for your browser are surfaced from a gallery on load, and a share link always wins over a resume.

### Comparing two engines on one prompt

The engine grid is only useful if you can see what choosing an engine actually
changes. Once your gallery holds two models, a **Compare** control appears above
it. Turn it on, pick any two creations, and they open side by side in two
viewers, each labelled with the engine and tier that produced it.

Camera orbit is synced across both panes, so turning one turns the other. Only
the orbit angles are shared, never the distance: two generations of one prompt
routinely differ in scale, and model-viewer frames each at its own radius, so
copying an absolute distance across would zoom one model into its own interior.
Each pane keeps the distance that frames it and turns in lockstep. Untick **Sync
cameras** to inspect one model on its own.

When your gallery contains the same prompt run on two *different* engines, a
hint above the grid points it out, because that is the comparison worth making.
Two runs of one prompt on one engine is a re-roll, not an engine comparison, and
the hint deliberately stays quiet for it (`findComparablePrompts` in
[src/forge-compare.js](../src/forge-compare.js), covered by
[tests/forge-compare.test.js](../tests/forge-compare.test.js)).

### Reel: video and stills, rendered in your browser

A GLB is the wrong thing to send someone who just wants to see what you made.
The **Reel** button on the result bar (or the `R` key) renders a cinematic pass
over the finished model and hands back three real files:

| File | What it is | Where it goes |
| --- | --- | --- |
| `<name>-<shot>-reel.mp4` | The video, 30fps, MP4 where the browser can encode it and WebM otherwise | Slides, posts, a landing page `<video>` |
| `<name>-<shot>-hero.png` | The shot's hero frame on the reel backdrop | Thumbnails, link previews |
| `<name>-<shot>-cutout.png` | The same frame with a transparent background | Dropping the model onto any design |

Three shots ship. **Turntable** is one clean revolution whose last frame lands
exactly on its first, so it loops without a jump. **Hero push** opens wide and
dollies into a three-quarter hero angle. **Low reveal** rises from below the
horizon. Aspect is 16:9, 1:1 or 9:16, and length is 4, 8 or 12 seconds.

Everything runs client side. Nothing is uploaded, no job is queued, and no
server renders anything, so a reel costs nothing and works while you are signed
out.

Two implementation choices are worth knowing because they are what make the
output trustworthy:

- **Reel renders its own pass rather than recording the page's viewer.**
  `<model-viewer>` runs a single shared WebGL canvas across every viewer on a
  page and moves it between shadow roots as visibility changes, so a canvas
  stream taken from it can carry zero frames while still reporting a clean
  recording. Owning the canvas also means the output is exactly the resolution
  you picked instead of your window size times your display's pixel ratio. The
  lighting is not a reimplementation: tone mapping, the HDRI environment and the
  ground contact shadow all come from
  [src/shared/cinematic-render.js](../src/shared/cinematic-render.js), the same
  module behind [/irl](https://three.ws/irl) and the avatar viewers.
- **The shot is paced to a fixed timestep.** Frames are rendered one at a time
  and pushed to the encoder on a wall-clock schedule, so a slow laptop produces
  the same 4-second reel as a fast desktop rather than a shorter, jerkier one.

Camera tracks are expressed in multiples of the model's own framed distance, so
a ring and a cathedral get the same shot rather than the same numbers, and the
framing distance accounts for the aspect: a 9:16 frame is limited by its
horizontal field of view, and ignoring that is exactly how a vertical reel crops
the subject's head off. The sampler, the framing maths, the codec preference and
the filenames live in [src/forge-reel.js](../src/forge-reel.js) and are covered
by [tests/forge-reel.test.js](../tests/forge-reel.test.js).

If a browser has no canvas video encoder, Reel says so and still produces both
stills; it never reports a recording that did not happen.

## Walkthrough

1. Open [/forge](https://three.ws/forge). No login, no wallet, no key required.
2. Pick an input mode: **Describe it** (text), **From photos**, or **From a sketch** (the sketch tab appears only when the TripoSG worker is configured).
3. For text, type a prompt like `a weathered brass diving helmet`. For photos, add one to six images of the same object from different angles (front, back, left, right, top, three-quarter); each uploads straight to object storage via a presigned URL and the public URLs are fused with multi-view conditioning.
4. Optionally open the quality controls and pick a tier (Draft, Standard, High) and an engine. The default engine carries a **FREE** pill. Down lanes are disabled with the reason shown.
5. Click Generate. A real elapsed-driven progress line runs against the catalog's ETA estimate for the chosen path, tier, and engine.
6. When the model lands, orbit it in the viewer, view it in AR, download it in any of seven formats (see [Download formats](#download-formats)), or run the post-generation tools (stylize, optimize, Game-Ready retopology, split). Press `R` (or click **Reel**) to render a shareable video and stills of it without leaving the page.
7. Keep going on the same result: **Rig for animation** adds a humanoid skeleton (POST `/api/forge?action=rig`) and hands off to Pose Studio or IRL placement; **Restyle materials** re-skins the surface with a free-text instruction or a preset chip (chrome, wood, gold, neon, marble, rust) via `/api/material-studio`, keeping the mesh untouched; **Iterate** makes a shape-changing edit from a plain-language instruction ("make the helmet red", "add a backpack") via `/api/forge-iterate` (the same conversational core the `refine_model` MCP tool uses) and keeps every version in a branchable lineage strip; **Place IRL** opens `/irl?avatar=<glb_url>` to anchor the model in AR at a real-world location.

## Download formats

The Download button always hands back the source GLB immediately. The caret
beside it opens a format menu with seven targets:

| Format | Converted | Use it for |
|---|---|---|
| GLB | nothing to convert | The source. Textures embedded, works anywhere glTF does. |
| OBJ | in your browser | Universal geometry + UVs for Blender, Maya, C4D. No materials. |
| STL | in your browser | Solid geometry for 3D printing and CAD. Binary. |
| PLY | in your browser | Vertex-level data for scanning and point-cloud tools. Binary. |
| USDZ | in your browser | Textured AR asset. Opens directly on iPhone and Vision Pro. |
| FBX | on the server | Rigged interchange for Unity, Unreal and Maya. Keeps the skeleton, skin weights and blendshapes. |
| 3MF | on the server | Manufacturing package for slicers and print services. |

The first five are converted by three.js exporters in the page: no upload, no
queue, and the parsed scene is cached so switching formats does not re-download
the model. FBX and 3MF have no browser exporter, so they are authored by the
remesh worker from the source GLB. A server conversion is a real job: it shows
progress while it runs, names the reason if it fails, and leaves a
"download again" link for a minute in case the browser missed the download.

Both server formats are the same conversion the API exposes directly, so an
agent can ask for one without going through the page:

```bash
# Convert an existing GLB to FBX (geometry untouched, rig preserved).
curl -sX POST https://three.ws/api/forge-remesh \
  -H 'content-type: application/json' \
  -d '{"mesh_url":"https://.../model.glb","operation":"convert","output_format":"fbx"}'
# → 202 { "job_id": "...", "status": "queued" }

# Poll it. Terminal states are "done" (with result_url) and "failed" (with error).
curl -s 'https://three.ws/api/forge-remesh?job=<job_id>'
```

`output_format` accepts `glb`, `obj`, `stl`, `ply`, `usdz`, `3mf` and `fbx`.
`operation: "convert"` re-containers the mesh without touching its geometry;
drop it to remesh and convert in one pass (see
[3d-asset-pipeline.md](3d-asset-pipeline.md)).

## Examples

Forge's read and generate surface is plain HTTP. No key is required for the free lanes.

```bash
# Read the tier/backend/cost matrix the UI renders.
curl 'https://three.ws/api/forge?catalog=1'

# Probe live backend health (which lanes are up right now).
curl 'https://three.ws/api/forge?health=1'

# Start a free text-to-3D generation. A lane that finishes inside the request
# (and any cache hit) answers with status "done", a glb_url, and a null job_id;
# slower lanes answer with a job_id to poll instead.
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
- **Photo input** accepts up to six views of one object (front, back, left, right, top, three-quarter); text-only engines are filtered out of the photo modes automatically.
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
