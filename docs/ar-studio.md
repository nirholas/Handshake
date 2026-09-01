# AR Studio: place many models in your real space, together

AR Studio turns your camera view into an infinite canvas. Place as many 3D models and avatars as you like into the room around you, drawn from your own forges, the community gallery, a pasted GLB link, or brand-new ones forged from a text prompt without leaving the scene. It scales from full WebXR immersive AR down to camera passthrough down to a desktop 3D preview, and it can go multiplayer: open a shared room and everyone in it builds the same scene live. Share an arrangement with a link, or hand it to your phone with a QR code.

Page: [/ar/studio](https://three.ws/ar/studio)
API: `POST /api/forge` (in-view text-to-3D) · `GET /api/forge-gallery` (your and community models) · `GET /api/objects/library` (the CC0 prop library). Multiplayer runs on a Colyseus room, `studio_world`.

## Why it exists

The older "View in AR" flow (see [AR and WebXR](./ar.md)) shows one model at a time in a native viewer. AR Studio is the composition tool: a persistent, multi-model scene you arrange in real space and can build with other people at once. It is free, needs no account, and degrades gracefully so it works on a laptop, a phone browser, or a full AR headset. It is where a forge result, a marketplace avatar, and a prompt-conjured prop can all stand in your living room together.

This doc covers what is unique to AR Studio. For the underlying `POST /api/forge` free lane, the `<agent-3d>` "View in AR" methods, the USDZ/Quick Look pipeline, and model-optimization limits, see [AR and WebXR](./ar.md).

## How it works

The page ([`pages/ar-studio.html`](../pages/ar-studio.html)) only imports [`src/ar-studio.js`](../src/ar-studio.js) after a WebGL check. Scene math, serialization, and the share hash live in [`src/ar/studio-scene.js`](../src/ar/studio-scene.js); the Colyseus client is [`src/ar/studio-net.js`](../src/ar/studio-net.js); WebXR multi-placement is [`src/ar/multi-place.js`](../src/ar/multi-place.js).

### Model sources

`addModel({ src, title })` normalizes the URL (https or site-relative only), enforces a 20-model cap, clones the loaded template (using SkeletonUtils for skinned rigs), and drops it on the floor in front of the camera. The "Add models" tray has five tabs:

- **Recent forges**: read from local storage (`twx_ar_forge_recent`), shared with `/ar` so one forge history opens in two doors.
- **Yours**: `GET /api/forge-gallery?limit=24` with an `x-forge-client` header (your anonymous browser id). Forge cards are titled with the first clause of the prompt they were generated from (`cardTitleFromPrompt`), with the whole prompt as the tooltip; a poster that fails to load falls back to the cube mark a poster-less item uses.
- **Community**: `GET /api/forge-gallery?scope=community&limit=24`.
- **Objects**: `GET /api/objects/library`, the CC0 prop library behind [/objects](https://three.ws/objects). The whole manifest is fetched once, so the tab's search box filters name and category client-side with no further requests, and renders matches 60 at a time.

Both gallery reads and the objects manifest answer with `Access-Control-Allow-Origin: *`: they are public, keyless, read-only feeds, and the standalone studio (npm `3d-ar-studio`) offers them as its Community and Objects tabs from whatever origin a developer embedded it on. Rate limiting, not origin, is the control.
- **GLB link**: paste any https `.glb`: a forge result, a viewer share link's `src`, or your own hosting.

A sixth source is the **in-view forge**: the dock form calls `POST /api/forge` with `{ prompt, backend: 'nvidia' }` (the free NVIDIA NIM / TRELLIS lane), polls `GET /api/forge?job=<id>` until the GLB is ready, remembers it, and drops it into the scene. A seventh is deep links: repeatable `?src=` (paired with `?title=`) and `?forge=<prompt>` boot content on open.

### Device-capability ladder

Best available mode wins. The dock's AR button (`#ars-xr-btn`) resolves one of three AR modes on load (`resolveArMode()`) and stays hidden when none applies:

1. **WebXR immersive AR**: offered only when `navigator.xr.isSessionSupported('immersive-ar')` resolves true. The button reads **Immersive**. The session requests `hit-test` (required) plus `anchors`, `local-floor`, `depth-sensing`, and `light-estimation`, with a DOM-overlay HUD. Each placed model gets an `XRAnchor`, and an always-armed reticle does tap-to-place. This is the only mode that keeps the whole multi-model scene in the page.
2. **The device's own AR viewer**, one model at a time, when there is no immersive session. The button reads **Place in AR** and hands the selected model (or the last one placed) to the platform viewer: on iPhone and iPad, AR Quick Look ([`src/ar/quick-look.js`](../src/ar/quick-look.js)), after the GLB is fetched and converted to USDZ on the device through three's `USDZExporter` ([`src/usdz-pipeline.js`](../src/usdz-pipeline.js), the same pipeline `/avatars/:id/ar` uses), with each stage reported in the status line ("Fetching the model…", "Preparing it for AR…", "Opening AR…"); on Android, Scene Viewer ([`src/ar/scene-viewer.js`](../src/ar/scene-viewer.js)) with the GLB URL directly. A device with neither is told to open the scene on a phone and offered the QR code. Before this existed, an iPhone was only ever offered the camera composite below, which looks right in a screenshot and not at all in the hand (no plane detection, no real scale, nothing occluding).
3. **Camera passthrough**: `getUserMedia({ video: { facingMode: { ideal: 'environment' } } })` becomes the background layer, with gyroscope world-lock look (DeviceOrientation, iOS permission-gated) and live light matching. Offered when `getUserMedia` exists, and available alongside mode 2.
4. **Desktop 3D preview**: always available: a grid floor with distance fog (removed the moment the camera becomes the backdrop), drag-look, and a "Phone" QR handoff on non-touch devices. Until you aim the camera yourself, the preview re-frames on the models you add so a model dropped on the floor never lands out of view.

If WebGL is missing, the page never loads the module and shows a fallback linking to `/ar` and `/viewer`.

### Gestures

Tap to select (tap empty space to deselect), drag to move a model you own along the floor, drag empty space to look around, pinch to resize (clamped 0.25x to 4x), and twist with two fingers to rotate. A selection toolbar offers rotate (+45 degrees), duplicate, and remove; desktop keyboard shortcuts nudge with arrows, rotate with R, duplicate with D, and remove with Delete (all undoable).

### Shared live rooms

Rooms run on the same Colyseus server as the other multiplayer surfaces, in a room named `studio_world` ([`multiplayer/src/rooms/StudioRoom.js`](../multiplayer/src/rooms/StudioRoom.js)), filtered by a 6-character room code. The page points at that server with `<meta name="studio-server" content="wss://…">` in [`pages/ar-studio.html`](../pages/ar-studio.html), the same way `/irl` and `/agora` declare theirs; [`src/ar/studio-net.js`](../src/ar/studio-net.js) reads it (falling back to the `irl-server` / `walk-server` tags, then `localhost:2567` in dev). Drop the tag and every room reports "offline" on the live site, because there is no host to infer from `three.ws` itself. The server's WebSocket upgrade is origin-gated, so a room joined from a local dev origin against the production server is refused with a 403 by design. "Create a room" seeds the current scene as the starting point; joining via a `?room=CODE` link does not seed. Model transforms travel in a shared logical frame (east/north metres, yaw degrees) so every device maps them onto its own floor. Clients send `model:spawn`, `model:update` (throttled ~12 Hz), and `model:remove`; the server syncs a `StudioState` of models and viewers. Edits are owner-gated (you can only move your own models), models stay when their author leaves, and the server enforces per-room and per-owner caps plus a rate limit. A presence pill shows "N here, M models."

### Share via `#s=` hash

The full arrangement (every model's source and transform) is serialized to JSON, base64url-encoded, and put in the URL fragment as `#s=<hash>`. `studioSceneUrl()` builds a link that carries both a plain `?src=` list (reopens the same models, capped to 4) and the `#s=` hash (carries the exact arrangement), falling back to the `?src=` list if the hash would exceed ~1500 chars. On open, a `#s=` hash is treated as a full document and replaces the working scene; malformed input degrades to an empty scene rather than throwing. The QR modal encodes this URL so your phone opens straight into camera AR with your models placed.

## Walkthrough

1. Open [/ar/studio](https://three.ws/ar/studio). On the empty card, choose Start camera, Browse models, or Forge one.
2. Add models: open the tray and pick from Recent, Yours, Community, or the CC0 Objects library, or paste a GLB link. Or type a prompt in the dock ("a neon bonsai tree") and press Forge to generate one in place.
3. Arrange: drag to move, pinch to resize, twist to rotate. On a phone, tap Start camera to see them in your room; on a headset, tap the Immersive button for full AR.
4. Go multiplayer: create a room and share the code (or the link). Others join and see and place models live.
5. Share: use the QR button to continue on your phone, or copy the scene URL (it carries the arrangement in `#s=`).

## Examples

The two HTTP endpoints AR Studio uses are the free, no-auth forge lanes. Your anonymous browser id goes in `x-forge-client`.

```bash
# Forge a model from a prompt (the in-view forge; free NVIDIA NIM lane).
curl -X POST 'https://three.ws/api/forge' \
  -H 'content-type: application/json' \
  -H 'x-forge-client: <ANON_CLIENT_ID>' \
  -d '{ "prompt": "a neon bonsai tree", "backend": "nvidia" }'
# -> { "job_id": "…", "status": "queued" }   (or { "status": "done", "glb_url": "…" })

# Poll the forge job until the GLB is ready.
curl -H 'x-forge-client: <ANON_CLIENT_ID>' 'https://three.ws/api/forge?job=<JOB_ID>'
# -> { "status": "done", "glb_url": "https://…/model.glb" }

# List your forge gallery (Yours tab) or the community showcase.
curl -H 'x-forge-client: <ANON_CLIENT_ID>' 'https://three.ws/api/forge-gallery?limit=24'
curl 'https://three.ws/api/forge-gallery?scope=community&limit=24'
# -> { "creations": [ { "glb_url": "…", "prompt": "…", "preview_image_url": "…" } ] }
```

You can also hand-build a share link: append `?src=<https glb url>&title=<name>` (repeatable) to `https://three.ws/ar/studio` to open with those models placed.

## States and limits

- **No auth, fully free.** Identity is an anonymous per-browser id (`forge:cid`), shared with `/forge` and `/creations`; it scopes the Yours tab, attributes in-studio forges, and keys room ownership. No sign-in, no wallet, no payment.
- **Placement caps.** 20 models per local scene; the shared room enforces its own per-room and per-owner caps and a per-client rate limit.
- **Camera and motion.** Camera denial (`NotAllowedError`) shows "Camera permission is blocked... then try again"; no `getUserMedia` disables the camera button but keeps the 3D preview. Denied motion falls back to drag-look.
- **XR unsupported.** With no immersive session the button becomes Place in AR (Quick Look or Scene Viewer) or stays hidden; a failed XR start shows "Camera mode still works." A failed native handoff shows "Could not open AR for this model" with a Try again action. Lost tracking prompts you to move to a brighter, more textured spot.
- **Rooms offline.** If the multiplayer server is unreachable or refuses the handshake, the studio drops back to single-player with "Shared rooms are offline right now, you can still build solo." and the room modal stays on its create/join panel. Departing authors' models remain until the room empties.
- **Persistence.** Your own placed models are saved to local storage (`twx_ar_studio_scene_v1`); `#s=` links replace the working scene. Photo capture composites the camera and WebGL layers to a PNG.
- **Forge failures.** `503`/unconfigured shows "The generator is offline"; `429` shows a busy message with a retry hint.

## Running it locally

`npm run dev` serves the page at `http://localhost:3000/ar/studio` and proxies `/api/*` to production. Every model URL in the tray points at the public R2 bucket, which answers `Access-Control-Allow-Origin: https://three.ws` and nothing else, so a raw bucket URL fails CORS from localhost and no model can be placed. The dev server rewrites those URLs to its own `/r2-proxy/*` path for the endpoints that carry them (`/api/avatars/*`, `/api/objects/*`, `/api/forge-gallery`, `/api/forge`), which is what makes the tray work off-production. If you add an endpoint that returns an R2 URL, add its prefix to `R2_URL_PREFIXES` in [`vite.config.js`](../vite.config.js) or that feature will work in production and be dead in dev.

Append `?e2e=1` to expose `window.__arsDebug` (`count()`, `netStatus()`, `netIds()`, `remoteX()`), a read-only hook for driving the page from a browser test. It is absent without the flag.

## Related

- [AR and WebXR](./ar.md): the single-model "View in AR" system, `/ar` AR Forge, the `POST /api/forge` free lane in depth, the USDZ/Quick Look pipeline, and model-optimization limits.
- [Selfie to Avatar](./selfie-to-avatar.md) and [Avatar pipeline](./avatar-pipeline.md): where the models you place come from.
- Pages: [/ar/studio](https://three.ws/ar/studio), [/ar](https://three.ws/ar), [/viewer](https://three.ws/viewer).
