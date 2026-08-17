# Talking Avatar Video: render a lip-synced clip from an avatar

Pick one of your three.ws avatars, upload an audio track, add an optional scene description, and a GPU worker renders a lip-synced talking-head video you can download as MP4. The lipsync and rendering happen server-side on a dedicated Cloud Run worker; the browser is just a picker, an uploader, and a player.

Page: [/create/video](https://three.ws/create/video)
API: `POST /api/avatar/presign-audio` · `GET`/`POST /api/avatar/video-generate` · `GET /api/avatar/video-status`

## Why it exists

Real-time browser lipsync (see [Lipsync](./lipsync.md)) is perfect for live avatars, but it cannot produce a finished, shareable file with rendered frames, matched motion, and a scene. Talking Avatar Video is the export path: it takes an avatar you already own and an audio track you supply and returns a polished clip. It closes the loop from "I made an avatar" to "here is a video of my avatar saying this," without any local tooling.

Note on scope: the shipped flow uploads an audio file. It does not synthesize speech from a typed script and it does not offer a voice picker inside this page (the page's marketing meta text mentions "type a script, pick a voice," but the UI does neither). To generate the audio first, use [Voice Lab](./voice-lab.md) and bring the resulting clip here.

## How it works

The page ([`pages/create/video.html`](../pages/create/video.html)) loads [`src/create-video.js`](../src/create-video.js), which uses `apiFetch` from [`src/account.js`](../src/account.js) and a `<model-viewer>` preview.

1. **Auth gate.** On load it checks `GET /api/auth/me`; if you are not signed in it redirects to `/login?next=%2Fcreate%2Fvideo`.
2. **Availability probe.** In parallel it calls `GET /api/avatar/video-generate`, which answers `{ available, reason, free_generations, accepts }` without submitting anything. When the GPU worker is not configured on the deployment the page raises a "Video rendering is offline" banner and keeps Generate disabled, so nobody is walked through an upload that can only end in a `503`. A probe that itself fails is treated as inconclusive: generation stays enabled and the real POST reports what happened.
3. **Pick an avatar.** It calls `GET /api/avatars` and renders your avatar library into a thumbnail bar of real `<button>` elements, auto-selecting the first. The selected GLB is shown in a `<model-viewer>`. Private avatars resolve their GLB lazily through `GET /api/avatars/:id` (a short-lived signed URL). Three distinct outcomes: avatars found (thumbnails), none yet (an empty state linking to `/create`), and the list call failing (an error row with a Retry that refetches). The last two show `/avatars/default.glb` in the viewer purely so the panel is not a blank box; it is never a generation source, and Generate stays disabled with a hint saying what is missing.
4. **Upload audio.** Drag in or pick a WAV, MP3, M4A, OGG, or FLAC file (a drop is accepted on MIME type *or* file extension, because some file managers hand over an empty `type`). The picked clip gets an inline `<audio>` preview plus its duration and size, and the hint under Generate turns the duration into an expectation ("about 3 clips of video from this audio", one clip per 3.72 s segment). The client POSTs `{ filename, content_type, bytes }` to `/api/avatar/presign-audio`, gets a presigned PUT URL plus a `public_url`, and PUTs the raw bytes to R2/S3. `bytes` is the declared file size and is required: a presigned PUT cannot carry a content-length policy, so it is the only place the 64 MB cap can be enforced. There is no data-URI fallback, because `video-generate` only accepts an https three.ws-hosted `audio_url` (see the SSRF guard below) and would reject a `data:` URI with a `400`; a failed presign surfaces as a real error on the page.
5. **Describe the scene (optional).** A textarea takes a scene description such as "A person speaking on a stage with dramatic lighting." This is a scene prompt, not a script.
6. **Generate.** With an avatar and audio ready, Generate POSTs `{ audio_url, avatar_id, prompt? }` to `/api/avatar/video-generate`. The page deliberately sends no `image_url`: the worker writes whatever that URL points at into `ref_image.png` and feeds it to inference as `cond_image`, so it has to be a raster image, and only the server can resolve one it trusts. Server-side, `resolveImageUrl` checks ownership/visibility, then returns the avatar's stored thumbnail, or (when it has none) a portrait render produced by the same cached pipeline behind [`/api/avatar/render`](./api-reference.md), so a second video from the same avatar costs a cache lookup rather than another chromium launch. Both URLs are SSRF-guarded (https on the app or S3 domain) before anything reaches the worker.
7. **Render, server-side.** The generate endpoint calls the **LongCat-Video-Avatar-1.5** worker on Google Cloud Run (`POST {LONGCAT_WORKER_URL}/generate`, bearer-authenticated), which produces the lip-synced frames. The endpoint returns `202 { job_id, status }`.
8. **Poll.** The client polls `GET /api/avatar/video-status?job_id=...` every 5 seconds (20-minute safety timeout). Status runs `queued` -> `running` -> `done` | `failed`, with an optional `progress` (0 to 1). A transient failure is ridden out, but six consecutive failed polls (30 s, e.g. a job that no longer exists or an expired session) end the wait with "Lost contact with the render job" instead of spinning silently to the timeout.
9. **Download.** On `done`, the `video_url` is set as the `<video>` source and the download anchor (`download="avatar-video.mp4"`). Progress copy: "Takes 2 to 4 minutes on GPU. Hang tight."

## Walkthrough

1. Open [/create/video](https://three.ws/create/video) and sign in.
2. Pick an avatar from the thumbnail bar; it loads into the preview.
3. Drop in or browse for an audio file (WAV, MP3, or M4A).
4. Optionally type a scene description.
5. Press Generate video. Watch the status: uploading audio, queuing, rendering frames with a percentage.
6. When it finishes, play the result inline and press Download to save the MP4, or New video to start over.

## Examples

All three endpoints require a signed-in browser session. They authenticate with the
session cookie only (`__Host-sid`); API bearer tokens are not accepted on this
surface, so from a script reuse the cookie from a logged-in browser session.

```bash
# 0. Is the renderer up on this deployment? (No session needed.)
curl 'https://three.ws/api/avatar/video-generate'
# -> { "available": true, "reason": "ready", "free_generations": 1, "accepts": { … } }

# 1. Presign an audio upload slot.
curl -X POST 'https://three.ws/api/avatar/presign-audio' \
  -H 'cookie: __Host-sid=<SESSION>' -H 'content-type: application/json' \
  -d '{ "filename": "line.mp3", "content_type": "audio/mpeg", "bytes": 184320 }'
# -> { "upload_url": "<PUT url>", "public_url": "https://…/line.mp3", "storage_key": "u/<uid>/audio/<uuid>.mp3" }

# 2. PUT the raw bytes to the presigned URL.
curl -X PUT '<PUT url>' -H 'content-type: audio/mpeg' --data-binary @line.mp3

# 3. Kick off generation from an avatar id + the uploaded audio. Prefer this over
#    passing image_url yourself: the server resolves a real reference image.
curl -X POST 'https://three.ws/api/avatar/video-generate' \
  -H 'cookie: __Host-sid=<SESSION>' -H 'content-type: application/json' \
  -d '{ "audio_url": "https://…/line.mp3", "avatar_id": "<AVATAR_ID>",
        "prompt": "A person talking on a bright stage." }'
# -> 202 { "job_id": "…", "status": "queued" }

# 4. Poll until done, then fetch video_url.
curl -H 'cookie: __Host-sid=<SESSION>' \
  'https://three.ws/api/avatar/video-status?job_id=<JOB_ID>'
# -> { "job_id": "…", "status": "done", "progress": 1, "video_url": "https://…/out.mp4", "error": null, "updated_at": "…" }
```

`audio_url` is required. Send `avatar_id` and omit `image_url`: the server then resolves a reference image it can vouch for (stored thumbnail, else a portrait render). A caller-supplied `image_url` is still accepted for integrations that host their own reference frame, but it must be a raster image on a three.ws host, and passing a `.glb` there yields a job that fails inside the worker. `prompt` defaults to "A person talking naturally."

## States and limits

- **Auth required.** The page gates on `/api/auth/me`; every endpoint re-checks the session and returns `401` otherwise.
- **Free tier: one lifetime generation.** Free-plan users get exactly one video. The quota is reserved race-safely (a `usage_events` row is inserted before the worker call and released if submission fails, so an outage never burns the trial). On exhaustion the server returns `402 free_trial_used` and the page retargets the button under the error to "Upgrade plan", pointing at `/dashboard`; the label and the click target move together, so a later unrelated error goes back to a plain "Try again". Paid plans are unlimited.
- **Rate limits.** Per-user and global rate limits on `video-generate` return `429`.
- **Input formats.** Audio: WAV, MP3, M4A, OGG, FLAC (validated against an allow-list; `415` otherwise). Uploads go to R2/S3 under `u/{userId}/audio/{uuid}.{ext}`.
- **Upload limits.** `presign-audio` requires a declared `bytes` (`400 invalid_request` without one) and caps a clip at 64 MB (`413 payload_too_large`). Signing also draws on the per-user upload bucket, so a session cannot mint unlimited write grants (`429` when spent).
- **SSRF guard.** `image_url` and `audio_url` must be https on the app origin or the S3 public domain, else `400 invalid_request`.
- **Ownership.** `video-status` verifies the job belongs to you (`404` if unknown, `403` if another user's). Avatar image resolution enforces owner-or-public visibility.
- **Timing and errors.** Renders take ~2 to 4 minutes; the client times out after 20 minutes. UI states cover idle (with a hint naming what is still missing), no avatars, avatar list failed, renderer offline, uploading audio, queuing, rendering with a percent and a clip count, done, and error (upload failed, could not start, renderer offline, lost contact with the job, failed on the server, timed out). Server errors include `502 worker_unreachable`/`worker_error`, `502 reference_image_failed` (no thumbnail and the portrait render did not succeed), and `503 worker_unconfigured`.
- **Deployment requirement.** `LONGCAT_WORKER_URL` and `LONGCAT_WORKER_KEY` must both be set on the API service; without them `GET /api/avatar/video-generate` reports `available: false` and every submission answers `503 worker_unconfigured`.
- **Output.** MP4, downloaded straight from the worker's `video_url`.

## Related

- [Voice Lab](./voice-lab.md): clone or synthesize the audio track you upload here.
- [Lipsync](./lipsync.md): the real-time, in-browser lipsync path (no export).
- [Selfie to Avatar](./selfie-to-avatar.md) and [Avatar reconstruction](./avatar-reconstruction.md): create the avatar you render.
- Pages: [/create/video](https://three.ws/create/video), [/create](https://three.ws/create), [/dashboard](https://three.ws/dashboard).
