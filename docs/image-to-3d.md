# Image to 3D: turn a photo into a downloadable 3D model

Image to 3D is Forge's photo lane, opened directly. Drop in one to six photos of an object, taken from different angles, and get back a textured, downloadable GLB you can orbit, view in AR, and take into any engine. It is the fastest way to go from a real thing on your desk, or a single reference image, to a real 3D model, with no account and no key on the free lane.

Page: [/image-to-3d](https://three.ws/image-to-3d) · API: `/api/forge`

## Why it exists

Text-to-3D is great when you can describe a thing. But often you already have the thing, or a picture of it: a prop, a toy, a piece of furniture, a product shot. Reconstructing geometry from photos preserves the real proportions and surface that a text prompt can only approximate. Image to 3D gives that reconstruction its own entry point so a first-time visitor lands directly in photo mode instead of hunting for the tab, while everything else, the engine grid, the tiers, the live health status, the downloadable GLB, is the same Forge machinery underneath.

[/image-to-3d](https://three.ws/image-to-3d) and [/forge](https://three.ws/forge) are the same application (`pages/forge.html`, driven by `src/forge.js`). The `/image-to-3d` route sets the page into photo mode and retitles it; the app is otherwise identical, so any engine, tier, or export you can reach from Forge you can reach here.

## How it works

When you add photos, the app switches to the `image` (image-intermediate) generation path. Each photo is uploaded straight to object storage through a presigned URL (`/api/forge-upload`), and the resulting public URLs are POSTed to `/api/forge` as `image_urls`. With more than one view the backend fuses them with multi-view conditioning, so the reconstructed mesh honors detail from every angle you supplied rather than guessing the unseen sides from a single frame.

Routing is free-first and health-aware, exactly as in Forge. Because the free NVIDIA NIM TRELLIS lane is text-only (it rejects user images), photo submissions filter it out and fall to the free reconstruction chain in `api/_lib/forge-tiers.js`, most preferred first:

1. **TRELLIS (self-host)**, our own Cloud Run GPU worker, a native single-hop image-to-3D lane (image to TRELLIS to GLB), zero vendor cost.
2. **Hunyuan3D (self-host)**, our own high-poly reconstruction worker, strong on people and organic subjects.
3. **Hunyuan3D / TRELLIS (free)** on Hugging Face Spaces, with automatic failover across Hunyuan3D 2.1, Hunyuan3D 2, TRELLIS, and TripoSR.

Paid and BYOK image engines stay explicitly selectable: **Meshy 6**, **Tripo v3.1**, **Rodin (Hyper3D)**, **Stable Fast 3D** (Stability), the **Replicate** TRELLIS lane, and your own Replicate account. A lane whose upstream is down is disabled in the engine picker with the real reason, and a selected engine that can't accept photos bounces to the standing photo default rather than failing after you commit.

The result is a job: the client polls `GET /api/forge?job=<id>` until the GLB lands, and an interrupted generation resumes from the same browser for 30 minutes. Every result reports the path, tier, and backend that produced it.

### Objects and props, not faces

Image to 3D reconstructs whole objects: a prop, a product, a toy, a sculpture, a piece of hardware. It is not a face-to-avatar pipeline. To turn a selfie into a rigged, animation-ready humanoid avatar, use the dedicated face reconstruction flow at [/create/selfie](https://three.ws/create/selfie), which runs a purpose-built face pipeline (head framing, identity preservation, rig) rather than general object reconstruction. Feeding a headshot into the general image lane treats the head as an object and will not produce a rigged avatar.

## Walkthrough

1. Open [/image-to-3d](https://three.ws/image-to-3d). The page opens in photo mode.
2. Add one to six photos of the same object, one per view slot (front, back, left, right, top, three-quarter). For best results shoot the same object from different angles on a plain background.
3. Optionally pick a tier (Draft, Standard, High) and an engine. The default free reconstruction lane carries a **FREE** pill; down lanes are disabled with a reason.
4. Click Generate. A real elapsed-driven progress line runs against the ETA for the resolved engine and tier; a cold self-host worker adds an honest spin-up estimate.
5. When the model lands, orbit it, view it in AR, download the GLB, or run the post-generation tools (stylize, optimize, Game-Ready retopology).

## Examples

Send public image URLs to the same `/api/forge` endpoint. No key is required on the free lane.

```bash
# Multi-view reconstruction from three angles, standard tier, then poll. A lane
# that completes inline answers the POST with status "done", a glb_url, and a
# null job_id; otherwise you get a job_id to poll until "done" or "failed".
RESP=$(curl -s -X POST 'https://three.ws/api/forge' \
  -H 'content-type: application/json' \
  -d '{"image_urls":["https://…/front.jpg","https://…/side.jpg","https://…/back.jpg"],"tier":"standard"}')
echo "$RESP" | python3 -c 'import sys,json;j=json.load(sys.stdin);print(j.get("glb_url") or j["job_id"])'

curl "https://three.ws/api/forge?job=<JOB_ID>"
```

Single-image reconstruction is just one URL:

```bash
curl -X POST 'https://three.ws/api/forge' \
  -H 'content-type: application/json' \
  -d '{"image_urls":["https://…/sneaker.jpg"],"tier":"draft"}'
```

Poll until the GLB is ready in JavaScript:

```javascript
const start = await fetch('https://three.ws/api/forge', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image_urls: ['https://…/chair.jpg'], tier: 'standard' }),
}).then((r) => r.json());

let job = start;
while (job.status !== 'done' && job.status !== 'failed') {
  await new Promise((r) => setTimeout(r, 4000));
  job = await fetch(`https://three.ws/api/forge?job=${start.job_id}`).then((r) => r.json());
}
console.log(job.glb_url);
```

## States and limits

- **Up to six views** per generation (`MAX_VIEWS` in `api/forge.js`); more views mean tighter multi-view fusion.
- **Free lane** requires no account. The **High tier** is $THREE hold-or-pay gated (quality gate, not vendor-cost recovery); a verified $THREE pass also lifts the free-lane quota.
- **Loading**: real elapsed counter; cold GPU workers surface an honest spin-up estimate.
- **Down or unconfigured engine**: disabled with the real reason, or a clean `backend_unconfigured` error. No mock output, ever.
- **Resume**: an interrupted job is pollable again for 30 minutes from the same browser.
- **Objects, not faces**: for a rigged humanoid from a selfie, use [/create/selfie](https://three.ws/create/selfie).
- Uploads cap at 8 MB per image; rate limits are per client IP.

## Related

- [Forge](./forge.md) is the full text-and-image-to-3D surface with every mode and engine.
- [Avatar reconstruction](./avatar-reconstruction.md) and [avatar creation](./avatar-creation.md) cover the face-to-avatar pipeline behind [/create/selfie](https://three.ws/create/selfie).
- The pipeline internals: [3D asset pipeline](./3d-asset-pipeline.md), [3D pipeline](./3d-pipeline.md), [3D API](./3d-api.md).
- Pages: [/create](https://three.ws/create), [/scene](https://three.ws/scene) (Scene Studio), [/gallery](https://three.ws/gallery).
