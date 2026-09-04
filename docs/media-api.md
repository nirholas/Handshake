# three.ws Media & Render API

Free media endpoints for agents and apps built around three.ws 3D assets:
server-side avatar rendering, runtime GLB optimization, a CORS-open model
proxy, image understanding, speech-to-text, the curated asset libraries, and
the photo-input and mesh-processing front doors. Most endpoints here are
public and keyless; the two that write to an account say so explicitly.

This page is the companion to the [3D API](./3d-api.md), which documents the
core free text-to-3D lane (`/api/3d/generate`), model inspection, and the paid
Forge Pro tiers. Nothing on that page is repeated here: generate a model
there, then render it, optimize it, proxy it, describe it, or save it with the
endpoints below.

Base URL: `https://three.ws`

| Endpoint | Method | Auth | What it does |
|----------|--------|------|--------------|
| [`/api/avatar/render`](#render-an-avatar-as-an-image) | GET | none | Rendered PNG/JPEG/WebP of any public avatar |
| [`/api/render/avatar-clip`](#render-any-glb-posed-and-camera-orbited) | GET, POST | none | Posed, camera-orbited PNG of any GLB |
| [`/api/avatar/optimize`](#optimize-a-glb-at-runtime) | GET | none | Runtime GLB transcoder (LOD, textures, morphs, Draco) |
| [`/api/glb`](#same-origin-glb-proxy) | GET | none | Same-origin GLB proxy with open CORS |
| [`/cdn/<key>`](#how-bucket-objects-are-served-cdnkey) | GET, HEAD | none | First-party CDN for bucket objects |
| [`/api/vision`](#image-understanding) | GET, POST | none | Ask a vision model about an image |
| [`/api/asr`](#speech-to-text) | GET, POST | none | Speech-to-text (voice in) |
| [`/api/avatars/library`](#character-library) | GET | none | Paginated manifest of rigged characters |
| [`/api/objects/library`](#object-library) | GET | none | Paginated manifest of CC0 props |
| [`/api/avatars/from-forge`](#save-a-generated-glb-into-your-library) | POST | session or bearer | Save a generated GLB as your avatar |
| [`/api/input-photo`](#photo-to-avatar) | POST | none | Vision-validated photo-to-avatar submission |
| [`/api/input-multiview`](#multi-view-reconstruction) | POST | none | Vision-validated multi-image reconstruction |
| [`/api/forge-segment`](#split-a-glb-into-named-parts) | GET, POST | none | Split a GLB into named parts (async job) |
| [`/api/forge-rembg`](#background-removal) | GET, POST | none | Image background removal (async job) |

---

## Render an avatar as an image

**`GET /api/avatar/render`** returns a rendered PNG, JPEG, or WebP of any
public or unlisted three.ws avatar. Built for `<img>` tags, social cards,
partner integrations, and game engine loaders: point an image tag at the URL
and it just works.

Calling it with **no parameters** returns a self-describing JSON document:
every parameter, the scene presets, and the full pose catalog. That response
is the machine-readable source of truth for this endpoint.

### Query parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `avatar` | uuid | required | Avatar ID. Omit it to get the self-describing JSON instead. |
| `scene` | enum | `upper-body` | Camera framing: `full-body`, `upper-body`, `portrait`, `headshot`. |
| `size` | integer | `512` | Square dimension in pixels, 64 to 2048. |
| `width` | integer | | Overrides `size` for width (64 to 2048). |
| `height` | integer | | Overrides `size` for height (64 to 2048). |
| `bg` | string | `transparent` | CSS color or `transparent`. |
| `pose` | string | | Pose preset ID. Catalog: `GET /api/render/avatar-clip`. |
| `expression` | json | | URL-encoded ARKit-52 morph map, e.g. `{"mouthSmile":0.6}`. |
| `format` | enum | `png` | `png`, `jpeg`, or `webp`. |
| `quality` | integer | `90` | 1 to 100, for `jpeg`/`webp`. |

### Response

The first request for a given parameter combination renders via headless
chromium + three.js and returns the image bytes directly
(`x-render-cache: miss`, plus `x-render-scene` and `x-render-size` headers).
The result is cached in object storage keyed on avatar ID, the parameter hash,
and the avatar's `updated_at`, so editing the avatar busts the cache
automatically. Subsequent requests answer `302` to the CDN copy
(`x-render-cache: hit`). Both outcomes are correct behind an `<img src>`.

### Errors

| Situation | Response |
|-----------|----------|
| Invalid parameter | `400` with a specific code |
| Avatar does not exist | `404 not_found` |
| Avatar is private | `403 private` (only public or unlisted avatars render) |
| Over 120 renders per 10 minutes per IP | `429` with `Retry-After` |
| Render pipeline failed | `502 render_failed` |

### curl

```bash
# Discover the parameters, scenes, and pose catalog
curl -s https://three.ws/api/avatar/render

# The avatar id below is Michelle, a public featured avatar, so these run as-is.
# Swap in your own id from GET https://three.ws/api/avatars/featured or /avatars/<id>.

# Render a 256px transparent portrait
curl -sL -o portrait.png \
  'https://three.ws/api/avatar/render?avatar=13f259c7-7024-4d68-b1f0-dbbf52c06209&scene=portrait&size=256&bg=transparent'

# Waving, smiling, as WebP
curl -sL -o card.webp \
  'https://three.ws/api/avatar/render?avatar=13f259c7-7024-4d68-b1f0-dbbf52c06209&pose=wave&expression=%7B%22mouthSmile%22%3A0.6%7D&format=webp'
```

---

## Render any GLB, posed and camera-orbited

**`POST /api/render/avatar-clip`** renders a PNG of any public GLB with an
optional pose preset, a free camera orbit, and ARKit-52 facial morphs. Where
`/api/avatar/render` takes a three.ws avatar ID, this endpoint takes a raw GLB
URL, so it works on models that were never saved as avatars.

**`GET /api/render/avatar-clip`** (no body) returns the pose catalog: every
preset's `id`, `label`, and `group` (examples: `tpose`, `apose`, `wave`,
`salute`, `run`, `sit-chair`, `thinker`, `superhero-landing`), plus the
`cameraOrbit` and `background` value ranges. Fetch it once instead of
hardcoding pose IDs.

### Request body (JSON)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `glbUrl` | string | required | Public http(s) URL of the GLB, max 10 MB. SSRF-guarded: private hosts are rejected. |
| `width` | integer | `1024` | 64 to 2048. |
| `height` | integer | `1024` | 64 to 2048. |
| `background` | string | `#0a0a0a` | Any CSS color, or `transparent`. |
| `posePresetId` | string | | A pose ID from the GET catalog. Unknown IDs return `400 unknown_pose`. |
| `cameraOrbit` | object | | `{ theta, phi, radius }`. `theta` 0..360 degrees (yaw), `phi` 0..180 degrees (pitch from top, default 80), `radius` in meters or `null` to auto-frame. |
| `expression` | object | | ARKit-52 morph map, e.g. `{ "jawOpen": 0.4, "mouthSmileLeft": 0.6 }`. |

### Response

`200` with `image/png` bytes. Headers report what was rendered:
`x-render-width`, `x-render-height`, `x-render-background`, and, when a pose
was applied, `x-render-pose` and `x-render-pose-label`.

### Errors

| Situation | Response |
|-----------|----------|
| Missing/non-public `glbUrl` | `400 bad_request` |
| Unknown pose preset | `400 unknown_pose` (GET the endpoint for the catalog) |
| Over 60 renders per 10 minutes per IP | `429` with `Retry-After` |
| Fetch or render failed | `502 render_failed` |

### curl

```bash
# Pose catalog
curl -s https://three.ws/api/render/avatar-clip

# Render a rigged model waving, orbited 30 degrees, on transparent
curl -s -X POST https://three.ws/api/render/avatar-clip \
  -H 'content-type: application/json' \
  -d '{
    "glbUrl": "https://three.ws/avatars/cesium-man.glb",
    "posePresetId": "wave",
    "cameraOrbit": { "theta": 30, "phi": 80, "radius": null },
    "background": "transparent"
  }' -o wave.png
```

---

## Optimize a GLB at runtime

**`GET /api/avatar/optimize`** returns a re-encoded variant of a
three.ws-hosted GLB tuned for the caller's hardware budget. The pipeline is
lossless or near-lossless (dedup, prune, weld, texture downscale to WebP), so
one source GLB can serve mobile WebGL, desktop WebGL, and VR runtimes without
per-platform asset duplication.

### Query parameters

Provide exactly one of `src` or `id`; the rest are optional.

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `src` | url | | Source GLB. Must be on a three.ws-controlled origin (the app origin or the CDN host); anything else is `400 untrusted_source`. |
| `id` | uuid | | A three.ws avatar ID. Only public or unlisted avatars resolve; private ones return `404`. |
| `lod` | enum | `0` | `0` = source, `1` = conservative weld/dedup, `2` = more aggressive weld. |
| `textureSize` | enum | `2048` | Max texture edge: `128`, `256`, `512`, `1024`, or `2048`. Larger textures are downscaled and re-encoded as WebP. |
| `morphs` | enum | `all` | `arkit52` drops every morph target not in the ARKit-52 standard set (plus canonical aliases and visemes); `all` keeps everything. |
| `draco` | flag | off | `draco=1` *prefers* `KHR_draco_mesh_compression`, and the client then needs a Draco decoder. It is applied only when it actually shrinks the file (see the size contract below). |

### Response

`200` with `model/gltf-binary` bytes, cached immutably (30 days in the
browser, 1 year at the edge, keyed on the full URL).

### Size contract

The endpoint never returns more bytes than it was given unless you asked for a
change that genuinely alters the model. Stored three.ws avatars are already
quantized and meshopt-packed, so layering Draco on top of that can easily make a
file bigger; when it does, the endpoint keeps the better encoding (or hands back
the original bytes) instead of honouring the flag into a worse result. The
output declares **at most one** mesh-compression scheme, never Draco and meshopt
together. Four response headers say exactly what happened, and all four are
listed in `access-control-expose-headers` so browser `fetch()` can read them:

| Header | Meaning |
|--------|---------|
| `x-three-ws-source-bytes` | Size of the source GLB. |
| `x-three-ws-output-bytes` | Size of the body you received. |
| `x-three-ws-optimize` | What the body is: `draco`, `meshopt`, `none` (no mesh compression), or `source` (the original bytes, returned unchanged because nothing the pipeline produced was smaller). |
| `x-three-ws-optimize-refused` | `draco` when `draco=1` was requested and dropped because it grew the file. Absent otherwise. |

The one case where the output may exceed the source is a request that really
changed the model: a `lod` that collapsed vertices, a `morphs=arkit52` that
dropped morph targets, or a `textureSize` that downscaled a texture. There you
asked for different content, so you get it, and the byte headers still report
the exact cost.

### Errors

| Situation | Response |
|-----------|----------|
| Missing `src` and `id`, or invalid `lod`/`textureSize`/`morphs` | `400 invalid_request` |
| `src` not on a three.ws origin | `400 untrusted_source` |
| Avatar/upstream not found | `404 source_not_found` |
| Source over 50 MB | `413 too_large` |
| Upstream fetch failed | `502 upstream_unreachable` |
| Transcode pipeline threw | `500 transcode_failed` |

Requests are rate-limited per IP; a `429` carries `Retry-After`.

### curl

```bash
# Mobile budget: 512px textures, ARKit-52 morphs only
curl -sL -o mobile.glb \
  'https://three.ws/api/avatar/optimize?id=13f259c7-7024-4d68-b1f0-dbbf52c06209&textureSize=512&morphs=arkit52'

# By source URL, LOD 1
curl -sL -o lite.glb \
  'https://three.ws/api/avatar/optimize?src=https%3A%2F%2Fthree.ws%2Favatars%2Fcesium-man.glb&lod=1'

# Add Draco geometry compression. Smaller bytes, but the client then needs a
# Draco decoder, so only add it when you know the consumer has one.
curl -sL -o mobile-draco.glb \
  'https://three.ws/api/avatar/optimize?id=13f259c7-7024-4d68-b1f0-dbbf52c06209&textureSize=512&draco=1'
```

If `draco=1` comes back `500 transcode_failed` with `draco.createCompressedPrimitive is not a function`, that is a server-side codec problem and not something wrong with your request: the running image resolved an older glTF-transform than the one this repo pins, whose Draco writer expects a different encoder interface. Every other parameter still works, so drop `draco=1` to get your model now. A rebuild picks up the pinned version and restores it.

---

## Same-origin GLB proxy

**`GET /api/glb?src=<url>`** streams any public GLB back with
`access-control-allow-origin: *`.

### When you need it, and when you do not

It depends entirely on which host serves the `.glb`, not on which origin you
are loading from. Re-measured 2026-09-04, unchanged since 2026-08-01:

| Source host | Cross-origin fetch | Use the proxy? |
|---|---|---|
| `https://three.ws/...` (built-in library avatars, `/avatars/*`, anything under the site) | `access-control-allow-origin: *` on every origin | No. Fetch it directly. |
| `https://three.ws/cdn/<key>` (the same bucket objects, served first-party) | `access-control-allow-origin: *` on every origin | No. Fetch it directly, and prefer this over the proxy. |
| `https://pub-*.r2.dev/...` (the media bucket's own host: user-generated avatars, forge output, character-library GLBs, the target of `/api/avatar/render`'s `302`) | Header only for origins on the bucket allowlist (`three.ws`, `*.vercel.app`, `localhost:3000`). Every other origin gets a `200` with no `access-control-allow-origin`, so the browser discards the bytes. | Yes, or rewrite the URL to `/cdn/<key>`. |

So a `<model-viewer>` embed on a partner site, a Jupyter/Colab notebook, a
Codespaces preview, or a Vite dev server on `localhost:5173` can read
`three.ws` URLs directly but needs the proxy for `pub-*.r2.dev` URLs.

Two ways out of a bucket URL, and they are not equivalent:

- **[`/cdn/<key>`](#how-bucket-objects-are-served-cdnkey)** is the cheaper one
  when you have the object key (everything after the bucket host). Same bytes,
  first-party, CORS-open, and CDN-cached for 30 days at the edge.
- **`/api/glb?src=<url>`** is the one to reach for when all you have is a URL
  someone handed you, including a URL on a host that is not ours at all. It is
  always safe: passing it a `three.ws` URL costs one extra hop on a cold CDN
  cache and nothing after.

The bucket allowlist is the deliberate part for uploads (presigned `PUT`s stay
origin-locked) and an accident for reads, which are meant to be world-open.
`scripts/set-r2-cors.mjs` holds the corrected policy and
`node scripts/set-r2-cors.mjs --probe` measures what is live from any machine,
with no bucket credentials; see [`scripts/README.md`](../scripts/README.md).
Even once reads are world-open, both first-party paths stay the right answer for
callers that want one URL shape and no dependency on a third-party host's
headers.

Safe by construction: upstream objects are already public and keyless, and
the fetch runs through the SSRF-hardened fetcher (scheme allowlist, DNS
pinning, private-IP blocklist, redirect re-validation, byte cap, timeout).
The response is always declared `model/gltf-binary` with `nosniff`,
`content-security-policy: default-src 'none'; sandbox`, and
`cross-origin-resource-policy: cross-origin`, so bytes fetched from a remote
host can never be interpreted as a document on the `three.ws` origin.

### Query parameters

| Param | Type | Notes |
|-------|------|-------|
| `src` | url | Required. Public http(s) URL of a `.glb`. `url=` is accepted as an alias. |

### Response

`200` with `model/gltf-binary` bytes, cached immutably (generated GLBs are
content-addressed, so a given `src` never changes bytes). Max 30 MB, 20 s
upstream timeout, rate-limited per IP.

### Errors

| Situation | Response |
|-----------|----------|
| Missing or non-http(s) `src` | `400 bad_request` |
| Blocked target (`invalid_url`, `scheme_not_allowed`, `private_address`, `host_pin_mismatch`) | `400` with that code |
| Upstream over 30 MB | `413 file_too_large` |
| Upstream fetch failed | `502 fetch_failed` |

### curl

```bash
curl -sL -o model.glb \
  'https://three.ws/api/glb?src=https%3A%2F%2Fthree.ws%2Favatars%2Fcesium-man.glb'
```

---

## How bucket objects are served (`/cdn/<key>`)

Every generated asset (avatars, forge output, thumbnails, posters, manifests)
is reachable two ways: from the media bucket's own host, and from
**`GET https://three.ws/cdn/<key>`**, which streams the same object through the
site. The first-party path exists because the bucket's public dev host is
rate-limited, and a gallery loading dozens of thumbnails at once gets throttled
there. Both URLs return identical bytes; the `/cdn` one is CDN-cached and
CORS-open (`access-control-allow-origin: *`), so it works from any origin
without the proxy above.

Because that path puts bucket content on the same origin as the app, the
response is pinned to data rather than a document:

| Rule | Effect |
|---|---|
| The `Content-Type` comes from the object key's extension | Every write path chooses the extension server-side from an allowlist, so an upstream provider's `Content-Type` header can never decide what `three.ws` serves. A stored type is honored only when the extension is unrecognized, and only if it is itself a media type. |
| Anything not safe to render inline is sent `content-disposition: attachment` | Images (except SVG), glTF/GLB, USDZ, audio, video, and JSON render inline. SVG and unknown types download instead of rendering. |
| Every response carries `content-security-policy: default-src 'none'; sandbox` and `x-content-type-options: nosniff` | Anything that does reach a top-level navigation lands in an opaque origin, so it cannot script against `three.ws` or read its storage. |

None of this affects normal use: `<img>`, `<model-viewer>`, `<video>`, and
`fetch()` are subresource loads, which ignore `content-disposition` entirely.
An SVG thumbnail still renders through `<img>`; what it can no longer do is
open as a page on the site's origin.

---

## Image understanding

**`POST /api/vision`** asks a vision model a question about an image and
returns plain text. The same capability powers Forge upload checks and
gallery alt text internally; this is the public HTTP surface. Free-first
provider chain with a paid backstop; the response tells you which provider
answered.

**`GET /api/vision`** is a capability probe:
`{ configured, imageTypes }`. Use it to decide whether to offer
describe/critique affordances before uploading anything.

### Request

Two transports:

| Transport | How |
|-----------|-----|
| Raw bytes | Body is the image; `Content-Type` must be `image/jpeg`, `image/png`, `image/webp`, or `image/gif`. Max 12 MB. |
| JSON | `{ "image": "<base64 or data URI>", "imageUrl": "...", "prompt": "...", "maxTokens": 512, "imageType": "image/png" }`. Provide `image` or `imageUrl` (a public https URL; SSRF-guarded). `imageType` labels a bare base64 `image` when it is not a data URI. |

`prompt` and `maxTokens` can also ride as query parameters on either
transport. `prompt` defaults to a concise two-sentence description and is
capped at 2000 characters; `maxTokens` is clamped to 16..2048 (default 512).

Rate limits are per user when signed in (session cookie or bearer token) and
per IP otherwise; signing in raises the budget.

### Response

```json
{ "text": "A low-poly bronze knight in a T-pose, brushed-metal armor...", "provider": "nvidia", "model": "..." }
```

### Errors

| Situation | Response |
|-----------|----------|
| No image in the request | `400 bad_request` |
| Unsupported raw `Content-Type` | `415 unsupported_media_type` |
| Image over 12 MB | `413 payload_too_large` |
| Bad `imageUrl` | `400 invalid_image_url` |
| No vision provider configured | `503 not_configured` |
| All providers failed | `502` with the upstream code |

### curl

```bash
# Capability probe
curl -s https://three.ws/api/vision

# Raw bytes with a custom question
curl -s -X POST 'https://three.ws/api/vision?prompt=What%20object%20is%20this%3F' \
  -H 'content-type: image/png' \
  --data-binary @render.png

# By URL
curl -s -X POST https://three.ws/api/vision \
  -H 'content-type: application/json' \
  -d '{"imageUrl":"https://three.ws/logo.png","prompt":"Describe this image in one sentence."}'
```

---

## Speech-to-text

**`POST /api/asr`** transcribes a spoken utterance. It is the voice-in
companion to `POST /api/tts/speak` (voice out), and exists so users can talk
to an avatar with a real cross-browser recognizer instead of the Chrome-only
`webkitSpeechRecognition`. The lane is NVIDIA Riva ASR; there is deliberately
no paid backstop, so when it is unconfigured clients keep their browser
fallback.

**`GET /api/asr`** is a capability probe:
`{ configured, encodings, sampleRate }`. `sampleRate` is `16000`, the Riva
acoustic-model rate clients should downsample to.

### Request

Two transports, max 8 MB of audio either way:

| Transport | How |
|-----------|-----|
| Raw bytes | Body is the audio; `Content-Type` picks the codec: `audio/wav` (header parsed, rate taken from the file), `audio/pcm` or `audio/L16` (raw 16-bit LE PCM; set `?rate=`), `audio/flac`, `audio/ogg` (Opus). WebM/Opus is rejected with `415`: decode it to PCM/WAV client-side first. |
| JSON | `{ "audio": "<base64>", "format": "wav", "language": "en-US", "sampleRate": 16000, "words": true, "model": "..." }`. `format` is one of `wav`, `pcm`, `flac`, `ogg` (default `wav`). |

Query parameters work on either transport: `language` (BCP-47, default
`en-US`), `rate` (PCM sample rate; defaults to 16000 when the audio does not
declare one), `words=1` (word-level timestamps), `model` (override the Riva
model name).

Rate limits mirror `/api/vision`: per user when signed in, per IP otherwise.

### Response

```json
{ "text": "make the avatar wave", "confidence": 0.94, "language": "en-US", "model": "...", "durationSec": 1.8 }
```

With `words=1` the response adds a `words` array of word-level timestamps.

### Errors

| Situation | Response |
|-----------|----------|
| Unsupported audio `Content-Type` (including WebM) | `415 unsupported_media_type` |
| Audio over 8 MB | `413 payload_too_large` |
| No audio bytes | `400 bad_request` |
| Riva rejected the input | `400 invalid_argument` |
| Lane not configured | `503 not_configured` |
| Upstream failure | `502 provider_error` |

### curl

```bash
# Capability probe
curl -s https://three.ws/api/asr

# Transcribe a WAV with word timestamps
curl -s -X POST 'https://three.ws/api/asr?words=1' \
  -H 'content-type: audio/wav' \
  --data-binary @speech.wav
```

---

## Character library

**`GET /api/avatars/library`** returns the curated rigged character library:
professionally rigged humanoid GLBs (Y Bot, X Bot, Warrok, Remy, zombies,
knights, plus CC0 sets like Quaternius and KayKit). Every GLB carries a
skeleton, skin weights, and textures, so it drops straight into the pose
studio, widget studio, or embed viewer and drives the whole canonical
animation clip library via retargeting. No auth, no key.

The GLBs live on the CDN; this endpoint serves a small manifest whose entries
carry absolute CDN URLs the browser loads directly (CDN CORS allows GET from
web origins).

### Query parameters

Pagination is opt-in and backward compatible:

| Param | Type | Notes |
|-------|------|-------|
| `limit` | integer | 1 to 1000. Omit it entirely to get the whole library in one response. |
| `offset` | integer | Starting index, default 0. Only meaningful with `limit`. |

### Response

```json
{
  "avatars": [
    {
      "name": "y-bot",
      "label": "Y Bot",
      "url": "https://<cdn>/avatars/mixamo/glb/y-bot.glb",
      "thumb": "https://<cdn>/avatars/mixamo/thumbs/y-bot.png",
      "bytes": 3145728,
      "skins": 1,
      "animations": 1,
      "source": "mixamo",
      "license": "Mixamo"
    }
  ],
  "total": 107,
  "generated_at": "2026-07-01T00:00:00.000Z"
}
```

`thumb` is present when a thumbnail has been rendered. With `limit` the
response adds `offset` and `next_offset` (`null` on the last page); `total`
is always the full library size. Before the manifest is staged the endpoint
returns `{ "avatars": [], "total": 0 }`, so feature-detect by emptiness, not
by error handling. Responses are edge-cached for 5 minutes.

### curl

```bash
# Whole library
curl -s https://three.ws/api/avatars/library

# Page of 24
curl -s 'https://three.ws/api/avatars/library?limit=24&offset=0'
```

---

## Object library

**`GET /api/objects/library`** is the same manifest pattern for the CC0 3D
prop library: free, commercial-OK objects (Poly Haven and other CC0 sources)
staged as web-ready GLBs. Same pagination (`?limit=1..1000`, `?offset=`),
same empty-until-staged behavior, no auth. One difference from the character
library: this endpoint validates the cursors strictly, so a malformed
`?limit`/`?offset` returns `400 invalid_limit` / `400 invalid_offset` instead
of being coerced into a page. The manifest is served with
`access-control-allow-origin: *`, so a studio embedded on another origin can
render the object tray from it (the objects themselves already load cross-origin
through `/cdn/<key>`). See [the object library doc](./object-library.md)
for the full parameter table.

### Response

```json
{
  "objects": [
    {
      "name": "wooden-crate",
      "label": "Wooden Crate",
      "url": "https://<cdn>/objects/polyhaven/glb/wooden-crate.glb",
      "thumb": "https://<cdn>/objects/polyhaven/thumbs/wooden-crate.png",
      "bytes": 1048576,
      "categories": ["props"],
      "tags": ["wood", "container"],
      "license": "CC0",
      "source": "polyhaven"
    }
  ],
  "total": 511,
  "generated_at": "2026-07-01T00:00:00.000Z"
}
```

With `limit`, the response adds `offset` and `next_offset` exactly like the
character library.

### curl

```bash
curl -s 'https://three.ws/api/objects/library?limit=12'
```

---

## Save a generated GLB into your library

**`POST /api/avatars/from-forge`** saves a generated GLB (by URL) straight
into the caller's avatar library, server-side. This is the durable end of the
text-to-3D-avatar pipeline: forge a mesh (see the [3D API](./3d-api.md)), rig
it, then hand the final URL here. Doing the copy server-side sidesteps
cross-origin reads of provider URLs and browser upload caps, and routes
through the same avatar-creation path as a normal upload, so the result is a
first-class avatar with its own agent.

**Auth required**: a signed-in session cookie, or a bearer token carrying the
`avatars:write` scope. Everything else on this page is public; this endpoint
writes to your account.

### Request body (JSON)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `glb_url` | string | required | Public https URL of the GLB. SSRF-guarded; max 64 MB. |
| `name` | string | required | Avatar name, 1 to 80 characters. |
| `visibility` | enum | `unlisted` | `public`, `unlisted`, or `private`. |
| `source_prompt` | string | | The prompt that generated it, kept as provenance (max 1000 chars). |
| `rigged` | boolean | | Provenance only. The server inspects the GLB itself for the real rig state; this flag never decides anything. |
| `tags` | string[] | | Up to 20 organizing tags. |

The server fetches the GLB, validates the binary glTF header, copies it into
your storage namespace, registers the avatar, provisions its agent, and, when
the mesh arrived static, queues an auto-rig so the avatar can animate.

### Response

`201` with `{ "avatar": { ... }, "view_url": "https://three.ws/avatars/<id>" }` (the avatar detail page, the canonical link target across the platform).

### Errors

| Situation | Response |
|-----------|----------|
| Not signed in / missing scope | `401 unauthorized` |
| Missing `glb_url` or `name` | `400 invalid_request` |
| Non-public or non-https URL | `400 invalid_url` |
| URL did not return a valid GLB | `422 invalid_glb` |
| GLB over 64 MB | `413 payload_too_large` |
| Upstream fetch failed | `502 fetch_failed` |
| Too many saves | `429 rate_limited` with `Retry-After` |

### curl

```bash
curl -s -X POST https://three.ws/api/avatars/from-forge \
  -H 'authorization: Bearer YOUR_TOKEN' \
  -H 'content-type: application/json' \
  -d '{
    "glb_url": "https://three.ws/cdn/forge/anon/a1b2c3d4.glb",
    "name": "Bronze Knight",
    "visibility": "public",
    "source_prompt": "a bronze knight in ornate armor",
    "tags": ["knight", "fantasy"]
  }'
```

---

## Photo to avatar

**`POST /api/input-photo`** is the vision-validated front door for turning a
photo into an avatar. It checks that the image actually contains a face (so a
landscape or a text screenshot fails fast with guidance instead of burning a
generation slot), then submits it to the forge pipeline as an
image-conditioned generation with an avatar-optimized prompt, ready for
auto-rigging. No auth; rate-limited per IP on the generation bucket.

**Privacy is transient by default.** The source photo is never stored in the
creation log unless you set `privacy_opt_in: true`, and when you pass the
`storage_key` from `/api/forge-upload`, the uploaded object is deleted from
storage as soon as the generation job is created. No image bytes are written
to application logs.

### Request body (JSON)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `image_url` | string | required | Public https URL of the photo, max 2048 characters. |
| `storage_key` | string | | The storage key returned by `/api/forge-upload`, enabling the transient delete. |
| `privacy_opt_in` | boolean | `false` | `true` keeps the photo as the creation's preview image. |
| `tier` | enum | `standard` | `draft`, `standard`, or `high`. |
| `skip_face_check` | boolean | `false` | Bypass the face-presence gate (for stylized or partial inputs). |

### Response

`200` with the forge job fields (`job_id`, `creation_id`, and the rest of the
standard `/api/forge` submission response) plus:

```json
{
  "mode": "photo_to_avatar",
  "auto_rig": true,
  "privacy_retained": false,
  "privacy_note": "Your photo was processed transiently and was not stored. ..."
}
```

Poll the job on `/api/forge?job=<job_id>` like any forge generation.

### Errors

| Situation | Response |
|-----------|----------|
| Missing/invalid `image_url` | `400 invalid_image_url` |
| No face detected | `422 face_not_detected`, with a `reason` and an `override` hint (`skip_face_check: true`) |
| Generation service unreachable | `502 generation_unreachable` |
| Forge rejected the submission | Forge's own status and error code, passed through |
| Rate limit | `429` with `Retry-After` |

When the vision lane is unconfigured or errors, the face check fails open and
the submission proceeds; forge still validates the image. The hand-off to
`/api/forge` is bounded to 30 seconds and is deliberately never retried, since
that POST enqueues a generation and a replay would queue (and bill) a second
job; a hang there surfaces as `502 generation_unreachable` rather than an
endpoint that never answers.

### curl

```bash
curl -s -X POST https://three.ws/api/input-photo \
  -H 'content-type: application/json' \
  -d '{"image_url":"https://three.ws/avatars/thumbs/default.png","tier":"standard"}'
```

---

## Multi-view reconstruction

**`POST /api/input-multiview`** accepts 2 to 6 photos of one object from
different angles, validates each with vision (clear subject? in focus? not a
text screenshot?), and submits them to the forge pipeline as a multi-view
reconstruction job. The validation step catches mismatched images and blank
uploads before a generation slot is spent. Same transient-by-default privacy
policy as `/api/input-photo`. No auth; rate-limited per IP.

### Request body (JSON)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `image_urls` | string[] | required | 2 to 6 public https URLs, each max 2048 characters. Extras beyond 6 are dropped. |
| `storage_keys` | string[] | | Storage keys from `/api/forge-upload`, deleted after submission unless opted in. |
| `prompt` | string | | Optional guidance text, max 1000 characters. |
| `tier` | enum | `standard` | `draft`, `standard`, or `high`. |
| `privacy_opt_in` | boolean | `false` | `true` keeps the photos as preview images. |
| `skip_validation` | boolean | `false` | Bypass the per-image vision check. |

### Response

`200` with the forge job fields plus a per-image `validation` array,
`privacy_retained`, and `privacy_note`:

```json
{
  "job_id": "f1.eyJ...",
  "validation": [
    { "url": "https://example.com/front.jpg", "index": 0, "ok": true, "subject": "ceramic robot figurine" },
    { "url": "https://example.com/back.jpg", "index": 1, "ok": true, "subject": "ceramic robot figurine" }
  ],
  "privacy_retained": false,
  "privacy_note": "Your photos were processed transiently and were not stored. ..."
}
```

### Errors

| Situation | Response |
|-----------|----------|
| Fewer than 2 usable URLs | `400 too_few_images` |
| One or more images failed validation | `422 invalid_views`, with the full `validation` array (each failure carries an `issue` such as `no_subject`, `text_screenshot`, `too_dark_or_blurry`, or `abstract_or_diagram`, and an actionable `message`) plus an `override` hint (`skip_validation: true`) |
| Generation service unreachable | `502 generation_unreachable` |
| Rate limit | `429` with `Retry-After` |

As with `/api/input-photo`, the hand-off to `/api/forge` is bounded to 30
seconds and never retried, so the same photos can never be queued twice.

### curl

```bash
curl -s -X POST https://three.ws/api/input-multiview \
  -H 'content-type: application/json' \
  -d '{
    "image_urls": [
      "https://example.com/owl-front.jpg",
      "https://example.com/owl-side.jpg",
      "https://example.com/owl-back.jpg"
    ],
    "tier": "high"
  }'
```

---

## Split a GLB into named parts

**`POST /api/forge-segment`** splits a 3D model into named, addressable parts
(an async job: submit, then poll). Useful for turning a monolithic generated
mesh into components you can recolor, swap, or animate independently. No
auth; rate-limited per IP.

### Request body (JSON)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `mesh_url` | string | required | Public https URL of the GLB. SSRF-validated server-side. |
| `method` | enum | `auto` | `auto`, `connected` (connected components), or `crease` (split at hard edges). |
| `max_parts` | integer | `24` | 2 to 64. |
| `min_part_faces` | integer | `64` | 4 to 100000. Parts smaller than this are merged. |
| `crease_angle` | number | `40` | 5 to 170 degrees, for the `crease` method. |
| `only_part` | string | | Export just this part id or name (e.g. `part_03`). |

### Response

`202` with `{ "job_id": "...", "status": "queued", "method": "auto", "eta_seconds": 30 }`.

**`GET /api/forge-segment?job=<id>`** polls the job:

```json
{
  "job_id": "...",
  "status": "done",
  "result_url": "https://.../segmented.glb",
  "manifest_url": "https://.../parts.json",
  "parts": [ { "...": "one entry per part" } ],
  "part_count": 12,
  "source_faces": 48210,
  "method": "auto",
  "warnings": null,
  "error": null
}
```

Fields are `null` until the stage that produces them completes; on failure
`status` reflects it and `error` carries the reason.

### Errors

| Situation | Response |
|-----------|----------|
| Missing/non-public `mesh_url` | `400 invalid_mesh_url` |
| Malformed `?job=` | `400 invalid_job` (missing entirely: `400 missing_job`) |
| Worker not deployed on this environment | `503 unconfigured` |
| Worker rejected the job | `502 segment_failed` |
| Worker unreachable while polling | `502 segment_status_failed` |
| Rate limit | `429` with `Retry-After` |

A poll that answers `502 segment_status_failed` carries no `status` field, so a
polling client should keep polling: the worker was briefly unreachable, which is
not the same as the job dying.

### curl

```bash
# Submit
curl -s -X POST https://three.ws/api/forge-segment \
  -H 'content-type: application/json' \
  -d '{"mesh_url":"https://three.ws/avatars/cesium-man.glb","method":"auto","max_parts":16}'

# Poll
curl -s 'https://three.ws/api/forge-segment?job=JOB_ID'
```

---

## Background removal

**`POST /api/forge-rembg`** removes the background from an image (an async
job: submit, get `202`, poll). It exists for the forge pipeline (clean
subject cutouts reconstruct better), but it is a general-purpose endpoint. No
auth; rate-limited per IP.

### Request body (JSON)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `image_url` | string | required | Public https URL of the image. SSRF-validated server-side. |
| `model` | enum | `rmbg2` | `rmbg2`, `u2net`, `isnet`, `u2net_human_seg`, or `silueta`. |

### Response

`202` with `{ "job_id": "...", "status": "queued", "eta_seconds": 10 }`.

**`GET /api/forge-rembg?job=<id>`** polls the job:

```json
{ "job_id": "...", "status": "done", "result_url": "https://.../cutout.png", "error": null }
```

### Errors

| Situation | Response |
|-----------|----------|
| Missing/non-public `image_url` | `400 invalid_image_url` |
| Malformed `?job=` | `400 invalid_job` (missing entirely: `400 missing_job`) |
| Worker not deployed on this environment | `503 unconfigured` |
| Worker rejected the job | `502 rembg_failed` |
| Worker unreachable while polling | `502 rembg_status_failed` |
| Rate limit | `429` with `Retry-After` |

A poll that answers `502 rembg_status_failed` carries no `status` field, so a
polling client should keep polling: the worker was briefly unreachable, which is
not the same as the job dying.

### curl

```bash
# Submit
curl -s -X POST https://three.ws/api/forge-rembg \
  -H 'content-type: application/json' \
  -d '{"image_url":"https://three.ws/avatars/thumbs/default.png","model":"rmbg2"}'

# Poll
curl -s 'https://three.ws/api/forge-rembg?job=JOB_ID'
```

---

## Related

- [3D API](./3d-api.md) - the core free text-to-3D lane, model inspection, and the paid Forge Pro tiers
- [Image to 3D](./image-to-3d.md) - the photo-input reconstruction product these front doors feed
- [Voice Lab](./voice-lab.md) - voice cloning and synthesis, the other half of the avatar voice loop
- [API Reference](./api-reference.md) - the full three.ws HTTP API surface
