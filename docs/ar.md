# AR & WebXR

Place any three.ws avatar or Forge model into the real world through the camera on your phone — no app, no download. The feature is called **View in AR** and it works on both iOS and Android directly in the browser.

---

## How it looks

Every avatar page has an **AR** tab. Every Forge model has a **View in AR** button in its result toolbar. On mobile, tapping **Place in your space** triggers native AR. On desktop, the same screen shows a **QR code** — scan it with your phone and the AR session opens in one tap.

The fastest way to try the whole loop is **[AR Forge](/ar)** (`/ar`): type a prompt, a real GLB is generated on the free lane, and the result opens straight into AR on a phone (or shows the QR handoff on desktop). It also accepts a deep link, `/ar?src=<glb-url>&title=<name>`, to reopen any shared model. Under the hood it uses the same `POST /api/forge` lane and the `GET /api/ar?src=` launcher described below.

---

## AR methods — which one fires

three.ws selects the right AR method automatically based on the device and browser:

| Method | Platform | Trigger | Needs app? |
|--------|----------|---------|-----------|
| **iOS Quick Look** | iPhone / iPad (Safari) | Native `<a rel="ar">` click | No |
| **Android Scene Viewer** | Android Chrome | ARCore intent URL | ARCore (auto-prompts) |
| **WebXR immersive-ar** | Chrome on Android, Safari 15.4+ | `navigator.xr` session | No |

**Selection order:** the AR surfaces configure model-viewer with `ar-modes="webxr scene-viewer quick-look"`, so the first mode the device actually supports wins: WebXR where available (Android Chrome with ARCore), then Scene Viewer, then Quick Look. On iOS Safari, WebXR is off by default, so Quick Look is what fires in practice. WebXR is the only method that keeps the agent live in-page. The `/api/ar` launcher additionally 302-redirects plain Android model requests straight into the Scene Viewer intent (avatars get the launch page instead, so the living `/irl` path stays visible).

---

## What each method can do

| | Quick Look | Scene Viewer | WebXR |
|---|---|---|---|
| Platform | iOS Safari | Android Chrome | Any WebXR browser |
| Animations | Baked idle clip (static pose only if the bake fails) | Yes | Yes |
| Agent conversation | No | No | Yes — mic + chat live |
| `lookAt('user')` | No | No | Yes — tracks XR camera |
| Agent skills / tools | No | No | Yes — full runtime |
| HTTPS required | Yes (model URL) | Yes (model URL) | Yes (page origin) |
| Draco-compressed GLBs | May fail | May fail | Yes |
| Max practical size | ~15 MB | ~20 MB | No hard limit |

WebXR is the only method where the agent stays fully alive. Quick Look now ships with a baked idle loop, but if you need conversation, skills, or live animation switching, WebXR is required.

---

## Enabling AR for your model or agent

You do not add an attribute to enable AR; you link to (or embed) one of the AR surfaces, all of which detect the device and pick the right AR method automatically:

| Surface | URL | Best for |
|---|---|---|
| One-tap AR launcher | `/api/ar?src=<glbUrl>&title=<name>` | Any public GLB; see [the full section below](#one-tap-ar-for-any-glb--get-apiar--export_ar) |
| Avatar AR page | `/avatars/<id>/ar` | Any saved three.ws avatar |
| AR Forge | `/ar` | Generate a model from a prompt and place it immediately |
| Living-agent AR | `/irl?avatar=<glbUrl>` | A rigged avatar that walks and talks in your room (WebXR) |

The avatar AR page and the `/api/ar` launch page render the model in Google's `<model-viewer>` element with `ar ar-modes="webxr scene-viewer quick-look"`, so the same page covers Quick Look, Scene Viewer, and WebXR. The **Place in your space** button appears only when the device exposes a usable AR mode (model-viewer's `canActivateAR`); on desktop the page shows a QR code handoff instead.

### Allow XR in iframes

If your agent is inside an `<iframe>`, add the `xr-spatial-tracking` permission:

```html
<iframe
  src="https://three.ws/embed/avatar/YOUR_ID"
  allow="microphone; camera; xr-spatial-tracking; fullscreen"
></iframe>
```

Without `xr-spatial-tracking`, the browser blocks `navigator.xr` inside the frame and the AR button won't appear.

---

## Programmatic API

On pages that render the model with `<model-viewer>` (the avatar AR page at `/avatars/<id>/ar`, the `/api/ar` launch page, Forge results), AR is driven through model-viewer's API. This is exactly what [src/ar-page.js](../src/ar-page.js) does:

```js
const viewer = document.querySelector('model-viewer');

// canActivateAR is true only when the device exposes a usable AR mode
// (Quick Look, Scene Viewer, or WebXR) and the model is loaded.
if (viewer.canActivateAR) {
  viewer.activateAR(); // picks the best available method automatically
}

// Listen for AR session events
viewer.addEventListener('ar-status', (e) => {
  // e.detail.status: 'session-started' | 'object-placed' | 'failed' | 'not-presenting'
  console.log('AR status:', e.detail.status);
});
```

For a custom viewer without model-viewer, use the three.ws launcher modules directly; see [Using AR without model-viewer](#using-ar-without-model-viewer) below.

---

## iOS Quick Look — deep dive

Safari intercepts clicks on `<a rel="ar">` and opens the native AR viewer. The three.ws implementation in `src/ar/quick-look.js` (simplified; the real module also keeps the anchor in the DOM to receive Quick Look banner-tap events):

```js
export function openQuickLook(usdzURI, { onBannerTap } = {}) {
  const a = document.createElement('a');
  a.rel = 'ar';
  a.href = usdzURI;
  a.appendChild(document.createElement('img')); // required for programmatic click
  a.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(a); // stays in the DOM while the viewer is open
  a.click();
}
```

The child `<img>` element is required: without it, Safari won't intercept a programmatic `.click()` as a Quick Look trigger. This is a documented WebKit quirk. The anchor must remain in the DOM while the viewer is open: Safari delivers the banner-tap `message` event on the anchor that launched the session.

**USDZ on iOS:** Quick Look wants USDZ, so three.ws always hands it one. If a `usdz_url` exists on the avatar record (a pre-generated companion stored on R2), it's used as `ios-src`; otherwise the GLB-to-USDZ conversion runs in-browser (three.js `USDZExporter`, or the animated bake described below) before Quick Look opens.

**Requirements:**
- iOS 13+ with Safari (Chrome on iOS uses WebKit but lacks Quick Look integration)
- Model URL must be HTTPS with CORS headers set (`Access-Control-Allow-Origin: *`)
- No DRM-protected assets

**Limitations:**
- Only the one baked clip plays (the idle loop): Quick Look can't switch
  animations or react, and if the bake fails the model falls back to a static
  pose (see the USDZ pipeline below)
- No conversation (native OS viewer, outside the browser context)
- Cannot customize the Quick Look UI beyond the model itself

---

## Android Scene Viewer — deep dive

Scene Viewer is launched via an Android intent URL. `src/ar/scene-viewer.js` builds the URL:

```js
function openSceneViewer(glbURL, { title = '', link = '' } = {}) {
  const params = new URLSearchParams({
    file: glbURL,
    mode: 'ar_preferred', // tries AR first, falls back to 3D viewer
  });
  if (title) params.set('title', title);
  if (link) params.set('link', link); // "View in browser" button target

  const fallback = encodeURIComponent(location.href);
  const intentURL =
    `intent://arvr.google.com/scene-viewer/1.2?${params}` +
    `#Intent;scheme=https;package=com.google.ar.core;` +
    `action=android.intent.action.VIEW;` +
    `S.browser_fallback_url=${fallback};end;`;

  location.href = intentURL;
}
```

`S.browser_fallback_url` is critical: if ARCore is not installed, Chrome redirects back to your page rather than showing an error screen.

**Parameters:**
- `file` — absolute HTTPS GLB URL
- `title` — shown in Scene Viewer's title bar
- `link` — the "View in browser" CTA button target
- `mode=ar_preferred` — AR if supported, 3D viewer otherwise

**Requirements:**
- Android 7.0+ with Google Play Services
- Chrome 67+ (or any Chromium-based browser on Android)
- GLB served over HTTPS with `Access-Control-Allow-Origin: *`

---

## WebXR — deep dive

WebXR is the only AR method that keeps the agent alive in the browser. The `src/ar/webxr.js` module manages an `immersive-ar` session via Three.js's built-in XR support.

**Session lifecycle:**

```
navigator.xr.isSessionSupported('immersive-ar')
  → requestSession('immersive-ar', { requiredFeatures: ['hit-test'] })
  → renderer.xr.setSession(session)
  → requestReferenceSpace('local') + requestHitTestSource({ space: viewer })
  → render loop handed to XR system (renderer.setAnimationLoop)
  → user taps → agent anchored at hit-test position
  → session.end event → restore background, controls, and RAF loop
```

**What happens at session start:**
1. Scene background is set to `null` so the camera passthrough shows through
2. Hit-test source tracks real surfaces (floor, table, etc.) in real time
3. A reticle follows the detected surface until the user taps
4. First tap anchors the agent — `session.requestAnimationFrame` drives rendering from here

**What happens at session end:**
- Scene background restored
- Agent position/rotation reset to pre-AR values
- Standard `requestAnimationFrame` loop resumes
- All conversation state is preserved — the agent remembers what happened before AR

**Requirements:**
- Chrome on Android 8.0+ with ARCore installed
- Safari on iOS 15.4+ with the WebXR AR module enabled (Settings → Safari → Advanced → Experimental Features → WebXR Augmented Reality)
- HTTPS mandatory — `navigator.xr` is `undefined` on insecure origins

---

## USDZ pipeline (iOS Quick Look)

For avatars on three.ws, the USDZ is handled automatically:

1. **Pre-generated USDZ:** If the avatar record has a `usdz_url`, it's set as `ios-src` immediately — no conversion needed.
2. **In-browser animated bake:** If not, the page downloads the GLB and bakes an *animated* USDZ via [src/usdz-animated.js](../src/usdz-animated.js) (`glbBlobToAnimatedUsdzBlob`): the avatar is driven through its idle clip, the skinned vertices are sampled at keyframes, and the samples are written into the USDA as time-sampled points that Quick Look loops natively. So a rigged avatar breathes and idles in your room instead of standing in a frozen pose. This runs inline (a dynamic import, not a Web Worker) and typically takes a few seconds depending on model complexity.
3. **Static fallback:** Any bake failure (no rig, no usable clip) falls back to the plain `USDZExporter` path in [src/usdz-pipeline.js](../src/usdz-pipeline.js), which produces a static frame-0 pose. AR never regresses below static.
4. **Persistent storage (opt-in):** The AR page's in-browser conversion lives only for that visit (an object URL). Durable USDZ companions come from `generateAndSaveCompanions()` in [src/account.js](../src/account.js), which bakes the animated USDZ, uploads it via `POST /api/avatars/presign-usdz`, and saves `usdz_url` on the avatar record so later AR visits skip the conversion. Companion generation is opt-in per save (`generateCompanions: true`; the `/demos/usdz-ar` demo page enables it) because the bake costs several seconds of client CPU.

The same animated bake serves the `/irl` Place-in-AR button and the `/avatars/:id/ar` page ([src/ar-page.js](../src/ar-page.js)).

**USDZ limitations to know:**
- Quick Look plays exactly one baked clip; the full animation library and live retargeting need WebXR
- Draco-compressed geometry must be decompressed first (the exporter handles this)
- USDZ files over ~30 MB may fail to open in Quick Look on older devices

---

## Model optimization for AR

Poor AR performance almost always traces to model size or geometry complexity. A model that orbits smoothly in the 3D viewer can still stall or crash in Quick Look.

**Recommended limits:**

| Target | Size | Polygons | Textures |
|--------|------|----------|---------|
| Quick Look (iOS) | < 15 MB | < 100k tris | 1024 × 1024 max |
| Scene Viewer (Android) | < 20 MB | < 200k tris | 2048 × 2048 max |
| WebXR | < 50 MB | < 500k tris | 2048 × 2048 max |

**Optimization tools:**

```bash
# Draco compress and optimize with gltf-transform (WebXR only; may break Quick Look/Scene Viewer)
npx @gltf-transform/cli optimize model.glb optimized.glb --compress draco

# Geometry left uncompressed and unsimplified (safe for all three AR methods)
npx @gltf-transform/cli optimize model.glb optimized.glb --compress false --simplify false

# Resize textures
npx @gltf-transform/cli resize model.glb small.glb --width 1024 --height 1024
```

> **`optimize` compresses by default.** With no `--compress` flag it writes
> `EXT_meshopt_compression` + `KHR_mesh_quantization`, and `--simplify` is on by
> default too, so a bare `optimize` is neither lossless nor loadable by Quick
> Look and Scene Viewer. Pass `--compress false --simplify false` for the
> all-methods-safe output above.

> **Draco and Quick Look / Scene Viewer:** Draco-compressed GLBs require the Three.js Draco decoder. Quick Look and Scene Viewer don't include one, so they may refuse to load Draco GLBs. If you want AR across all three methods, compress with basis/KTX2 textures only, and leave geometry uncompressed.

---

## Testing AR locally

All three AR methods require HTTPS. `navigator.xr` is `undefined` on `http://` origins. There are two options:

### Option 1 — ngrok tunnel (recommended)

```bash
# Start your dev server
npm run dev
# Port 3000 is the default for this repo

# In a second terminal, open an ngrok tunnel
ngrok http 3000

# Open the ngrok HTTPS URL on your phone
# (e.g. https://abc123.ngrok.io)
```

### Option 2 — Deploy to an HTTPS host

Deploy the page to any host that terminates TLS (Cloud Run, Netlify, a static host — anything with a valid HTTPS URL) and open that URL on your phone.

### Debugging Quick Look

Quick Look gives almost no error feedback. If it opens and immediately closes:
- Model URL is not HTTPS → use ngrok or a deployed URL
- Model URL returns CORS errors → add `Access-Control-Allow-Origin: *` to the response headers
- File is too large → compress or resize
- USDZ conversion failed silently → check the browser console before Quick Look opens

### Debugging WebXR

```js
// Check support before calling activateAR
const supported = await navigator.xr?.isSessionSupported('immersive-ar');
console.log('WebXR AR supported:', supported);

// Chrome DevTools → More tools → WebXR → Session override
// lets you simulate an immersive-ar session on desktop
```

Chrome on desktop (127+) has a WebXR device simulator under DevTools → More Tools → WebXR. It won't show camera passthrough, but it lets you test the session lifecycle and placement logic without a physical device.

---

## Troubleshooting

### AR button doesn't appear on mobile

**Check 1: browser supports AR**
- iOS: Must be Safari, not Chrome or Firefox
- Android: Must be Chrome (or Chromium) with ARCore installed

**Check 2: model is loaded**
The **Place in your space** button is disabled until the model finishes loading. On a model-viewer page, watch for the `load` event:
```js
document.querySelector('model-viewer')
  .addEventListener('load', () => console.log('model loaded, AR should be available'));
```

**Check 3: inside an iframe**
Add `allow="xr-spatial-tracking"` to the `<iframe>` tag.

---

### AR button appears but nothing happens when tapped

- **iOS Quick Look:** The model URL is HTTP. Quick Look silently refuses non-HTTPS URIs.
- **Scene Viewer:** ARCore isn't installed. Chrome will show a prompt to install it; if dismissed, nothing happens.
- **WebXR:** HTTPS is required for `navigator.xr`. Check the page origin.

---

### Quick Look opens but immediately dismisses

- Model file is too large (> 15 MB is risky on older devices)
- USDZ conversion produced an invalid file — check the browser console for errors before Quick Look opens
- CORS missing on the GLB URL — Quick Look fetches it separately and will fail silently

---

### WebXR AR session starts but the agent is invisible

- Check that the scene background is set to `null` — if it's opaque, it covers the camera feed
- Confirm the agent was placed before calling `activateAR()` — if the agent position is off-screen, it may be placed outside the viewport

---

### Draco GLB fails in Quick Look or Scene Viewer

Decompress the file first. `--compress false` drops `KHR_draco_mesh_compression`
on the way out, and `--simplify false` keeps the mesh you already have:

```bash
npx @gltf-transform/cli optimize model.glb uncompressed.glb --compress false --simplify false
```

Or generate an uncompressed variant and use it as `ios-src` / for Scene Viewer while keeping the Draco-compressed one for the WebXR viewer.

---

## Platform compatibility matrix

| Device | Browser | Quick Look | Scene Viewer | WebXR AR |
|--------|---------|-----------|-------------|---------|
| iPhone (iOS 13+) | Safari | ✅ | ✗ | ✅ (iOS 15.4+, flag required) |
| iPhone (iOS 13+) | Chrome | ✗ | ✗ | ✗ |
| Android (ARCore device) | Chrome | ✗ | ✅ | ✅ |
| Android (no ARCore) | Chrome | ✗ | ✗ (prompts install) | ✗ |
| Desktop (any OS) | Any | ✗ | ✗ | ✗ (no camera passthrough) |

ARCore-compatible Android devices: [full list from Google](https://developers.google.com/ar/devices).

iOS 15.4+ requires WebXR AR to be enabled manually: **Settings → Safari → Advanced → Experimental Features → WebXR Augmented Reality**.

---

## Using AR without model-viewer

If you're building a custom viewer and just need the AR launchers, import the modules directly:

```js
import { canUseQuickLook, openQuickLook } from '/src/ar/quick-look.js';
import { canUseSceneViewer, openSceneViewer } from '/src/ar/scene-viewer.js';
import { WebXRSession } from '/src/ar/webxr.js';

// iOS: Quick Look takes a USDZ, not a GLB (bake one with
// glbBlobToAnimatedUsdzBlob / glbBlobToUsdzBlob, see the USDZ pipeline above)
if (canUseQuickLook()) {
  const glbBlob = await fetch('https://three.ws/avatars/cesium-man.glb').then((r) => r.blob());
  const { glbBlobToUsdzBlob } = await import('/src/usdz-pipeline.js');
  const usdzBlob = await glbBlobToUsdzBlob(glbBlob);
  openQuickLook(URL.createObjectURL(usdzBlob));
}

// Android: Scene Viewer takes the GLB URL
else if (canUseSceneViewer()) {
  openSceneViewer('https://three.ws/avatars/cesium-man.glb', {
    title: 'My Agent',
    link: 'https://three.ws',
  });
}

// WebXR: keeps the agent alive in-page. The constructor takes a viewer
// shim ({ renderer, scene, content, controls, activeCamera, ... }); see
// src/xr.js for the canonical shape, plus lifecycle callbacks
// (onEnd, onAnchored, onHit, onTracking, onScale, domOverlayRoot).
else if (await navigator.xr?.isSessionSupported('immersive-ar')) {
  const session = new WebXRSession(viewer, { onEnd: () => console.log('AR ended') });
  await session.start();
}
```

---

## One-tap AR for any GLB — `GET /api/ar` + `export_ar`

Any generated model (or any public https `.glb`/`.gltf`) gets a device-aware "View in your space" link with no setup:

```
https://three.ws/api/ar?src=<glbUrl>&title=<name>
https://three.ws/api/ar?src=<glbUrl>&title=<name>&kind=avatar   // living agent
```

The endpoint branches on the request's **User-Agent**, server-side:

| Device | What happens |
|---|---|
| **iOS** (iPhone/iPad) | Launch page → Apple **Quick Look**. The USDZ is generated from the GLB on the fly by model-viewer (three.js `USDZExporter`) — a real conversion, no server USD tooling. |
| **Android** | `302` → Google **Scene Viewer** ARCore intent (the GLB is the source), with a browser fallback to the WebGL viewer. |
| **Desktop** | Launch page → interactive **WebGL** viewer (no AR hardware). |

**`kind=avatar`: the living-agent lane.** AR on three.ws is not a prop viewer; it is how agents cross into physical space. When the GLB is a rigged avatar (an agent's body), add `kind=avatar`: the launch page then leads with a **Bring it to life** handoff into [`/irl?avatar=<glbUrl>`](/irl), where the avatar walks, animates, and talks with the user through their camera in their real room. Static placement stays available alongside it, and Android serves the launch page instead of the blind Scene Viewer redirect so the living path is always visible.

Bad input (non-https, non-GLB, missing) returns a clean, designed error page — never a crash.

**Shared links unfurl with the model itself.** The launch page sets its
`og:image` / `twitter:image` to `GET /api/render/glb?glbUrl=…&width=1200&height=630`,
a server-side PNG render of the actual GLB (CDN-cached for a day), so pasting
an AR link into a chat or timeline shows the model, not a generic card. The
page also converts: it carries "Create your own" (into [/ar](/ar)) and "Open
in 3D viewer" calls to action. See `GET|POST /api/render/glb` in the
[API reference](./api-reference.md) for the renderer's parameters and limits.

**For agents (MCP):** on the free, keyless connector at `/api/mcp-studio` every generation already returns `arUrl` in its result, so there is nothing extra to call. To build the link set for a GLB that connector did not generate, the read-only `export_ar` tool on the separate [`/api/mcp-3d` server](/docs/mcp-3d-studio) (account- or payment-gated) turns any public GLB into the AR launch link plus a conformant [Spatial MCP](/docs/spatial-mcp) artifact (with the `ar` handoff populated):

```jsonc
// tools/call → export_ar { "glb_url": "https://three.ws/avatars/xbot.glb", "title": "Robot" }
// → { arLaunchUrl: "https://three.ws/api/ar?src=…", viewerUrl: "…", sceneViewerUrl: "intent://…", spatial: { … } }

// Rigged avatar? Pass kind:"avatar" to also get the living-agent link:
// tools/call → export_ar { "glb_url": "…/scout.glb", "title": "Scout", "kind": "avatar" }
// → { arLaunchUrl: "…&kind=avatar", irlUrl: "https://three.ws/irl?avatar=…", … }
```

The avatar-producing studio tools (`text_to_avatar`, `rig_mesh`, `forge_avatar`) return `irlUrl` automatically, on both the free and paid tracks.

The response carries no payment, wallet, token, or internal-id surface, so it ships on both the Claude and OpenAI tracks.

How this link ships through ChatGPT end to end (the app connector, the custom GPT, the title-carrying poll, and link unfurls) is documented in [AR in ChatGPT](/docs/chatgpt-ar).

---

## Put this AR studio on your own site

The multi-model studio at [/ar/studio](/ar/studio) is published as a standalone open-source
package, so any site can embed the same thing:

```html
<script type="module" src="https://unpkg.com/3d-ar-studio/dist/ar-studio.min.js"></script>
<ar-studio></ar-studio>
```

- npm: [`3d-ar-studio`](https://www.npmjs.com/package/3d-ar-studio)
- Source and docs: [github.com/nirholas/3D-AR-Studio](https://github.com/nirholas/3D-AR-Studio)
- Hosted demo: [nirholas.github.io/3D-AR-Studio](https://nirholas.github.io/3D-AR-Studio/)
- MCP server: `npx 3d-ar-studio-mcp` (registry name `io.github.nirholas/3d-ar-studio`)

With no configuration it pulls models from our CC0 object library and generates new ones
through the free, keyless `/api/mcp-studio` connector documented above, so an embedder needs
no key and no account. One option repoints it at their own catalogue:

```js
createArStudio('#stage', { assets: 'https://their.cdn/models.json' })
```

Those surfaces answer open CORS on purpose: `/cdn/<key>` (models and thumbnails),
`/cdn/objects/library/manifest.json`, `/api/mcp-studio`, `/animations/manifest.json`,
`/hdri/*.hdr`, and `GET /api/ar`. Changing any of them changes what every embedded studio in
the wild can load.

---

## See also

- [AR on the homepage](https://three.ws/#home-ar) — live demo with real Forge models
- [Blog: See Your 3D Avatar in the Real World](https://three.ws/blog/see-your-3d-in-ar) — full walkthrough
- Avatar AR page at `/avatars/<id>/ar`: the dedicated AR experience for any saved avatar. Open it from any avatar's **AR** tab, or start from [AR Forge](/ar).
- [Walk feature](/features/walk) — WebXR immersive walk mode (different from placement AR)
- [Web component reference](/docs/web-component): full `<agent-3d>` attribute list
- [Embedding guide](/docs/embedding) — iframe setup with XR permissions
- [Tutorial: Place your model in AR](/tutorials/view-in-ar)
