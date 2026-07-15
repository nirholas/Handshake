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

**Selection order:** Quick Look → Scene Viewer → WebXR. Quick Look fires first on iOS because it's the most reliable. Scene Viewer fires first on Android because it works without a runtime XR session setup. WebXR is the fallback — and the only method that keeps the agent live in-page.

---

## What each method can do

| | Quick Look | Scene Viewer | WebXR |
|---|---|---|---|
| Platform | iOS Safari | Android Chrome | Any WebXR browser |
| Animations | No — static pose | Yes | Yes |
| Agent conversation | No | No | Yes — mic + chat live |
| `lookAt('user')` | No | No | Yes — tracks XR camera |
| Agent skills / tools | No | No | Yes — full runtime |
| HTTPS required | Yes (model URL) | Yes (model URL) | Yes (page origin) |
| Draco-compressed GLBs | May fail | May fail | Yes |
| Max practical size | ~15 MB | ~20 MB | No hard limit |

WebXR is the only method where the agent stays fully alive. If you need conversation, skills, or animations, WebXR is required.

---

## Enabling AR on your agent

Add the `ar` attribute to `<agent-3d>`:

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>

<agent-3d
  id="your-agent-id"
  ar
></agent-3d>
```

The AR button appears automatically when:
- The `ar` attribute is present
- The device/browser supports at least one AR method
- The model has finished loading

On desktop, the button is hidden — no desktop browser supports `immersive-ar`.

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

```js
const el = document.querySelector('agent-3d');

// Check if AR is available on this device
if (el.canActivateAR) {
  // Launch AR (picks the best available method automatically)
  await el.activateAR();
}
```

`canActivateAR` is `true` when:
- The model is fully loaded
- At least one of Quick Look, Scene Viewer, or WebXR is available

`activateAR()` is async — it awaits the session setup for WebXR; Quick Look and Scene Viewer return immediately.

```js
// Listen for AR session events
el.addEventListener('ar-status', (e) => {
  // e.detail.status: 'session-started' | 'object-placed' | 'failed' | 'not-presenting'
  console.log('AR status:', e.detail.status);
});
```

---

## iOS Quick Look — deep dive

Safari intercepts clicks on `<a rel="ar">` and opens the native AR viewer. The three.ws implementation in `src/ar/quick-look.js`:

```js
function openQuickLook(modelURI) {
  const a = document.createElement('a');
  a.rel = 'ar';
  a.href = modelURI;
  a.appendChild(document.createElement('img')); // required for programmatic click
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
```

The child `<img>` element is required — without it, Safari won't intercept a programmatic `.click()` as a Quick Look trigger. This is a documented WebKit quirk.

**USDZ on iOS:** iOS 13+ accepts GLB files directly via the `href`. For earlier devices or for Apple's richest AR features (like custom banners and item purchasing), three.ws can pre-generate a USDZ companion file stored on R2. If a `usdz_url` exists on the avatar record, it's used as `ios-src`; otherwise the GLB-to-USDZ conversion runs in-browser via the three.js `USDZExporter` before Quick Look opens.

**Requirements:**
- iOS 13+ with Safari (Chrome on iOS uses WebKit but lacks Quick Look integration)
- Model URL must be HTTPS with CORS headers set (`Access-Control-Allow-Origin: *`)
- No DRM-protected assets

**Limitations:**
- Static pose only — animations don't play
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
2. **In-browser conversion:** If not, the AR page downloads the GLB and runs `USDZExporter` from three.js in a Web Worker, then creates a `blob:` URL. This typically takes 2–8 seconds depending on model complexity.
3. **Persistent storage:** After the first conversion, the USDZ is uploaded to R2 and saved back to the avatar record so subsequent AR visits are instant.

**USDZ limitations to know:**
- Skinned meshes (rigged avatars) export to USDZ as static poses — animations are lost
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
# Draco compress and optimize with gltf-transform (WebXR only — may break Quick Look/Scene Viewer)
npx @gltf-transform/cli optimize model.glb optimized.glb --draco

# Lossless optimization (safe for all three AR methods)
npx @gltf-transform/cli optimize model.glb optimized.glb

# Resize textures
npx @gltf-transform/cli resize model.glb small.glb --width 1024 --height 1024
```

> **Draco and Quick Look / Scene Viewer:** Draco-compressed GLBs require the Three.js Draco decoder — Quick Look and Scene Viewer don't include one, so they may refuse to load Draco GLBs. If you want AR across all three methods, compress with basis/KTX2 textures only, and leave geometry uncompressed.

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

**Check 1 — `ar` attribute is set:**
```html
<agent-3d id="..." ar></agent-3d>
```

**Check 2 — browser supports AR:**
- iOS: Must be Safari, not Chrome or Firefox
- Android: Must be Chrome (or Chromium) with ARCore installed

**Check 3 — model is loaded:**
The AR button is hidden until the model finishes loading. Watch for the `load` event:
```js
el.addEventListener('load', () => console.log('model loaded, AR should be available'));
```

**Check 4 — inside an iframe:**
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

Decompress the file first:

```bash
npx @gltf-transform/cli optimize model.glb uncompressed.glb --no-draco
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

## Using AR without `<agent-3d>`

If you're building a custom viewer and just need the AR launchers, import the modules directly:

```js
import { openQuickLook } from '/src/ar/quick-look.js';
import { openSceneViewer } from '/src/ar/scene-viewer.js';
import { WebXRSession } from '/src/ar/webxr.js';

// iOS
if (/iPhone|iPad/.test(navigator.userAgent)) {
  openQuickLook('https://cdn.example.com/model.glb');
}

// Android
else if (/Android/.test(navigator.userAgent)) {
  openSceneViewer('https://cdn.example.com/model.glb', {
    title: 'My Agent',
    link: 'https://three.ws',
  });
}

// WebXR fallback
else if (await navigator.xr?.isSessionSupported('immersive-ar')) {
  const session = new WebXRSession(renderer, scene, camera);
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

**For agents (MCP):** the free, read-only `export_ar` tool on the [3D Studio server](/docs/mcp) turns a GLB into the AR launch link plus a conformant [Spatial MCP](/docs/spatial-mcp) artifact (with the `ar` handoff populated):

```jsonc
// tools/call → export_ar { "glb_url": "https://three.ws/cdn/creations/model.glb", "title": "Robot" }
// → { arLaunchUrl: "https://three.ws/api/ar?src=…", viewerUrl: "…", sceneViewerUrl: "intent://…", spatial: { … } }

// Rigged avatar? Pass kind:"avatar" to also get the living-agent link:
// tools/call → export_ar { "glb_url": "…/scout.glb", "title": "Scout", "kind": "avatar" }
// → { arLaunchUrl: "…&kind=avatar", irlUrl: "https://three.ws/irl?avatar=…", … }
```

The avatar-producing studio tools (`text_to_avatar`, `rig_mesh`, `forge_avatar`) return `irlUrl` automatically, on both the free and paid tracks.

The response carries no payment, wallet, token, or internal-id surface, so it ships on both the Claude and OpenAI tracks.

---

## See also

- [AR on the homepage](https://three.ws/#home-ar) — live demo with real Forge models
- [Blog: See Your 3D Avatar in the Real World](https://three.ws/blog/see-your-3d-in-ar) — full walkthrough
- [Avatar AR page](/avatars/:id/ar) — the dedicated AR experience for any avatar
- [Walk feature](/features/walk) — WebXR immersive walk mode (different from placement AR)
- [Web component reference](/docs/web-component) — full `<agent-3d>` attribute list including `ar`
- [Embedding guide](/docs/embedding) — iframe setup with XR permissions
- [Tutorial: Place your model in AR](/docs/tutorials/view-in-ar)
