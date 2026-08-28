<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/motion</h1>

<p align="center"><strong>Text and structure to full-body 3D animation. No motion capture, no model weights, no renderer.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/motion"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/motion?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/motion"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/motion?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/motion?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/motion?color=339933&logo=node.js">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-3b82f6">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-motion-score">Motion Score</a> ·
  <a href="#api">API</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws/motion">three.ws/motion</a>
</p>

---

Every other way to get a new animation needs data you do not have: a motion
capture stage, a licensed clip library, or a diffusion model trained on one.
This package needs a sentence.

```js
import { motionFromText } from '@three-ws/motion';

const { clip } = motionFromText('wave hello twice, excitedly');
// clip is a three.js AnimationClip.toJSON() document, ready to play
```

It works because a human body is a solved kinematics problem. Give a solver the
places a body should be at a few moments in time, plus how it should get there,
and it can produce the joint rotations for every frame between, with the feet on
the floor, the weight over them, and the shoulders doing what shoulders do. The
hard part was never the math, it was the authoring format, and that is what a
**Motion Score** is: an animation written in anatomy and timing rather than in
quaternions, which means a language model can write one and a person can read
the diff.

## Why

- **Nothing to download.** No `.fbx` library, no weights, no GPU. Zero
  dependencies, and it runs in a browser tab, a Node script, or a serverless
  handler from the same code path.
- **Deterministic.** The same score compiles to the same clip, byte for byte,
  forever. Cacheable, diffable, and regression-testable.
- **It plays on anything humanoid.** The output is standard clip JSON with
  canonical bone names, so it retargets onto Mixamo, Avaturn, VRM, Ready Player
  Me, Unreal and Daz rigs through any retargeter that speaks them.
- **It knows about bodies.** Feet stay on the floor, the centre of mass stays
  over the support base, the clavicle helps a long reach, and the whole thing
  breathes. Those are the four things that separate a synthesized motion from a
  mannequin changing shape.

## Install

```bash
npm install @three-ws/motion
```

## Quick start

### From a prompt

```js
import { motionFromText } from '@three-ws/motion';
import { AnimationClip, AnimationMixer } from 'three';

const { clip, score, matched } = motionFromText('sit down heavily');

const mixer = new AnimationMixer(avatar);
mixer.clipAction(AnimationClip.parse(clip)).play();
```

`motionFromText` uses the built-in lane, which recognizes about twenty actions
with their modifiers (side, direction, manner, repetition) and needs no network
and no API key. It throws `code: 'unrecognized_motion'` for anything outside
that vocabulary, which is the signal to hand the prompt to a model instead.

### From a model

Give any tool-calling model `scoreSchema()` and let it author the score. Every
enum in the schema is generated from the same vocabulary the solver reads, so a
model cannot invent a word the compiler will reject.

```js
import { compileScore, scoreSchema } from '@three-ws/motion';

const score = await yourModel.json({
  system: 'Write a Motion Score for the described movement.',
  user: 'She looks up from her desk, considers it, then shakes her head slowly.',
  schema: scoreSchema(),
});

const { clip, warnings } = compileScore(score);
```

### By hand

```js
import { compileScore } from '@three-ws/motion';

const { clip } = compileScore({
  name: 'thinking it over',
  beats: [
    { label: 'still', posture: 'easy', hold: 0.4 },
    {
      label: 'hand to chin',
      posture: 'easy',
      arms: { right: { at: 'chin', palm: 'in', hand: 'loose', elbow: 'down' } },
      gaze: 'aside',
      face: 'focused',
      in: 0.5,
      hold: 1.2,
    },
    { label: 'decides', posture: 'proud', gaze: 'forward', face: 'smile', in: 0.45, hold: 0.5 },
  ],
});
```

## The Motion Score

A score is a list of **beats**. A beat is where the body is at one instant, how
long it takes to get there (`in`), and how long it stays (`hold`). Nothing in it
is a bone name.

```json
{
  "name": "greeting",
  "loop": false,
  "effort": "playful",
  "beats": [
    { "posture": "easy", "hold": 0.2 },
    {
      "label": "hand up",
      "posture": "easy",
      "arms": { "right": { "at": "overhead", "up": -0.08, "palm": "forward", "hand": "open", "elbow": "out" } },
      "gaze": "forward",
      "face": "smile",
      "in": 0.36,
      "hold": 0.1
    },
    { "label": "lower", "arms": { "right": { "at": "side", "hand": "relaxed" } }, "in": 0.5, "hold": 0.2 }
  ]
}
```

| Field     | What it says                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------- |
| `posture` | a whole-body shape (`stand`, `crouch`, `sit`, `lunge`, `bow`, `tiptoe`, …) that seeds the rest   |
| `root`    | hip `height` as a fraction of standing, plus `forward` / `side` travel, `rise`, and `turn`       |
| `torso`   | `lean`, `twist`, `sideBend`, in degrees, distributed along the spine                             |
| `arms`    | per side: an anchor (`chin`, `sternum`, `overhead`, `thigh`, `front`, …), offsets, palm, hand    |
| `legs`    | a `stance`, or per-foot placement with `plant` (`flat`, `toe`, `heel`, `lift`)                   |
| `gaze`    | a named look, or explicit `yaw` / `pitch`                                                        |
| `face`    | a named expression, mapped to ARKit blendshape weights                                           |
| `effort`  | how it is performed: `weight`, `time`, `flow`, or a preset like `sharp` / `weary` / `sustained`  |

**Effort is not decoration.** It picks the easing curve, scales the travel time,
and sets how far a limb overshoots before it settles, which is what makes the
same three shapes read as a wave, a swat, or a salute.

The full field reference is
[specs/MOTION_SCORE.md](https://github.com/nirholas/three.ws/blob/main/specs/MOTION_SCORE.md).

## API

| Export                          | What it does                                                             |
| ------------------------------- | ------------------------------------------------------------------------ |
| `motionFromText(prompt, opts)`  | prompt to `{ clip, score, matched, warnings }`, no model needed           |
| `compileScore(score, opts)`     | score to `{ clip, score, warnings }`                                      |
| `validateScore(input)`          | `{ ok, score, error }` with the exact path that failed                    |
| `normalizeScore(input)`         | the same, but throws                                                      |
| `scoreSchema()`                 | JSON Schema for a tool call, generated from the live vocabulary           |
| `motionCapabilities()`          | schema, limits, and known actions in one object                           |
| `composeScore(prompt, opts)`    | the model-free lane on its own, returning a raw score                     |
| `describeScore(score)`          | one readable line: duration, beats, and what happens                      |
| `solveBeat(beat)`               | one beat to a solved `Pose`                                               |
| `buildClip(keys, opts)`         | solved poses to a clip document                                           |

`compileScore` options: `idle` (breathing and micro-sway, default on),
`rootMotion` (the hip translation track, default on, turn off for a clip that
must play in place), `fingers` (default on).

The kinematics layer is exported too, for callers building an editor or a
different authoring format:

```js
import { restPose, solveArm, solveLeg, solveSpine, anchorPoint, centreOfMass } from '@three-ws/motion';

const pose = restPose();
solveArm(pose, 'Right', { wrist: anchorPoint(pose, 'chin', { side: 'Right' }), palm: [0, 0, 1] });
```

Or import it on its own, with none of the score machinery:

```js
import { Pose, solveTwoBone, BODY_FORWARD } from '@three-ws/motion/rig';
```

## CLI

```bash
npx @three-ws/motion "wave hello twice, excitedly" -o wave.json
npx @three-ws/motion --score sit.json --no-idle --no-root -o sit.json
npx @three-ws/motion --schema      # the score schema, for a tool call
npx @three-ws/motion --actions     # what the model-free lane knows
```

## How it works

Each beat is solved in an order that matters:

```
root      where the hips are, which everything below hangs from
turn      the body's heading, so limbs solve in the turned frame
torso     lean, twist, side-bend, shared along the spine
legs      ankles placed in WORLD space, so dropping the hips bends the knees
balance   the hips nudged until the centre of mass sits over the feet
arms      wrists placed against anchors that ride the posed chest
hands     shape, after the wrist is where it belongs
gaze      last, so a look is relative to the chest it ended up on
```

Reverse any two and the result is subtly wrong in a way that is impossible to
fix downstream. Solve the arms before the torso and every gesture sits where the
chest used to be. Solve the legs before the root and a crouch drives the feet
through the floor.

Four details do most of the work:

- **Feet are placed against the floor, not against the hips.** The hips are free
  to drop, lean and turn; the legs absorb it through IK, which is what a real
  body does and why a crouch looks like a crouch.
- **Balance is measured, not assumed.** The centre of mass is a mass-weighted
  sum over the segments that carry a body's weight, and the hips are moved until
  it sits over whichever feet are carrying weight. A lifted foot carries none,
  so a single-leg beat shifts the body over the standing leg on its own.
- **The clavicle helps.** An arm is not two bones on a fixed socket. The
  shoulder girdle swings toward a distant target, which is worth ten to fifteen
  centimetres of reach and most of what makes a reach read as a whole body
  reaching.
- **Easing is baked as geometry.** A mixer slerps between quaternion keys
  linearly, so an ease named in the score has to exist as extra samples in the
  track or it is not there at all.

The reference skeleton is measured from a real rig's bind pose rather than
assumed: bone lengths, segment directions, the body's own forward axis, and the
hand frame are all read from the data, so re-measuring a different rig changes
the numbers and not the code.

## Playing the clip on a different rig

The output uses canonical bone names (`Hips`, `Spine2`, `LeftForeArm`,
`RightUpLeg`, …). To play it on a rig with different names, run it through a
retargeter: three.ws ships one that maps Mixamo, Avaturn, Unreal, VRM/VRoid,
Daz, MakeHuman and Blender conventions onto the same canonical set.

```html
<script type="module" src="https://three.ws/agent-3d.js"></script>
<agent-3d src="agent://base/42" clip="https://example.com/wave.json"></agent-3d>
```

## Related

- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) renders
  the avatar this drives.
- [`@three-ws/mocap`](https://www.npmjs.com/package/@three-ws/mocap) is the
  captured half: a webcam performance saved as a clip.
- [`@three-ws/pose`](https://www.npmjs.com/package/@three-ws/pose) is named
  static poses, where this package is motion between them.
- [three.ws/motion](https://three.ws/motion) is the studio: type a sentence,
  watch any avatar perform it, and export the GLB.

## License

Apache-2.0
