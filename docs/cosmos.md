# Cosmos: living worlds behind your 3D avatar

Cosmos turns a sentence into a living, photoreal world that plays behind your 3D avatar. You pick an avatar, describe a place, and NVIDIA Cosmos renders a short cinematic video of that world; the platform composites it as a full-bleed backdrop behind your transparent avatar, so your character appears to stand inside a moving scene. Generate it, preview it live, and download the clip.

Page: [/cosmos](https://three.ws/cosmos) · API: `/api/cosmos`

## Why it exists

A 3D avatar on a flat gradient is a portrait. A 3D avatar standing in a neon Tokyo street in the rain is a scene. Cosmos gives every avatar a world to inhabit without a render farm, a game engine, or a video editor: you type the place, and a world model paints it in motion. It is the cinematic backdrop layer of the platform, the fastest way to put a character somewhere and make the result look alive.

## How it works

Cosmos runs on NVIDIA's Cosmos World Foundation Model family. The endpoint (`api/cosmos.js`) calls the **Text2World predict** model through NVIDIA's NVCF async gateway: a submit returns a request id, which is handed back to the browser as the `job_id`, and each poll asks NVCF for status and, on completion, persists the resulting MP4 to durable object storage (R2) and returns a stable URL. There is no server-side job store; the NVCF request id is the durable handle, exactly like the free TRELLIS text-to-3D lane. Cosmos predict renders roughly five seconds of 1280x704 video at 24fps, which on the shared free tier typically lands in 60 to 120 seconds.

The lane reuses the platform `NVIDIA_API_KEY` (the free NIM tier). When that key is absent, the lane reports itself unconfigured (503) and the page degrades gracefully: the avatar still stands on a designed, slowly shifting aurora backdrop instead of a blank void.

On the page (`src/cosmos.js`), the avatar is a Google `<model-viewer>` with a transparent background. Five humanoid avatars ship bundled for instant selection (Aria, Kai, Michelle, X-Bot, Mona), and you can bring your own. The generate flow is real async with no fake timers: submit to `POST /api/cosmos`, then poll `GET /api/cosmos?job=<id>` every four seconds (with a five-minute ceiling), driving a real elapsed-based progress state. When the clip is ready it plays on canplay as a looping backdrop behind the avatar, a regenerate control appears, and the clip is available to download.

## Walkthrough

1. Open [/cosmos](https://three.ws/cosmos).
2. Pick an avatar from the bundled set, or load your own GLB. The avatar renders immediately over the fallback aurora backdrop.
3. Describe a world in 3 to 300 characters, for example `a neon Tokyo street in the rain at night` or `a windswept desert canyon at golden hour`.
4. Optionally set a seed for a reproducible render.
5. Click Generate. A real progress state runs while the NVCF job renders; expect roughly 60 to 120 seconds on the free tier.
6. When the world lands it plays behind your avatar. Preview it, regenerate with a new prompt or seed, or download the clip.

## Examples

The Cosmos lane is a plain async HTTP job. Reuse the platform key server-side.

```bash
# Start a world render, then poll the NVCF job for the MP4.
JOB=$(curl -s -X POST 'https://three.ws/api/cosmos' \
  -H 'content-type: application/json' \
  -d '{"prompt":"a neon Tokyo street in the rain at night"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("job_id",""))')

curl "https://three.ws/api/cosmos?job=$JOB"
```

Example prompts that read well as living backdrops:

- `a neon Tokyo street in the rain at night`
- `a windswept desert canyon at golden hour`
- `a bioluminescent forest at midnight`
- `a rooftop garden above a foggy city skyline`
- `a snowy mountain pass under aurora`

A poll-until-ready loop in JavaScript:

```javascript
const start = await fetch('https://three.ws/api/cosmos', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'a bioluminescent forest at midnight' }),
}).then((r) => r.json());

if (start.status === 'done') console.log(start.video_url);
else {
  let job = start;
  while (job.status !== 'done' && job.status !== 'failed') {
    await new Promise((r) => setTimeout(r, 4000));
    job = await fetch(`https://three.ws/api/cosmos?job=${start.job_id}`).then((r) => r.json());
  }
  console.log(job.video_url); // durable MP4 URL
}
```

## States and limits

- **Prompt** must be 3 to 300 characters; an optional integer `seed` makes a render reproducible.
- **Render time** is roughly 60 to 120 seconds on the shared free tier; the client shows a real elapsed progress state and gives up after five minutes with a "try a simpler prompt" message.
- **Unconfigured (503)**: when `NVIDIA_API_KEY` is absent, the page keeps the avatar on a designed aurora backdrop and tells you generation is offline. No mock clip is ever shown.
- **Rate limited (429)** and **invalid key (401)** surface with honest messages and, where provided, a retry-after hint.
- Output is a durable MP4; the avatar is a standard GLB rendered with `<model-viewer>`.
- Rate limits are per client IP on the shared 3D generation buckets.

## Related

- [Forge](./forge.md) makes the 3D avatars and objects you place in a Cosmos world.
- [Avatar creation](./avatar-creation.md) and [the trait-based avatar builder](./character-studio.md) for building and dressing avatars.
- Pages: [/create](https://three.ws/create), [/gallery](https://three.ws/gallery), [/scene](https://three.ws/scene).
