# Scene Capture: video to explorable 3D point cloud

Scene Capture turns a phone video of any space into an explorable 3D point cloud you can orbit in the browser. Film a room, a street, or an object, hand it a public video URL, and a streaming feed-forward reconstruction fuses the frames into a coloured `.ply` that renders live with WebGL. Already have a point cloud? Drop it in or paste a URL and skip straight to the viewer.

Page: [/capture](https://three.ws/capture) · API: `/api/scene-capture`

## Why it exists

Photogrammetry and SLAM traditionally mean an offline pipeline: extract frames, match features, bundle-adjust, and wait. Scene Capture collapses that into a single feed-forward pass: no per-scene optimization, no manual camera poses, just frames in and dense world-space geometry out. It is the fastest way to go from "I filmed this place on my phone" to "I can orbit this place in my browser," and because the output is a standard coloured `.ply`, it drops into any point-cloud tool afterward.

## How it works

The endpoint (`api/scene-capture.js`) routes to `workers/model-video2scene`, a Cloud Run GPU worker running **LingBot-Map**, a feed-forward Geometric Context Transformer that reconstructs dense world-space geometry directly from video frames. The worker and its model weights are ready; the service itself is not deployed yet, so today `/capture` runs the unconfigured path described below (sample cloud plus bring-your-own `.ply`) until `GCP_VIDEO2SCENE_URL` is set. You submit a public https URL to an mp4, mov, or webm; the handler resolves and validates the host itself (rejecting private, loopback, and metadata IPs as defense in depth against SSRF) before handing the URL to the worker. Submission returns `202 { job_id, status, eta_seconds }`, and the browser polls `GET /api/scene-capture?job=<id>` until the worker returns a `result_url` for the finished `.ply`, along with `num_points` and `frames`.

Reconstruction exposes real, clamped sampling knobs:

| Param | Range | Default | What it controls |
| --- | --- | --- | --- |
| `mode` | `streaming` / `windowed` | `streaming` | Continuous streaming fusion, or fixed-window batches. |
| `fps` | 1-30 | 8 | Frames sampled per second of video. |
| `keyframe_interval` | 1-64 | 4 | Spacing between keyframes. |
| `num_scale_frames` | 2-16 | 8 | Frames used to resolve metric scale. |
| `window_size` | 16-512 | 128 | Frame window for the windowed mode. |
| `conf_percentile` | 0-95 | 30 | Confidence floor for keeping a point. |
| `max_points` | 50k-3M | 1.5M | Cap on total output points. |
| `voxel_size` | 0-10 | 0 | Optional voxel downsampling. |
| `mask_sky` | bool | true | Drop sky pixels so open scenes don't fill with noise. |

One job covers 512 frames, which is 64 seconds at the default `fps: 8`. Fusion holds every pixel of every frame in memory at once, so the cap is host RAM, not model capability: film longer and lower `fps` rather than expecting a longer clip to be reconstructed whole. A longer input is reconstructed up to the cap, and the poll response carries `frames_truncated: true` so a partial scene never reads as the whole clip.

The result is a binary `.ply` the page renders client-side with a WebGL point-cloud viewer (`src/scene-capture.js` and `pointcloud-viewer.js`). Every state is designed: idle, submitting, processing (with an elapsed timer and stage hints), live, and error. There is no mock path: when the worker env (`GCP_VIDEO2SCENE_URL` and `GCP_RECONSTRUCTION_KEY`) is not configured, the endpoint returns a clean 503 and the page still proves the renderer end-to-end with a built-in sample room cloud. You can also load any `.ply` you already have by URL or file, so the viewer is useful even where reconstruction is offline.

## Walkthrough

1. Open [/capture](https://three.ws/capture).
2. Try the sample cloud first to confirm the viewer renders on your device.
3. To reconstruct, film a space, upload the video somewhere public, and paste its https URL. Slow, overlapping passes with good lighting reconstruct best.
4. Submit. A processing state shows the elapsed time and stage hints while the worker streams frames through LingBot-Map.
5. When the point cloud lands it renders live: orbit, zoom, and pan. The HUD shows the point count.
6. Download the `.ply`, or load a different cloud by URL or file.

## Examples

Reconstruction is an async job over a public video URL.

```bash
# Start a reconstruction from a public video, then poll for the .ply.
JOB=$(curl -s -X POST 'https://three.ws/api/scene-capture' \
  -H 'content-type: application/json' \
  -d '{"video_url":"https://example.com/room-walkthrough.mp4","mode":"streaming","fps":8}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("job_id",""))')

curl "https://three.ws/api/scene-capture?job=$JOB"
```

Tune sampling for a denser cloud from a longer clip:

```bash
curl -X POST 'https://three.ws/api/scene-capture' \
  -H 'content-type: application/json' \
  -d '{"video_url":"https://example.com/street.mp4","fps":12,"keyframe_interval":6,"max_points":2500000,"mask_sky":true}'
```

Poll until the cloud is ready in JavaScript:

```javascript
const start = await fetch('https://three.ws/api/scene-capture', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ video_url: 'https://example.com/object-orbit.mp4' }),
}).then((r) => r.json());

let job = start;
while (job.status !== 'done' && job.status !== 'failed') {
  await new Promise((r) => setTimeout(r, 4000));
  job = await fetch(`https://three.ws/api/scene-capture?job=${start.job_id}`).then((r) => r.json());
}
console.log(job.result_url, job.num_points); // coloured .ply + point count
```

## States and limits

- **Input** is a public https URL to an mp4, mov, or webm. Private, loopback, and metadata hosts are rejected before the worker sees the URL.
- **Processing**: a real elapsed timer with stage hints, driven by the poll lifecycle, not a fake bar.
- **Unconfigured (503)**: when the video2scene worker env is absent, the page falls back to a sample room cloud so the renderer still works end-to-end. No fabricated reconstruction is ever shown. The 503 body splits its audience: `message` is what `/capture` renders for a visitor, `hint` carries the env-var instructions for whoever runs the deployment.
- **Error**: an invalid `.ply` reports "that isn't a valid point cloud" (including a file that decodes to zero vertices, which is what a non-PLY does rather than throwing); a blocked fetch explains the CORS limit; a job that stops answering gives up after eight consecutive unreadable polls or twenty minutes, whichever comes first, and says how to restart it.
- **Truncated clips**: when the poll returns `frames_truncated: true`, the viewer's HUD label says the clip was cut to the frame budget, so a partial scene is never presented as the whole video.
- **Point cap** defaults to 1.5M and tops out at 3M; `voxel_size` and `conf_percentile` trade density for cleanliness.
- **Client-side rendering**: the `.ply` is decoded and displayed in the browser with WebGL; very large clouds are bounded by your device's GPU and memory.
- Rate limits are per client IP on the shared 3D generation buckets.

## Related

- [Splat Viewer](./splat.md) renders Gaussian-splat radiance fields, the photoreal cousin of point clouds.
- [/avatar-engines](https://three.ws/avatar-engines) covers the Geometric Context Transformer and related capture engines.
- [Forge](./forge.md) and [Image to 3D](./image-to-3d.md) for generating meshes from prompts and photos.
- Pages: [/scene](https://three.ws/scene) (Scene Studio), [/create](https://three.ws/create).
