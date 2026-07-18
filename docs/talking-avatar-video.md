# Talking Avatar Video: render a lip-synced clip from an avatar

Pick one of your three.ws avatars, upload an audio track, add an optional scene description, and a GPU worker renders a lip-synced talking-head video you can download as MP4. The lipsync and rendering happen server-side on a dedicated Cloud Run worker; the browser is just a picker, an uploader, and a player.

Page: [/create/video](https://three.ws/create/video)
API: `POST /api/avatar/presign-audio` · `POST /api/avatar/video-generate` · `GET /api/avatar/video-status`

## Why it exists

Real-time browser lipsync (see [Lipsync](./lipsync.md)) is perfect for live avatars, but it cannot produce a finished, shareable file with rendered frames, matched motion, and a scene. Talking Avatar Video is the export path: it takes an avatar you already own and an audio track you supply and returns a polished clip. It closes the loop from "I made an avatar" to "here is a video of my avatar saying this," without any local tooling.

Note on scope: the shipped flow uploads an audio file. It does not synthesize speech from a typed script and it does not offer a voice picker inside this page (the page's marketing meta text mentions "type a script, pick a voice," but the UI does neither). To generate the audio first, use [Voice Lab](./voice-lab.md) and bring the resulting clip here.

## How it works

The page ([`pages/create/video.html`](../pages/create/video.html)) loads [`src/create-video.js`](../src/create-video.js), which uses `apiFetch` from [`src/account.js`](../src/account.js) and a `<model-viewer>` preview.

1. **Auth gate.** On load it checks `GET /api/auth/me`; if you are not signed in it redirects to `/login?next=%2Fcreate%2Fvideo`.
2. **Pick an avatar.** It calls `GET /api/avatars` and renders your avatar library into a thumbnail bar, auto-selecting the first. The selected GLB is shown in a `<model-viewer>`. Private avatars resolve their GLB lazily through `GET /api/avatars/:id` (a short-lived signed URL). With no avatars it falls back to `/avatars/default.glb`.
3. **Upload audio.** Drag in or pick a WAV, MP3, M4A, OGG, or FLAC file. The client POSTs `{ filename, content_type }` to `/api/avatar/presign-audio`, gets a presigned PUT URL plus a `public_url`, and PUTs the raw bytes to R2/S3. If presign fails it falls back to a base64 data URI.
4. **Describe the scene (optional).** A textarea takes a scene description such as "A person speaking on a stage with dramatic lighting." This is a scene prompt, not a script.
5. **Generate.** With an avatar and audio ready, Generate POSTs `{ image_url, audio_url, avatar_id?, prompt? }` to `/api/avatar/video-generate`. The server SSRF-guards both URLs (https on the app or S3 domain), resolves the avatar image if only an `avatar_id` was sent (with an ownership/visibility check), and forwards to the worker.
6. **Render, server-side.** The generate endpoint calls the **LongCat-Video-Avatar-1.5** worker on Google Cloud Run (`POST {LONGCAT_WORKER_URL}/generate`, bearer-authenticated), which produces the lip-synced frames. The endpoint returns `202 { job_id, status }`.
7. **Poll.** The client polls `GET /api/avatar/video-status?job_id=...` every 5 seconds (20-minute safety timeout). Status runs `queued` -> `running` -> `done` | `failed`, with an optional `progress` (0 to 1).
8. **Download.** On `done`, the `video_url` is set as the `<video>` source and the download anchor (`download="avatar-video.mp4"`). Progress copy: "Takes 2 to 4 minutes on GPU. Hang tight."

## Walkthrough

1. Open [/create/video](https://three.ws/create/video) and sign in.
2. Pick an avatar from the thumbnail bar; it loads into the preview.
3. Drop in or browse for an audio file (WAV, MP3, or M4A).
4. Optionally type a scene description.
5. Press Generate video. Watch the status: uploading audio, queuing, rendering frames with a percentage.
6. When it finishes, play the result inline and press Download to save the MP4, or New video to start over.

## Examples

All three endpoints require a signed-in session.

```bash
# 1. Presign an audio upload slot.
curl -X POST 'https://three.ws/api/avatar/presign-audio' \
  -H 'authorization: Bearer <TOKEN>' -H 'content-type: application/json' \
  -d '{ "filename": "line.mp3", "content_type": "audio/mpeg" }'
# -> { "upload_url": "<PUT url>", "public_url": "https://…/line.mp3", "storage_key": "u/<uid>/audio/<uuid>.mp3" }

# 2. PUT the raw bytes to the presigned URL.
curl -X PUT '<PUT url>' -H 'content-type: audio/mpeg' --data-binary @line.mp3

# 3. Kick off generation with an avatar image + the uploaded audio.
curl -X POST 'https://three.ws/api/avatar/video-generate' \
  -H 'authorization: Bearer <TOKEN>' -H 'content-type: application/json' \
  -d '{ "image_url": "https://…/avatar.png", "audio_url": "https://…/line.mp3",
        "avatar_id": "<AVATAR_ID>", "prompt": "A person talking on a bright stage." }'
# -> 202 { "job_id": "…", "status": "queued" }

# 4. Poll until done, then fetch video_url.
curl -H 'authorization: Bearer <TOKEN>' \
  'https://three.ws/api/avatar/video-status?job_id=<JOB_ID>'
# -> { "job_id": "…", "status": "done", "progress": 1, "video_url": "https://…/out.mp4", "error": null, "updated_at": "…" }
```

`audio_url` is required; `image_url` may be omitted when `avatar_id` is present (the server resolves the avatar's stored image). `prompt` defaults to "A person talking naturally."

## States and limits

- **Auth required.** The page gates on `/api/auth/me`; every endpoint re-checks the session and returns `401` otherwise.
- **Free tier: one lifetime generation.** Free-plan users get exactly one video. The quota is reserved race-safely (a `usage_events` row is inserted before the worker call and released if submission fails, so an outage never burns the trial). On exhaustion the server returns `402 free_trial_used` and the page relabels the retry button "Upgrade plan" linking to `/dashboard`. Paid plans are unlimited.
- **Rate limits.** Per-user and global rate limits on `video-generate` return `429`.
- **Input formats.** Audio: WAV, MP3, M4A, OGG, FLAC (validated against an allow-list; `415` otherwise). Uploads go to R2/S3 under `u/{userId}/audio/{uuid}.{ext}`.
- **SSRF guard.** `image_url` and `audio_url` must be https on the app origin or the S3 public domain, else `400 invalid_request`.
- **Ownership.** `video-status` verifies the job belongs to you (`404` if unknown, `403` if another user's). Avatar image resolution enforces owner-or-public visibility.
- **Timing and errors.** Renders take ~2 to 4 minutes; the client times out after 20 minutes. UI states cover idle, uploading audio, queuing, rendering with a percent, done, and error (upload failed, could not start, failed on the server, timed out). Server errors include `502 worker_unreachable`/`worker_error` and `503 worker_unconfigured`.
- **Output.** MP4, downloaded straight from the worker's `video_url`.

## Related

- [Voice Lab](./voice-lab.md): clone or synthesize the audio track you upload here.
- [Lipsync](./lipsync.md): the real-time, in-browser lipsync path (no export).
- [Selfie to Avatar](./selfie-to-avatar.md) and [Avatar reconstruction](./avatar-reconstruction.md): create the avatar you render.
- Pages: [/create/video](https://three.ws/create/video), [/create](https://three.ws/create), [/dashboard](https://three.ws/dashboard).
