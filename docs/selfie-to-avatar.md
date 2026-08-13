# Selfie to Avatar: scan your face into a rigged 3D character

Point your camera at your face, hold still for a countdown, and about a minute later you have a rigged, animation-ready 3D avatar in the browser. The scanner captures a single clean frontal photo (side angles optional), gates it for quality on-device, and hands it to a server-side face-reconstruction pipeline that fits your likeness onto a pre-rigged humanoid template. No modeling, no rig setup, no download of desktop tools.

Page: [/create/selfie](https://three.ws/create/selfie) (the working surface) · [/scan](https://three.ws/scan) (redirects here) · [/features/scan](https://three.ws/features/scan) (overview)
API: `POST /api/avatars/reconstruct` · `GET /api/avatars/regenerate-status` · `GET /api/avatars/:id`

## Why it exists

Every other surface on three.ws (agents, the marketplace, Play worlds, talking-avatar video, AR) needs a body to drive. A text prompt gives you a character; a selfie gives you *yourself*. The scanner is the shortest path from a real face to a shareable, riggable GLB, and it runs entirely from a phone or laptop browser with a camera. The output is not a static bust: it is a humanoid with a skeleton and a full ARKit blendshape set, so it can walk, emote, lip-sync, and be exported the moment it finishes.

`/scan` is a thin alias kept for links and marketing. On load it runs `window.location.replace('/create/selfie' + location.search)`, because `/create/selfie` carries the complete flow including the bring-your-own-key path. Document and link to `/create/selfie`.

## How it works

The client half lives in three modules the page imports on demand: [`src/selfie-capture.js`](../src/selfie-capture.js) (camera and upload UI), [`src/selfie-refine.js`](../src/selfie-refine.js) (`assessPhoto` / `refineSelfie`), and [`src/selfie-pipeline.js`](../src/selfie-pipeline.js) (the bridge to the backend). A fourth module, [`src/face-quality.js`](../src/face-quality.js), runs a live 468-point face mesh for framing feedback. Every quality threshold those modules apply lives in one shared, unit-tested module, [`src/selfie-gates.js`](../src/selfie-gates.js): each number is traced in its header comment to a real reconstruction-pipeline failure mode (the worker's no-face rejection, the 35-degree morph-yaw ceiling, provider blur failures, the dim/backlit band from the robustness benchmark), so the client rejects a shot for the same reasons the backend would.

1. **Capture, in the browser.** `getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1706 } } })` opens the front camera. A real-time wireframe overlay tracks head pose, yaw, centering, blur, and luminance, and only unlocks the shutter when a face is found; the hint line names the single most actionable fix ("Face the camera straight on.", "Hold steady. The image is blurry.", "Too dark. Find better light.") until every gate passes. A 3-2-1 countdown fires, then `shoot()` draws the current video frame to a canvas and calls `canvas.toBlob(blob, 'image/jpeg', 0.92)`. This is a **single still**, not a video scan. Camera support is feature-detected; if none exists, the shutter is disabled and an "Upload instead" path takes any image file.
2. **Review the still.** The countdown leaves ~3 seconds for motion blur, a head turn, or a lighting change to land in the actual capture, so the frozen still is re-scored (`checkImageQuality`) against the same gates before you accept it. The review screen shows per-gate chips plus a verdict line; only a missing face disables "Use this" (mirroring the worker's one hard input rejection), everything else is a warning you can accept.
3. **Optional side angles.** Under an "Add side angles" disclosure you can capture two extra stills (`left`, `right`, turned ~45 degrees). They raise fidelity and the ETA, but only the frontal is required. Confirmed shots (and the style choice) are mirrored to `sessionStorage`, so a refresh or accidental back-swipe mid-capture restores every slot instead of starting over; the build phase has its own resume rail (`selfie:pendingJobId`).
4. **Refine, in the browser.** `assessPhoto` gates the frontal (no face is the only hard block; blur, illustration, or a distant subject are non-fatal warnings). `refineSelfie` isolates the subject from its background and reframes to a clean head-and-shoulders square, rendered at 1024x1024 with JPEG quality 0.92 ([`src/selfie-refine.js`](../src/selfie-refine.js)). The refined frontal is previewed so you see exactly what the engine sees.
5. **Submit.** The pipeline ([`src/selfie-pipeline.js`](../src/selfie-pipeline.js)) downscales each photo to a 1024px longest edge at JPEG quality 0.88, POSTs them as data URIs to `/api/avatars/reconstruct`, and gets back a `jobId`.
6. **Reconstruct, server-side.** The reconstruct handler (`api/avatars/_actions.js`) selects a provider through [`api/_lib/regen-provider.js`](../api/_lib/regen-provider.js). The production lane is **GCP**: it POSTs `{ images, body_type }` to the Cloud Run service behind `GCP_RECONSTRUCTION_URL`, today the [`workers/avatar-reconstruction/`](../workers/avatar-reconstruction/) FastAPI app deployed as `avatar-reconstruction`. (The multi-backend [`workers/avatar-pipeline-controller/`](../workers/avatar-pipeline-controller/) speaks the identical contract and can take over that env var, but is not deployed today.) That pipeline (`face_texture_transfer_v2`) uses **MediaPipe FaceLandmarker** (468 landmarks, Apache-2.0) to transfer your face texture and geometry onto a fixed-topology, pre-rigged Wolf3D/Ready-Player-Me-style humanoid template carrying a Mixamo-compatible skeleton, 52 ARKit blendshapes, and 15 visemes. Full engine detail is in [avatar-reconstruction.md](./avatar-reconstruction.md).
7. **Auto-rig fallback.** The template is born rigged. If a generic mesh comes back unrigged and a rig model is configured, `reconstruct-finalize.js` chains a `rerig` job (the `model-rig` worker, `workers/rig`) and moves the job through a `rigging` status before surfacing the avatar. If rigging is impossible it delivers the static mesh tagged `unrigged` rather than nothing.
8. **Poll and finish.** The client polls `GET /api/avatars/regenerate-status?jobId=...` every ~3 seconds (backing off on errors). On `status: 'done'` it fetches the finished avatar from `GET /api/avatars/:id` and shows it in a `<model-viewer>`.

### The text-to-avatar variant

The same `/api/avatars/reconstruct` endpoint accepts a `prompt` instead of `photos`. It runs a Flux text-to-image step (with a suffix that forces a head-and-shoulders portrait), then feeds that image into the identical reconstruct and auto-rig pipeline. One endpoint, two front doors.

## Walkthrough

1. Open [/create/selfie](https://three.ws/create/selfie). Sign in if prompted (the job resumes after login).
2. Allow camera access. Center your face in the wireframe until the shutter unlocks; good light and a plain background help.
3. Let the countdown run and hold still for the capture. Review the frame, or retake.
4. Optionally open "Add side angles" and capture a left and right turn for higher fidelity.
5. Press the submit button (labeled with the ETA, ~90s frontal-only or ~120s with sides). Watch the build steps: mesh, geometry and textures, auto-rig.
6. When it lands, use "Open my avatar" to view it, "Customize in editor" to edit, "Turn this into an agent", or the export buttons (.GLB, .FBX) and share panel.

## Examples

The reconstruct endpoint is authenticated. With a session cookie or a bearer token scoped `avatars:write`:

```bash
# Submit a reconstruction from a single frontal data-URI (or a hosted image URL).
curl -X POST 'https://three.ws/api/avatars/reconstruct' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <TOKEN>' \
  -d '{
    "name": "My selfie avatar",
    "photos": ["data:image/jpeg;base64,/9j/4AAQ..."],
    "visibility": "private",
    "params": { "bodyType": "average", "style": "realistic" }
  }'
# -> 202 { "ok": true, "jobId": "…", "status": "queued", "eta": 90, "provider": "gcp" }

# Poll until done, then fetch the rigged GLB.
curl -H 'authorization: Bearer <TOKEN>' \
  'https://three.ws/api/avatars/regenerate-status?jobId=<JOBID>'
# -> { "ok": true, "jobId": "…", "status": "done", "resultAvatarId": "<ID>" }

curl -H 'authorization: Bearer <TOKEN>' 'https://three.ws/api/avatars/<ID>'
# -> { "avatar": { "url": "<signed GLB url>", "model_url": null, ... } }
```

Request body: `name` (1-120, required), `photos` (1-6 image URLs or data URIs) **or** `prompt` (3-600 chars), optional `description`, `visibility` (`private` | `unlisted` | `public`), `params`, and the BYOK pair `provider_key` + `provider_name`. Status values progress `queued` -> `running` -> (`rigging`) -> `done` | `failed`.

## States and limits

- **Auth is required.** No session or scoped token returns `401`, and the page redirects to `/login?next=/create/selfie`, resuming the pending job afterward via `sessionStorage`. The `/features/scan` marketing line "no account for first scan" does not match the shipped API; treat sign-in as required.
- **Cost.** On the platform-hosted GCP lane there is no per-use charge in the reconstruct handler; usage is rate-limited (`limits.upload`), and over-quota returns `402 plan_limit`.
- **Bring your own key.** If no platform reconstruction backend is configured, the server returns `402 { code: 'regen_needs_byok', providers: ['meshy','tripo'] }` and the page shows a key-entry form. Meshy and Tripo run image-to-3D with your own API key; credit exhaustion surfaces as `402 insufficient_credits`.
- **Single frame.** Despite "captures several angles automatically" in some copy, the scanner takes one manual still per slot; side angles are an optional manual add.
- **Timing.** The build screen says "1-2 minutes"; polling gives up after 8 minutes, and a job still reported running 10 minutes after submit (possible when a pending job resumes across a reload) stops with a "taking unusually long" message pointing you to your dashboard, since the avatar may still finish server-side.
- **Quality gating.** Only a frontal with no detectable face hard-blocks. Blur, illustrations, or multiple faces are surfaced as warnings you can proceed past.
- **Error handling.** Camera denial distinguishes `NotAllowedError` ("Camera access was denied... use Upload instead") from other failures. Job failures map to friendly messages (no face, content-safety flag, blur, service unavailable, timeout, out-of-memory). Poll tolerates up to 5 consecutive network errors with backoff before "Lost connection to the avatar engine." Rate limits (`429`) start a 60-second cooldown with a live countdown. Pending jobs resume across reloads.
- **Output.** glTF 2.0 GLB with a Mixamo-standard humanoid rig, 52 ARKit blendshapes, and 15 visemes. Private avatars return a short-lived signed `url`; `model_url` is the public CDN URL once you make it public.

## Related

- [Avatar reconstruction pipeline](./avatar-reconstruction.md): the full engine: MediaPipe face-texture transfer, geometry morph, the fixed pre-rigged head template, and the Cloud Run worker.
- [Avatar pipeline](./avatar-pipeline.md): the distinct Forge text-to-3D generation lane.
- [Trait-based avatar builder](./character-studio.md): customize and dress the avatar after you scan it.
- [Talking Avatar Video](./talking-avatar-video.md) and [Lipsync](./lipsync.md): drive the finished avatar's mouth.
- Pages: [/create/selfie](https://three.ws/create/selfie), [/create](https://three.ws/create), [/features/scan](https://three.ws/features/scan).
