# Put a 3D Avatar in an `<img>` Tag

By the end of this tutorial you will be rendering live 3D avatars as ordinary images, from a URL, with no 3D engine anywhere in your stack. No three.js, no WebGL context, no GLB loader, no canvas. Just an `<img src>` that happens to point at a headless renderer.

![A PNG produced by the very endpoint this tutorial teaches. No WebGL ran to put it on this page; it is an ordinary image file that a headless renderer wrote.](figure:glb:/avatars/michelle.glb?w=1200&h=1000)

That unlocks the places WebGL cannot go: Open Graph and Twitter cards, transactional email, a Notion page, a PDF, a React Server Component, a Discord bot, a print sheet, an e-ink display, a Rust service that has no business booting a browser. Anywhere an image works, a posed and expressive 3D character now works too.

**What you'll build:**

- A profile image for any public three.ws avatar, in four camera framings, any size up to 2048px, any background including transparent
- Posed renders: the same avatar waving, meditating, or landing like a superhero, driven by a pose ID from a live catalog
- Facial expressions: ARKit-52 morph targets driven from the query string, so one avatar produces a whole sheet of emotions
- A social card that renders the avatar as its `og:image`
- The same trick for any GLB on the internet, including models that were never saved as three.ws avatars, with a free camera orbit
- A real client-side viewer on your own domain, using the CORS-open GLB proxy
- Cache behaviour you can reason about, and the two headers that tell you what happened

**Prerequisites:**

- `curl` and a text editor. That is the entire toolchain.
- No account, no API key, no auth handshake. Every endpoint here is public and keyless.
- Optional: the [Media & Render API reference](/docs/media-api.md) is the exhaustive parameter contract. This tutorial is the guided path through it.

Every command below is real and runs as written against production. The avatar IDs are public featured avatars.

---

## Step 1 - Ask the endpoint to describe itself

Call `/api/avatar/render` with no parameters and it returns its own documentation: every parameter with its type, range, and default; every camera preset with its actual spherical angles; and the full pose catalog.

```bash
curl -s https://three.ws/api/avatar/render | jq 'keys'
```

```json
["description", "endpoint", "example", "parameters", "poses", "scenes"]
```

(`jq 'keys'` sorts alphabetically. Use `jq 'keys_unsorted'` if you want the order the endpoint actually emits.)

That response is the machine-readable source of truth, which matters more than it sounds: it means a code generator, an LLM tool definition, or a build script never has to hardcode a list that can drift. Look at the camera presets:

```bash
curl -s https://three.ws/api/avatar/render | jq .scenes
```

```json
{
  "full-body":  { "phi": 80, "theta": 0 },
  "upper-body": { "phi": 82, "theta": 5 },
  "portrait":   { "phi": 84, "theta": 8 },
  "headshot":   { "phi": 86, "theta": 5 }
}
```

`phi` is pitch measured from straight down the top of the head, `theta` is yaw. The presets are not just crops: each one moves the camera, so a `headshot` has different perspective foreshortening than a cropped `full-body` would. That is why they look right instead of looking like zoomed screenshots.

And the poses:

```bash
curl -s https://three.ws/api/avatar/render | jq '.poses | length'
```

```
28
```

Grouped, the catalog is:

| Group | Pose IDs |
|---|---|
| Standing | `tpose`, `apose`, `relaxed`, `contrapposto`, `hands-up`, `wave`, `hands-on-hips`, `salute` |
| Action | `walk-step`, `run`, `jump`, `punch`, `archery`, `superhero-landing`, `fighting-stance` |
| Sitting & Floor | `sit-chair`, `sit-floor`, `kneel`, `crouch`, `thinker` |
| Expressive | `praying`, `meditate`, `warrior2`, `arabesque`, `flex`, `point`, `facepalm`, `bow` |

Fetch that list at build time rather than pasting it into your code. It grows.

---

## Step 2 - Pick a public avatar

You need an avatar ID (a UUID). The featured list is public:

```bash
curl -s https://three.ws/api/avatars/featured \
  | jq -r '.avatars[] | "\(.id)  \(.name)"' | head -8
```

```
81a076b6-55ff-49a2-b007-1d88e7dce2aa  ansem-with-animation
bea9f0b9-3442-4544-84df-912989e86211  Boss Vernington
4f00c120-b3af-4f2b-9e0c-f34a71df8d37  Boss Vernington
13f259c7-7024-4d68-b1f0-dbbf52c06209  Michelle
a4bad2f5-8a07-43cf-82e5-b6ba1314441e  Selfie Girl
9c192f82-059f-44b3-b21d-100583c743fd  LittlestTokyo
3cbc5b19-bb36-4658-a569-d0c2f7cb6dab  Horse
72bc0b6d-7888-4923-a532-16b0b4d7b58b  CZ
```

That list is live and its order changes as avatars are featured, so read it rather than pasting it. Two names can repeat with different IDs, because a name is a label and the UUID is the identity.

Two of those get used throughout this tutorial, and the difference between them is the single most important practical fact on this page:

| Avatar | ID | Rig | Morph targets |
|---|---|---|---|
| **Michelle** | `13f259c7-7024-4d68-b1f0-dbbf52c06209` | Full humanoid skeleton, poses beautifully | **Zero.** Expressions are silently ignored. |
| **Selfie Girl** | `a4bad2f5-8a07-43cf-82e5-b6ba1314441e` | Full humanoid skeleton | **63**, including the full ARKit-52 set |

Poses come from the skeleton. Expressions come from morph targets. A model can have one without the other, and asking for a facial expression on a model with no morph targets returns a perfectly valid `200` with a completely unchanged face. Step 4 covers how to tell before you waste an afternoon.

Only **public** and **unlisted** avatars render. A private one returns `403 private`; one that does not exist returns `404 not_found`. Your own avatars appear at `/agents/<id>`, and their IDs work here as soon as their visibility is public or unlisted.

---

## Step 3 - The `<img>` tag

This is the whole feature:

```html
<img
  src="https://three.ws/api/avatar/render?avatar=13f259c7-7024-4d68-b1f0-dbbf52c06209&scene=portrait&size=256"
  width="256"
  height="256"
  alt="Michelle, a 3D avatar, portrait framing"
/>
```

Paste it into any HTML file and open it. That is a real-time three.js render, produced server-side by headless chromium, arriving as 39KB of PNG.

The same thing from the command line, which is how you should verify anything before wiring it into a page:

```bash
curl -sL -o portrait.png \
  'https://three.ws/api/avatar/render?avatar=13f259c7-7024-4d68-b1f0-dbbf52c06209&scene=portrait&size=256&bg=transparent'

file portrait.png
# portrait.png: PNG image data, 256 x 256, 8-bit/color RGBA, non-interlaced
```

**Note the `-L`.** A cached render answers `302` with a `location` pointing at the CDN copy. Browsers and `<img>` tags follow that automatically; `curl` does not unless you tell it to. Omit `-L` and you get a zero-byte file and a confusing afternoon. Step 8 explains why the redirect exists.

Always set explicit `width` and `height` on the tag, matching the pixels you asked for. It costs nothing and it removes a layout shift.

---

## Step 4 - Control the frame: scene, size, background, format

Four parameters cover almost every real use.

```bash
A=13f259c7-7024-4d68-b1f0-dbbf52c06209
R=https://three.ws/api/avatar/render

# A tight headshot on a dark surface, sized for a comment avatar.
curl -sL -o comment-avatar.png "$R?avatar=$A&scene=headshot&size=128&bg=%23111827"

# Full body, transparent, tall rather than square: perfect for a hero column.
curl -sL -o hero.png "$R?avatar=$A&scene=full-body&width=640&height=960&bg=transparent"

# Lossy and small, for a feed where bytes matter more than edges.
curl -sL -o thumb.webp "$R?avatar=$A&scene=upper-body&size=192&format=webp&quality=72"
```

| Parameter | Values | Notes |
|---|---|---|
| `avatar` | UUID | Required. Omit it and you get the self-describing JSON from Step 1. |
| `scene` | `full-body`, `upper-body`, `portrait`, `headshot` | Default `upper-body`. An unknown value is a hard `400 invalid_scene`, and the error lists the valid ones. |
| `size` | 64 to 2048 | Square. Default 512. |
| `width`, `height` | 64 to 2048 | Override `size` per axis. Set both for a non-square frame. |
| `bg` | any CSS color, or `transparent` | Default `transparent`. URL-encode the `#`: `bg=%23111827`. |
| `format` | `png`, `jpeg`, `webp` | Default `png`. |
| `quality` | 1 to 100 | Default 90. Applies to `jpeg` and `webp` only. |

Two behaviours worth knowing because they differ:

- **Dimensions and quality are clamped, not rejected.** `size=9999` returns a valid 2048px image, not a `400`. That is friendly for a URL assembled by a template, and it means you cannot detect a mistake from the status code. Check the `x-render-size` response header if you need certainty.
- **`scene`, `pose`, and `expression` are validated strictly.** A typo in any of those three is a `400` with a specific code. That is also correct: silently substituting a default pose would produce a wrong image that looks right.

Transparent PNG is the default for a reason. It composites onto whatever your page already is, including a gradient or a photo, without you having to match a background color that will change next quarter. Reach for an opaque `bg` when the consumer cannot handle alpha, which in practice means JPEG and some email clients.

---

## Step 5 - Pose it, and drive the face

Two more parameters and the same endpoint stops producing profile pictures and starts producing characters.

`pose` takes any ID from the Step 1 catalog:

```bash
A=13f259c7-7024-4d68-b1f0-dbbf52c06209
R=https://three.ws/api/avatar/render

curl -sL -o waving.png    "$R?avatar=$A&scene=full-body&size=768&pose=wave&bg=transparent"
curl -sL -o thinking.png  "$R?avatar=$A&scene=full-body&size=768&pose=thinker&bg=transparent"
curl -sL -o landing.png   "$R?avatar=$A&scene=full-body&size=768&pose=superhero-landing&bg=transparent"
```

A wrong pose ID fails loudly:

```bash
curl -s "$R?avatar=$A&pose=moonwalk" | jq
```

```json
{
  "error": "unknown_pose",
  "error_description": "Unknown pose \"moonwalk\". GET /api/avatar/render for the catalog."
}
```

`expression` takes a URL-encoded JSON object of ARKit-52 morph target names mapped to weights from 0 to 1. **Use an avatar that actually has morph targets**, which is where Selfie Girl comes in:

```bash
SG=a4bad2f5-8a07-43cf-82e5-b6ba1314441e
R=https://three.ws/api/avatar/render

# Neutral, for comparison.
curl -sL -o face-neutral.png "$R?avatar=$SG&scene=headshot&size=384&bg=%23111827"

# Delighted: mouth open, big smile, brows up, eyes wide.
EXP='{"jawOpen":0.5,"mouthSmile":1,"browInnerUp":0.8,"eyeWideLeft":0.6,"eyeWideRight":0.6}'
curl -sL -o face-delighted.png \
  "$R?avatar=$SG&scene=headshot&size=384&bg=%23111827&expression=$(jq -rn --arg e "$EXP" '$e|@uri')"
```

Open both. The second one is visibly, unmistakably delighted. That is five numbers in a query string.

Useful morph names on a model with the full set: `jawOpen`, `mouthSmile`, `mouthSmileLeft`, `mouthSmileRight`, `mouthFrownLeft`, `mouthFrownRight`, `mouthPucker`, `browInnerUp`, `browDownLeft`, `browDownRight`, `eyeBlinkLeft`, `eyeBlinkRight`, `eyeSquintLeft`, `eyeSquintRight`, `eyeWideLeft`, `eyeWideRight`. The [ARKit-52 canonical set](/docs/animations.md) is the full vocabulary.

### How to tell whether an avatar has morph targets

Lookup is by **exact name** against the GLB's own morph target dictionary, with a lowercase fallback. There is no alias resolution and no error when a name misses: an unknown morph is skipped, and the render returns `200` with that part of the face untouched. So "my expression did nothing" is nearly always "this model has no morph target by that name", not "the endpoint is broken".

The cheap test is a byte-size comparison between a neutral render and a deliberately extreme one:

```bash
R=https://three.ws/api/avatar/render
E=$(jq -rn '{jawOpen:1,mouthSmile:1}|tostring|@uri')

probe() {
  curl -sL -o /dev/null -w "  neutral %{size_download}\n" "$R?avatar=$1&scene=headshot&size=256"
  curl -sL -o /dev/null -w "  extreme %{size_download}\n" "$R?avatar=$1&scene=headshot&size=256&expression=$E"
}

echo 'Michelle:';    probe 13f259c7-7024-4d68-b1f0-dbbf52c06209
echo 'Selfie Girl:'; probe a4bad2f5-8a07-43cf-82e5-b6ba1314441e
```

```
Michelle:
  neutral 48125
  extreme 48125
Selfie Girl:
  neutral 41924
  extreme 42179
```

Identical byte counts mean nothing moved, which means no matching morph targets. Different counts mean the face responded. Do this once per model and write the answer down.

Give the first render of each pair a moment: a cold render boots headless chromium, so the numbers only line up once both URLs are cached.

A malformed `expression` value, on the other hand, is a real `400`:

```json
{ "error": "invalid_expression", "error_description": "expression must be a JSON object of morph targets" }
```

---

## Step 6 - A social card

Now the payoff. A rendered avatar as an `og:image` means every share of the page shows the character, and the character updates when the avatar does, with no image pipeline and no asset to regenerate.

```html
<head>
  <meta property="og:title" content="Meet Michelle" />
  <meta property="og:description" content="A live 3D agent you can talk to." />
  <meta
    property="og:image"
    content="https://three.ws/api/avatar/render?avatar=13f259c7-7024-4d68-b1f0-dbbf52c06209&scene=upper-body&width=1200&height=630&bg=%230a0a0a&format=jpeg&quality=88"
  />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="https://three.ws/api/avatar/render?avatar=13f259c7-7024-4d68-b1f0-dbbf52c06209&scene=upper-body&width=1200&height=630&bg=%230a0a0a&format=jpeg&quality=88" />
</head>
```

Four decisions in that URL, all deliberate:

- **1200x630** is the standard large-card ratio. Set `og:image:width` and `og:image:height` to match so scrapers do not have to fetch the bytes to lay out the card.
- **`format=jpeg`** because several social scrapers handle alpha PNG badly, and a card is always composited onto an opaque surface anyway.
- **An opaque `bg`** for the same reason. Transparent alpha on a card usually renders as black on one platform and white on another.
- **`scene=upper-body`** because a headshot in a 1.9:1 frame leaves enormous dead space on both sides.

Scrapers are not patient and they do not follow long redirect chains happily. Fetch the URL yourself once with `-L` before you ship the tag, so the render is already cached and the scraper's first visit is a fast redirect to the CDN rather than a cold render.

---

## Step 7 - Render any GLB, from any URL, at any angle

`/api/avatar/render` needs a three.ws avatar ID. Its sibling `POST /api/render/avatar-clip` takes a raw GLB URL instead, so it works on models that were never saved as avatars: something you generated in the [Forge](/forge), a file on your own CDN, a character out of the [free character library](/character-library). It also exposes a free camera orbit, which the avatar endpoint deliberately does not.

`GET` the same URL for the catalog, so you never hardcode a pose ID or guess a range:

```bash
curl -s https://three.ws/api/render/avatar-clip | jq '{poses: (.poses|length), cameraOrbit, background}'
```

```json
{
  "poses": 28,
  "cameraOrbit": {
    "theta": "0..360 (degrees, yaw)",
    "phi": "0..180 (degrees, pitch from top)",
    "radius": "meters or null for auto-frame"
  },
  "background": ["transparent", "#0a0a0a", "any CSS color"]
}
```

Then `POST` a render:

```bash
curl -s -D headers.txt -X POST https://three.ws/api/render/avatar-clip \
  -H 'content-type: application/json' \
  -d '{
    "glbUrl": "https://three.ws/avatars/selfie-girl.glb",
    "posePresetId": "wave",
    "cameraOrbit": { "theta": 25, "phi": 78, "radius": null },
    "background": "transparent",
    "width": 768,
    "height": 768,
    "expression": { "jawOpen": 0.35, "mouthSmile": 0.9, "browInnerUp": 0.5 }
  }' -o wave.png

grep -i '^x-render' headers.txt
```

```
x-render-width: 768
x-render-height: 768
x-render-background: transparent
x-render-pose: wave
x-render-pose-label: Wave hello
```

Those headers are the endpoint telling you exactly what it did, which is worth logging: `x-render-pose` present means a pose was applied, absent means the model was rendered in its bind pose.

| Field | Default | Notes |
|---|---|---|
| `glbUrl` | required | Public http(s) URL, **max 10 MB**. SSRF-guarded: private hosts, link-local addresses, and non-http schemes are rejected with `400 bad_request`. |
| `width`, `height` | 1024 | 64 to 2048. |
| `background` | `#0a0a0a` | Any CSS color, or `transparent`. Note the different default from `/api/avatar/render`. |
| `posePresetId` | none | An unknown ID is `400 unknown_pose`. |
| `cameraOrbit` | auto | `{ theta, phi, radius }`. `radius: null` auto-frames the model, which is what you want unless you are building a turntable. |
| `expression` | none | Same ARKit-52 morph map, same exact-name matching. |

**The 10 MB cap is the constraint that bites**, and it does not fail politely. An oversized `glbUrl` stalls: the request hangs while the fetch runs into the cap rather than returning a fast `400`. So check the size yourself before you send it. One `HEAD` is enough:

```bash
curl -sI 'https://three.ws/avatars/selfie-girl.glb' | grep -i content-length
# Content-Length: 2235548     → 2.2 MB, fine
```

When a model is too big, shrink it with `GET /api/avatar/optimize`, which re-encodes a three.ws-hosted GLB down to a texture budget you name. Here is a 20 MB character from the [free character library](/character-library):

```bash
REMY='https://three.ws/api/avatar/optimize?src=https%3A%2F%2Fpub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev%2Favatars%2Fmixamo%2Fglb%2Fremy.glb&textureSize=512&morphs=arkit52'

curl -sL -D - -o small.glb "$REMY" | grep -i 'x-three-ws'
```

```
x-three-ws-source-bytes: 20566060
x-three-ws-output-bytes: 1479972
x-three-ws-optimize: none
```

20.6 MB down to 1.5 MB, better than a 90% cut, mostly from capping textures at 512px and dropping non-ARKit morph targets. Read the two byte headers rather than the numbers printed here: the exact output size moves as the pipeline improves. `x-three-ws-optimize` names the mesh-compression scheme that survived (`draco`, `meshopt`, `none`, or `source` when the pipeline could not beat the original and handed the source bytes back untouched); `none` here means the saving came from textures and morphs alone. `textureSize` accepts `128`, `256`, `512`, `1024`, `2048`; `lod=1` or `lod=2` adds progressively more aggressive welding; `morphs=arkit52` drops every morph target outside the standard set. `src` must be on a three.ws-controlled origin (the app origin or the CDN host), otherwise it is `400 untrusted_source`. Full parameter list in the [Media & Render API reference](/docs/media-api.md).

Best part: the optimizer's own URL is a public https URL, so you can hand it straight to the renderer and never store an intermediate file.

```bash
curl -s -D h.txt -X POST https://three.ws/api/render/avatar-clip \
  -H 'content-type: application/json' \
  -d "{\"glbUrl\":\"$REMY\",\"posePresetId\":\"salute\",\"background\":\"transparent\",\"width\":512,\"height\":512}" \
  -o remy-salute.png

grep -i '^x-render-pose' h.txt
# x-render-pose: salute
# x-render-pose-label: Salute
```

A 20 MB character, rendered through a 10 MB endpoint, in one request. The optimizer's output is cached immutably per URL, so the second render of the same character skips the transcode entirely.

For a turntable, hold everything constant and step `theta`:

```bash
for T in 0 45 90 135 180 225 270 315; do
  curl -s -X POST https://three.ws/api/render/avatar-clip \
    -H 'content-type: application/json' \
    -d "{\"glbUrl\":\"https://three.ws/avatars/selfie-girl.glb\",\"posePresetId\":\"apose\",\"cameraOrbit\":{\"theta\":$T,\"phi\":80,\"radius\":null},\"background\":\"transparent\",\"width\":512,\"height\":512}" \
    -o "turn-$T.png"
done
```

Eight frames, one A-pose, eight yaw angles. Assemble them into a sprite sheet or an animated WebP and you have a spinning 3D product shot that plays anywhere, including in an email.

Keep that loop sequential. This endpoint allows **60 renders per 10 minutes per IP** (`/api/avatar/render` allows 120), and a `Promise.all` over fifty frames will collect a fistful of `429`s. A `429` carries `Retry-After`; honour it.

---

## Step 8 - Cache correctly

Understanding the cache is what makes this cheap enough to put on a high-traffic page.

The first request for a given parameter combination boots headless chromium, loads the GLB, renders, and returns the image bytes directly:

```
HTTP/2 200
content-type: image/png
cache-control: public, max-age=300, s-maxage=86400
x-render-cache: miss
x-render-scene: portrait
x-render-size: 256x256
```

The result is written to object storage under a key derived from the avatar ID, a hash of the parameters, and the avatar's `updated_at`. Every request after that answers with a redirect:

```
HTTP/2 302
location: https://<cdn>/renders/<avatar-id>/<param-hash>.png
cache-control: public, max-age=300, s-maxage=86400
x-render-cache: hit
```

Consequences, in order of how likely they are to matter to you:

1. **Follow redirects.** `<img>` and every browser do it for free. `curl` needs `-L`. Server-side fetches need whatever your HTTP client's follow-redirects flag is called, and some default to off.
2. **Editing the avatar busts the cache automatically**, because `updated_at` is part of the key. Change the avatar's appearance or swap its GLB and the next request re-renders. You never purge anything.
3. **Every distinct parameter combination is a distinct cache entry.** Standardize on a small set of sizes across your app. Six sizes is a warm cache; sixty randomly-computed sizes is a cold one, and cold means a chromium boot on your user's critical path.
4. **Warm the first render yourself** for anything on a landing page, a social card, or an email. One `curl -sL -o /dev/null` at deploy time per URL you know you will serve.
5. `POST /api/render/avatar-clip` returns bytes directly with `cache-control: public, max-age=300, s-maxage=86400` and no storage-backed cache, because its input is an arbitrary URL rather than a stable ID. If you need those cached, cache them yourself.

---

## Step 9 - A real viewer on your own page

Sometimes an image is not enough and you want the actual interactive model. Loading a GLB in the browser is a cross-origin `fetch`, which means CORS, and whether it works depends on which host serves the file.

Two hosts, two answers (measured 2026-08-01):

- **`https://three.ws/...`**, which is where the built-in library avatars live (`/avatars/selfie-girl.glb` and friends), answers every origin with `access-control-allow-origin: *`. Load these directly. No proxy needed.
- **`https://pub-*.r2.dev/...`**, the media bucket's own host, behind every avatar you or your users generated, answers only origins on its allowlist (`three.ws`, `*.vercel.app`, `localhost:3000`; re-measured 2026-09-04). From `https://your-site.com`, from Jupyter, or from a Vite server on `localhost:5173`, a direct load fails with a CORS error and an empty canvas. That is the URL `/api/avatar/render` redirects to and the URL the avatar APIs return for user avatars.
- **`https://three.ws/cdn/<key>`** serves those same bucket objects first-party, with `access-control-allow-origin: *` on every origin. If you have the object key (everything after the bucket host), this loads directly and needs nothing below.

`GET /api/glb?src=<url>` exists for the second case. It streams any public GLB back with `access-control-allow-origin: *`, and it is harmless on the first, so if you cannot tell which host a URL points at, use it. The example below proxies a `three.ws` URL that would also load directly, because it is the pattern that keeps working when you swap in a generated avatar:

```bash
curl -sD - -o /dev/null -H 'Origin: https://your-site.com' \
  'https://three.ws/api/glb?src=https%3A%2F%2Fthree.ws%2Favatars%2Fselfie-girl.glb' \
  | grep -iE 'access-control-allow-origin|content-type|cache-control'
```

```
access-control-allow-origin: *
content-type: model/gltf-binary
cache-control: public, max-age=86400, s-maxage=604800, immutable
```

Safe by construction: the upstream objects are already public and keyless, and the fetch runs through an SSRF-hardened client (scheme allowlist, DNS pinning, private-address blocklist, redirect re-validation, 30 MB cap, 20 second timeout). It is a CORS shim, not an open proxy.

Drop that into `<model-viewer>` and you have a real viewer with a rendered poster, which is the pattern worth copying: the image loads instantly and the interactive model replaces it when it is ready.

```html
<script type="module" src="https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js"></script>

<model-viewer
  src="https://three.ws/api/glb?src=https%3A%2F%2Fthree.ws%2Favatars%2Fselfie-girl.glb"
  poster="https://three.ws/api/avatar/render?avatar=a4bad2f5-8a07-43cf-82e5-b6ba1314441e&scene=full-body&size=768&bg=transparent"
  alt="Selfie Girl, an interactive 3D avatar"
  camera-controls
  auto-rotate
  style="width: 100%; height: 560px; background: transparent;"
></model-viewer>
```

The poster carries its weight here: 2.2 MB of GLB takes a moment on a phone, and a rendered PNG of the same character arrives in a fraction of that. The user sees the right thing immediately and gains interactivity when the model lands.

The same proxy makes GLBs loadable from a Jupyter or Colab notebook and from a `localhost` dev server on a port that is not in the CDN's allowlist, which is the other place this bites.

If you want a talking, animated agent rather than a viewer, that is the `<agent-3d>` web component instead. See [From the character library to a live embed](/docs/tutorials/character-library-to-embed.md).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Zero-byte file from `curl` | The render was cached and answered `302`; `curl` did not follow it | Add `-L`. Browsers and `<img>` already do this. |
| `404 not_found` | Avatar does not exist | Check the UUID against `GET /api/avatars/featured` or the avatar's page at `/agents/<id>`. |
| `403 private` | Avatar visibility is `private` | Only `public` and `unlisted` avatars render. Change its visibility or use a different avatar. |
| `400 invalid_scene` | Typo in `scene` | The error lists the four valid values. |
| `400 unknown_pose` | Pose ID not in the catalog | `GET /api/avatar/render` or `GET /api/render/avatar-clip` for the live list. |
| `400 invalid_expression` | `expression` is not a JSON object | It must be a URL-encoded JSON **object**, not an array or a bare string. |
| Expression renders but the face never changes | The GLB has no morph target by that name | Exact-name matching, no aliases, no error. Run the byte-size comparison in Step 5. Michelle has zero morph targets; Selfie Girl has 63. |
| Image is 2048px when you asked for 4096 | Dimensions are clamped, not rejected | Read `x-render-size` to see what you actually got. Max is 2048 per axis. |
| `400 bad_request` from `avatar-clip` | `glbUrl` is missing, non-public, or not http(s) | Private hosts and non-http schemes are blocked by design. Use a public https URL. |
| `avatar-clip` request hangs, then dies with no body | `glbUrl` is over the 10 MB cap | Check with `curl -sI <url> \| grep -i content-length` first, then shrink it through `/api/avatar/optimize` and pass the optimizer URL as `glbUrl` (Step 7). |
| `502 render_failed` on `avatar-clip` | GLB unreachable or unparseable | Verify the URL returns a real GLB: `curl -sL -o m.glb <url> && head -c 4 m.glb` should print `glTF`. |
| `429` with `Retry-After` | 120 renders per 10 min per IP on `/api/avatar/render`, 60 on `avatar-clip` | Keep batches sequential and honour `Retry-After`. It is a rolling window, not a ban. |
| Empty canvas in `<model-viewer>`, CORS error in console | Loading a `pub-*.r2.dev` GLB directly from an origin the CDN does not echo | Route it through `/api/glb?src=...` (Step 9). A `three.ws/...` GLB needs no proxy, so check the host before you assume CORS. |
| Social card shows a blank or black box | Scraper hit a cold render, or choked on PNG alpha | Warm the URL once with `curl -sL`, and use `format=jpeg` with an opaque `bg`. |

---

## What you learned

- That the render endpoint documents itself, so nothing about scenes or poses needs hardcoding
- The four camera presets, and that they move the camera rather than crop the frame
- Which parameters clamp silently and which fail loudly, and why that split is correct
- The pose-versus-morph distinction, and a two-command test for whether a model supports expressions
- How to build a social card that stays correct as the avatar changes
- `POST /api/render/avatar-clip` for arbitrary GLBs, free camera orbits, and turntables
- The 10 MB cap and how `/api/avatar/optimize` gets you under it
- The `302`-to-CDN cache, its `updated_at`-keyed invalidation, and the five things that follow from it
- Which host needs `/api/glb` and which does not, and how the proxy fixes the CDN case in one attribute

## Next steps

- Put a live, animated, controllable avatar on the page instead of an image: [From the character library to a live embed](/docs/tutorials/character-library-to-embed.md).
- Generate the model you want to render, from a text prompt: [Generate 3D models from code](/docs/tutorials/generate-3d-api.md).
- Turn a photo into an avatar and render that: [Turn a selfie into an avatar](/docs/tutorials/selfie-to-avatar.md).
- Drive real motion instead of static poses: [Animate your avatar](/docs/tutorials/animate-your-avatar.md).
- Read the exhaustive parameter contract for every endpoint used here: [Media & Render API](/docs/media-api.md).
