# Generate 3D Models from Code

Everything the [Forge](/forge) does in the browser is available as a plain HTTP API: send a prompt, poll a job, download a GLB. No API key, no SDK, no auth handshake — it's the same public endpoint the Forge UI calls, rate-limited per IP.

**What you'll build:** a script that turns any text prompt into a downloaded `.glb` file, then a batch version that generates a whole asset pack from a prompt list.

**Prerequisites:** comfortable with `fetch` or `curl`. Examples use Node.js 18+ (built-in `fetch`), but any language with an HTTP client works the same way.

---

## The flow in one picture

```
POST /api/forge          { prompt, tier }     →  { job_id, status: "queued" }
GET  /api/forge?job=ID   (poll every few s)   →  { status: "running", backend: "..." }
GET  /api/forge?job=ID                        →  { status: "done", glb_url: "https://..." }
GET  glb_url                                  →  your model
```

One wrinkle worth knowing up front: on the fast free lane the first response can already be `status: "done"` with a `glb_url` — no polling needed. Handle both cases and you're done.

---

## Step 1 — Generate from a prompt

```bash
curl -s https://three.ws/api/forge \
  -H 'content-type: application/json' \
  -d '{"prompt": "a glazed ceramic teapot", "tier": "draft"}'
```

Response (async case):

```json
{
  "job_id": "…",
  "creation_id": "…",
  "status": "queued",
  "mode": "text_to_3d",
  "tier": "draft",
  "backend": "…",
  "eta_seconds": 13
}
```

The request body:

| Field | Type | Notes |
|-------|------|-------|
| `prompt` | string | The object description, 3–1000 chars. Same [prompt rules](/tutorials/prompts-for-3d) as the UI. |
| `tier` | `"draft"` \| `"standard"` \| `"high"` | Polygon budget + textures. Defaults to `standard`. High adds PBR materials. |
| `aspect_ratio` | `"1:1"` \| `"4:3"` \| `"3:4"` \| `"16:9"` \| `"9:16"` | Shape of the intermediate reference image. Optional. |
| `image_urls` | string[] | 1 to 6 public HTTPS image URLs for photo→3D (Step 4). Omit for text→3D. |
| `backend` | string | Pin a specific engine from the catalog (Step 5). Optional — the Forge picks for you. |

`draft` and `standard` are free. `high` on the platform engines is gated: it unlocks for $THREE holders (Bronze tier, $25 held), and a non-holder gets a `402` with hold-or-pay instructions (pay $THREE per generation, or sign in and spend prepaid credits via `pay_with: "credits"`). Bring-your-own-key engines skip the gate. Agents that would rather pay in USDC per call should use the x402 twin in Step 6, where `high` is a flat $0.50.

---

## Step 2 — Poll until done

```bash
curl -s 'https://three.ws/api/forge?job=JOB_ID'
```

While running you'll see:

```json
{ "job_id": "…", "status": "running", "backend": "…", "tier": "draft", "path": "text" }
```

Each poll echoes the job's provenance (`backend`, `tier`, `path`, and the view counts for photo jobs), so a caller that only polls still learns how the model is being made. When it completes:

```json
{ "job_id": "…", "status": "done", "glb_url": "https://three.ws/cdn/…" }
```

If `status` is `"failed"`, the response carries an `error` message — usually a prompt or quota problem you can act on.

---

## Step 3 — The whole thing as one script

```js
// generate.js — node generate.js "a glazed ceramic teapot"
import { writeFile } from 'node:fs/promises';

const BASE = 'https://three.ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateModel(prompt, tier = 'standard') {
  const submit = await fetch(`${BASE}/api/forge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, tier }),
  });
  let job = await submit.json();
  if (!submit.ok) throw new Error(job.message || job.error);

  // Fast lane: the model may already be done in the first response.
  while (job.status !== 'done') {
    if (job.status === 'failed') throw new Error(job.error);
    await sleep(4000);
    const poll = await fetch(`${BASE}/api/forge?job=${encodeURIComponent(job.job_id)}`);
    job = await poll.json();
    console.log(`  ${job.status}${job.backend ? ` (${job.backend})` : ''}`);
  }
  return job.glb_url;
}

const prompt = process.argv[2] || 'a glazed ceramic teapot';
console.log(`Generating: ${prompt}`);
const glbUrl = await generateModel(prompt, 'draft');
const glb = await fetch(glbUrl);
const file = `${prompt.replace(/\W+/g, '-').slice(0, 40)}.glb`;
await writeFile(file, Buffer.from(await glb.arrayBuffer()));
console.log(`Saved ${file}`);
```

Run it:

```bash
node generate.js "a low-poly treasure chest, iron-banded wood"
```

**Batch an asset pack** by looping prompts through `generateModel` one at a time. Keep it sequential: the endpoint is rate-limited per IP (about 60 free generations an hour), so a `Promise.all` over a hundred prompts will hit `429 rate_limited`. On a 429, wait and retry; it's a rolling window, not a ban.

---

## Step 4 — Photo → 3D from code

Two requests: get a presigned upload slot, `PUT` your image to it, then pass the returned public URL into the generate call.

```js
async function uploadImage(buffer, contentType = 'image/jpeg') {
  const presign = await fetch(`${BASE}/api/forge-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, size_bytes: buffer.byteLength }),
  });
  const slot = await presign.json();
  await fetch(slot.upload_url, { method: slot.method, headers: slot.headers, body: buffer });
  return slot.public_url;
}

// Then:
const url = await uploadImage(await readFile('front.jpg'));
// 1–4 views of the same object; more views = better reconstruction
const submit = await fetch(`${BASE}/api/forge`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image_urls: [url], tier: 'standard' }),
});
```

Photos are pre-checked by a vision model before any generation is spent; an unusable primary image comes back as a `422` with `error: "image_not_usable"`, an `issue` code, and a plain-language `message` (blurry, busy background, multiple objects). Pass `skip_validation: true` to override: the same as the UI's "Generate anyway" button (the response's `override` field spells this out). Flagged secondary views are silently dropped rather than failing the job. The [photo guidelines](/tutorials/image-to-3d) apply exactly as in the browser.

---

## Step 5 — Discover engines and pricing

The catalog endpoint is the live source of truth for what's available right now:

```bash
curl -s 'https://three.ws/api/forge?catalog'
```

It returns every backend (id, label, which paths it serves, whether it needs a bring-your-own key, ETA) and every tier with its polygon budget and price. Engines that need your own [Meshy](https://meshy.ai) or [Tripo](https://www.tripo3d.ai) key accept it per-request via the `x-forge-provider-key` header — it's used for that call and never stored.

---

## Step 6 — For autonomous agents: pay per call with x402

The public endpoint is rate-limited per IP, which is fine for scripts and prototyping. Agents that need guaranteed, metered capacity can use the paid twin at `POST /api/x402/forge`, same request body, billed per generation in USDC on Solana over the [x402 protocol](https://www.x402.org):

| Tier | Price per generation |
|------|---------------------|
| Draft | $0.05 |
| Standard | $0.15 |
| High | $0.50 |

The flow is standard x402: the first call returns a `402` with payment instructions, your x402 client settles it, and the retried call returns `{ job_id, poll_url }` — then you poll exactly as in Step 2. Retries with the same payment are idempotent, so a network hiccup never double-charges. A bare `GET /api/x402/forge` returns the current price list.

If you've never made an x402 call, start with [Build a paid x402 endpoint](/tutorials/paid-x402-endpoint), which covers the client side too.

---

## Troubleshooting

| Response | Meaning | Fix |
|----------|---------|-----|
| `429 rate_limited` | Per-IP hourly window exhausted (about 60 free generations an hour) | Back off and retry; keep batches sequential |
| `422 image_not_usable` | Photo failed the vision pre-check | Reshoot per the `message`, or send `skip_validation: true` |
| `402` on `tier: "high"` | High tier is hold-or-pay on platform engines | Hold $THREE (Bronze), pay per generation, use credits, or use the x402 endpoint |
| `status: "failed"` mid-job | Upstream generation error | Read `error`; retry once — transient provider errors happen |
| `glb_url` 404s later | You waited a long time to download | Download promptly after `done`; re-fetch the job for a fresh URL |

---

## What's next

- [Prompt Recipes for 3D Generation](/tutorials/prompts-for-3d) — feed better prompts into your batch script.
- [Turn Photos into a 3D Model](/tutorials/image-to-3d) — what makes reconstruction photos good.
- [Upload a custom GLB avatar](/tutorials/upload-custom-glb) — use your generated models as agent bodies.
- [API Reference](/docs/api-reference) — the rest of the platform's HTTP surface.
