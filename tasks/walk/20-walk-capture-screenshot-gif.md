# Task 20 — Walk Page: Capture (Screenshot + GIF Export + Share)

## Priority: MEDIUM

## Objective
Let users capture screenshots and short GIFs/MP4s of their avatar walking and share them — drives organic distribution. Twitter share with auto-generated OG card.

## Scope
- New module: `src/walk-capture.js`
- Screenshot:
  - `P` key (desktop) or camera icon (mobile) → captures the WebGL canvas via `renderer.domElement.toBlob('image/png')`
  - Resolution: full canvas size, retina-scaled
  - Optional: include HUD-rendered watermark "three.ws/walk?avatar=<id>" in bottom-right of capture (real text overlay, not fake)
  - Save dialog: download immediately + "Share to X" / "Share to Farcaster" buttons
- GIF / MP4 export:
  - Hold `R` key or record button → records up to 10 seconds
  - Use `MediaRecorder` API with `canvas.captureStream(60)` → records to webm; transmux to mp4 via `ffmpeg.wasm` (vendored in `public/vendor/ffmpeg-wasm/`)
  - Show recording indicator (red dot + countdown)
  - On stop: preview modal with download + share buttons
- Share to X (Twitter):
  - Upload media via `/api/share/x` (build the endpoint if missing — uses X API v2 with `X_BEARER_TOKEN` from env)
  - Tweet text: "I walked my avatar around three.ws — try yours: three.ws/walk?avatar=<id>"
- Share to Farcaster:
  - Use Frames v2 — generate a frame URL at `https://three.ws/api/frames/walk?avatar=<id>` (real Vercel function)

## Definition of Done
- `P` saves a real PNG of the current scene
- `R` records a real 10s MP4 of the avatar walking
- Share to X posts a real tweet with the media attached
- Farcaster frame opens correctly in Warpcast
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real APIs, real ffmpeg, real share endpoints. Wire end-to-end.
