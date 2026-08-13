# Mocap Studio: drive a 3D avatar with your face, live in the browser

Mocap Studio turns your webcam into a face-mocap rig. Point the camera at yourself and a three.ws avatar mirrors your expressions and head movement in real time: eyes, brows, mouth, jaw, and head pose, all in the browser, with no rig setup, no plugin, and no download. Calibrate to your neutral face, record a clip, replay it, and save it. Saved clips can be private, unlisted, or public, and you can replay anyone's public clips on the avatar too.

Page: [/mocap-studio](https://three.ws/mocap-studio) · API: `/api/mocap/clips`

## Why it exists

Facial motion capture is normally a studio problem: markers, a helmet cam, dedicated software, and an export pipeline. Mocap Studio collapses all of that into a web page. The camera you already have, the avatar you already made, and a couple of clicks are enough to get expressive, recorded facial animation. It exists so a three.ws avatar can emote like a person, not just play canned clips, and so that expressiveness is capturable, saveable, and shareable as data (a small JSON clip) rather than a heavy video.

## How it works

The engine is `FaceMocap`, built on Google's MediaPipe Face Landmarker (a newer model than the FaceMesh that older browser-rigging libraries use). Per frame it outputs 52 ARKit blendshape scores, 478 3-D face landmarks (including iris), and a 4x4 facial transformation matrix for head pose in camera space. The pipeline is:

```
webcam → Face Landmarker → calibration delta → one-euro smoothing →
  ARKit morph targets + head bone rotation on the avatar
```

- **Calibration** subtracts your resting face as a baseline, so a neutral expression maps to a neutral avatar instead of an involuntary smirk.
- **One-euro smoothing** (Casiez et al., 2012) is an adaptive low-pass filter: it stays crisp on fast motion and heavily smooths slow motion, the standard trick in mocap pipelines to kill jitter without adding lag.
- **The blendshapes** drive the avatar's ARKit morph targets (resolved through the platform's canonical morph map, so different avatar rigs all respond), and the head-pose matrix rotates the avatar's head (or neck) bone within a clamped range.

The avatar loads into a `Viewer` scene with a procedural idle (breathing, blinking, subtle saccades). While mocap drives the head, the idle pauses its saccade and blink channels so it does not fight your captured motion.

### Loading an avatar

The studio resolves an avatar in order: a `?handle=<name>` deep link, then the signed-in user's own public avatar, then the platform default (`/avatars/default.glb`) so the camera and mocap pipeline are always usable. You can also type any three.ws handle to load that user's public avatar.

### Record, replay, save

Recording uses `FaceMocap`'s built-in clip buffer: every frame's blendshapes and head matrix are appended. Stop, and you have a clip with a duration and frame count. Replay drives the same avatar from the buffer. Download saves the clip as a JSON file locally. Save posts it to `/api/mocap/clips` with a name, description, tags, and a visibility of private, unlisted, or public. The clip list below the stage shows your own clips plus public ones; you can replay any of them and delete your own.

## Walkthrough

1. Open [/mocap-studio](https://three.ws/mocap-studio). An avatar loads (yours if you are signed in with a public avatar, otherwise the default). To use someone else's, type their handle and load it.
2. Click "Start camera" and allow webcam access. Your face appears in the small preview; the avatar starts mirroring you.
3. Sit with a relaxed, neutral face and click "Calibrate neutral" so the resting baseline is captured.
4. Click "Record", perform (talk, smile, raise your brows, turn your head), then click "Stop". The timer shows the clip length.
5. Click "Replay" to watch the avatar perform the captured clip.
6. Give it a name (and optional description, tags, visibility), then "Save clip", or "Download" to keep the JSON locally.
7. Browse the clip list and replay any public clip on the avatar.

## Examples

Mocap Studio is a browser tool; its examples are its deep link and the clip API.

- **Load a specific handle's avatar:** `https://three.ws/mocap-studio?handle=<username>`

The clip format saved is the object `FaceMocap` records: `{ format, duration, frames: [{ t, shapes, mat? }] }`. The API:

```bash
# List your clips plus public ones.
curl 'https://three.ws/api/mocap/clips?include_public=true&limit=30' \
  -H 'authorization: Bearer <api key>'

# Save a recorded clip (visibility: private | unlisted | public). `format` must
# be one of three.ws.face-mocap.v1 / pose-mocap.v1 / hand-mocap.v1 / vmc.v1, and
# each frame is { t, shapes, mat? } where shapes maps a channel name to a weight.
curl -X POST 'https://three.ws/api/mocap/clips' \
  -H 'content-type: application/json' -H 'authorization: Bearer <api key>' \
  -d '{"name":"eyebrow-raise","visibility":"public","tags":["face"],
       "clip":{"format":"three.ws.face-mocap.v1","duration":3.2,
               "frames":[{"t":0,"shapes":{"browOuterUpLeft":0.0,"browOuterUpRight":0.0}},
                         {"t":0.5,"shapes":{"browOuterUpLeft":0.8,"browOuterUpRight":0.8}}]}}'

# Fetch one clip to replay it. The path segment takes either the clip UUID or
# its slug; a slug resolves to your own clip first, then to a public one.
curl 'https://three.ws/api/mocap/clips/eyebrow-raise' \
  -H 'authorization: Bearer <api key>'
```

A bearer API key is the simplest way to call these from a script. The same
endpoints accept a browser session cookie instead, but every write then also
needs a single-use `X-CSRF-Token` header from `GET /api/csrf-token`, which is
what the page itself sends.

## States & limits

- **Camera permission is required.** The whole pipeline depends on webcam access; nothing captures until you grant it. The video is processed locally in the browser to drive the avatar.
- **Calibrate for clean results.** Without calibration your resting expression is treated as neutral, so calibrate on a relaxed face for accurate deltas.
- **Head rotation is clamped.** The captured head pose drives the head/neck bone within a limited range, so extreme off-camera angles do not snap the neck.
- **Saving needs an account.** Recording, replaying, and downloading a clip are open to everyone; saving to the platform requires sign-in. An avatar association is only attached when you own the loaded avatar, otherwise the clip still saves, just without an avatar link.
- **Replay needs the camera started.** Playing a saved clip attaches to the same driver the camera set up, so start the camera before replaying a clip from the list.
- **Clips are data, not video.** A saved clip is compact JSON (blendshape scores plus head matrices per frame), so it is cheap to store and share and can replay on any compatible avatar, not a rendered movie.

## Related

- [Avatar Studio](./avatar-studio.md): build the avatar you drive here.
- [Animation Studio](./animation-studio.md): body posing and keyframed motion, the complement to facial capture.
- [Animations reference](./animations.md): how captured and authored motion fit the platform's clip registry.
- [/create](https://three.ws/create): make or import the avatar to perform with.
