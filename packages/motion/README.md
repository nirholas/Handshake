# @three-ws/motion

**Text and structure into full-body 3D animation.** A Motion Score in, a
three.js `AnimationClip` out: forward and inverse kinematics, balance, ground
contact, and secondary motion, in plain JavaScript with no model, no GPU, and no
dependencies.

The same score always compiles to the same clip, byte for byte, which is what
makes a motion cacheable, diffable, and safe to regenerate.

## Install

```bash
npm install @three-ws/motion
```

## Two entry points cover almost every use

```js
import { motionFromText } from '@three-ws/motion';

const { clip, score, matched } = motionFromText('wave hello twice, excitedly');
// clip  -> an AnimationClip document, ready for THREE.AnimationClip.parse()
// score -> the Motion Score that produced it, so you can edit and recompile
```

```js
import { compileScore } from '@three-ws/motion';

const { clip, warnings } = compileScore(myScore, {
	idle: true,       // layer breathing and micro-sway on top (default)
	rootMotion: true, // emit the hip translation track (default)
	fingers: true,    // emit the finger bones (default)
});
```

`motionFromText` runs the **model-free lane**: it matches the prompt against a
known action vocabulary. When it does not recognise an action it throws, and the
message lists what it *does* know, so a caller can escalate to a model or tell
the user something useful instead of silently producing a T-pose.

```js
import { motionCapabilities } from '@three-ws/motion';
motionCapabilities(); // what this lane can do, for a capability check or a UI
```

## CLI

```bash
three-ws-motion "wave hello twice, excitedly" -o wave.json
three-ws-motion --score beats.json --loop --no-root -o clip.json
three-ws-motion --schema        # the Motion Score JSON Schema
three-ws-motion --actions       # every action this lane knows
```

| Option | Meaning |
| --- | --- |
| `-o, --out <file>` | Write the clip here (default: stdout) |
| `--score <file>` | Compile a Motion Score instead of a prompt |
| `--name <name>` | Clip name (default: the prompt, or the score's name) |
| `--loop` | Close the last beat back into the first |
| `--effort <name>` | Override the performance quality for every beat |
| `--no-idle` | Leave out the breathing and micro-sway layer |
| `--no-root` | Leave out the hip translation track, for a clip that plays in place |
| `--no-fingers` | Leave out the finger bones |
| `--score-out <file>` | Also write the Motion Score that produced the clip |

## The Motion Score

A score is a list of beats: what the body is doing, where it is looking, what the
hands are shaped like, and how the performance is played. It is plain JSON with a
published schema (`scoreSchema`), so it can be authored by a person, an editor, or
a model, and validated before anything is compiled.

```js
import { validateScore, normalizeScore, describeScore } from '@three-ws/motion';

const { valid, errors } = validateScore(score);
const normalized = normalizeScore(score);   // defaults filled, ranges clamped
describeScore(normalized);                  // a human-readable summary
```

The vocabulary is exported as data, not hidden behind the compiler:
`POSTURES`, `STANCES`, `HAND_SHAPES`, `ELBOW_POLES`, `ACTION_NAMES`, and their
`*_NAMES` lists. Build a picker straight from them.

## The solver, if you need it directly

An editor, a different score format, or a custom front end is a reasonable thing
to build on this, and should not have to fork it. The rig layer is exported:

| Export | What it does |
| --- | --- |
| `solveArm`, `solveLeg`, `solveSpine`, `solveGaze`, `solveTurn` | The IK chains |
| `shapeHand` | Finger posing from a named hand shape |
| `balanceError`, `balanceOffset`, `centreOfMass`, `supportCentre` | Keeping weight over the feet |
| `Pose`, `restPose`, `blendPose` | The pose representation and blending |
| `ANCHORS`, `anchorPoint`, `restAnchor`, `bodyDirection` | Named points on the body and the directions between them |
| `solveBeat`, `solveScorePoses`, `expressionWeights` | Score to poses |
| `buildClip`, `restClip`, `stableUuid` | Poses to an AnimationClip document |

`MOTION_BONES` is the canonical bone set the clips target; `LIMITS` and
`MOTION_SCORE_VERSION` pin the score contract.

## Related

- [`@three-ws/render`](../render): rasterize the resulting clip to PNG or GIF
  with no GPU, to see what a score actually looks like.
- [`STRUCTURE.md`](../../STRUCTURE.md): where every three.ws surface lives.

## License

Apache-2.0
