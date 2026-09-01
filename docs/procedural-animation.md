# Procedural animation

Pre-baked clips can only replay motion that was recorded somewhere else. They cannot know where your cursor is, that the ground under an avatar's left foot is 15 cm lower than under its right, or that the agent is supposed to be looking at the person it is talking to. Procedural animation fills that gap: a set of small layers that run **after** the animation mixer each frame and adjust the pose the clip just produced.

The layers live in [`src/procedural/`](../src/procedural). They are rig-agnostic by the same rule as the rest of the animation stack (see [animations.md](animations.md) and the universal-rig doctrine in [CLAUDE.md](../CLAUDE.md)): joints are resolved through the canonical bone map, so any humanoid the retargeter can drive, these can drive too. A rig they cannot drive reports `enabled === false` and every method becomes a no-op — never a broken pose.

> **This is not the idle layer.** Breathing, blinking, eye saccades, and weight shift already exist in [`src/idle-animation.js`](../src/idle-animation.js) (`IdleAnimation`) and are unchanged. That layer adds ambient life to a *static* avatar. This one reacts to the *world*: a target to look at, a ground to stand on.

---

## The contract every layer follows

All three layers work the same way, and getting this order wrong is the only way to make them misbehave:

1. **Construct once per attached model.** The constructor resolves and caches bone references. Build a new controller whenever you swap the avatar.
2. **Call `update(dt)` every frame, after `mixer.update(dt)`.** The layer reads the pose the mixer just wrote and adds an offset to it.
3. **Never call it before the mixer.** Your offset would be overwritten and you would see nothing.

```js
import { LookAtController } from './procedural/look-at.js';

const look = new LookAtController(model);

function frame(dt) {
  animationManager.update(dt); // 1. mixer poses the skeleton
  look.update(dt);             // 2. procedural layer adjusts it
  renderer.render(scene, camera);
}
```

### Why the layers do not drift

A layer adds an offset to a bone the mixer just posed. When a clip drives that bone, the mixer rewrites it every frame and the offset can simply be re-applied. But when **nothing** rewrites it — no clip playing, or a clip that does not track that particular joint — naively re-applying would compound frame over frame and spin the joint into the ground.

[`pose-baseline.js`](../src/procedural/pose-baseline.js) solves this. Before computing, each layer compares the bone's current value against what it wrote last frame. Identical means nobody else touched it, so the pre-offset base is restored first. Different means the mixer (or another system) owns the pose now, so the current value becomes the new base. The result is that every layer is idempotent, and layers compose with clips, with the additive gesture overlay, and with each other.

---

## `LookAtController` — turn toward a point in the world

The avatar's chest, neck, and head turn to face a world-space point, on top of whatever clip is playing. This is what makes a companion track your cursor and an agent meet your eyes instead of staring through you.

```js
import { LookAtController } from './procedural/look-at.js';

const look = new LookAtController(model);
if (look.enabled) {
  look.setTarget(new Vector3(2, 1.6, 3)); // a world-space point
  // ...each frame, after the mixer:
  look.update(dt);
}
look.setTarget(null); // release; the gaze fades back to the clip
```

The turn is **distributed across three joints**, and that is the whole point. A 50-degree turn written to the head bone alone reads as an owl; split roughly 15% chest / 30% neck / 55% head it reads as a person. Joints the rig does not have forfeit their share to the ones it does, so a rig with no upper chest still looks correct.

| Option | Default | What it does |
|---|---|---|
| `maxYaw` | 65° | Horizontal clamp. A target further round than this is clamped, not chased. |
| `maxPitchUp` / `maxPitchDown` | 30° / 35° | Vertical clamps, asymmetric because looking down is more natural than up. |
| `damping` | 10 (1/s) | How fast the gaze converges. Higher snaps sooner. |
| `fadeRate` | 5 (1/s) | How fast the whole layer fades in and out. |
| `canonicalToNode` | — | Reuse an already-built canonical bone map instead of re-traversing the model. |

Two behaviours worth knowing:

- **Targets behind the avatar are refused, not clamped.** Past 120° of yaw the layer fades itself out entirely and hands the pose back to the base animation. Pinning a head at its clamp while something stands behind it looks strained; releasing looks natural.
- **The model's own rotation is accounted for.** The target is transformed into model space before the angles are measured, so an avatar that has turned to face a new direction does not also crank its neck.

## `FootPlantController` — stand on uneven ground

Locomotion code can only put the rig's *origin* on the ground. On any slope that means one foot floats and the other sinks through. This layer reads where the ground actually is under each foot, drops the pelvis just enough that the downhill leg can reach, and bends each leg with two-bone IK so both feet land on their own patch of terrain.

```js
import { FootPlantController } from './procedural/foot-plant.js';

const plant = new FootPlantController(model, (x, z) => terrain.heightAt(x, z));
// ...each frame, after the mixer and after the rig has been placed on the ground:
plant.update(dt);
```

The second argument is any function returning world-space ground height for an `(x, z)`. In the walkaround world that is `terrain.heightAt`; in a flat scene, `() => 0` (which correctly makes the whole layer a no-op).

The animation's own foot lift is preserved. Each foot is moved by the terrain's height **difference** under it, not to an absolute height, so a foot in mid-swing keeps its swing clearance and a planted foot sits flush. After the legs are solved, each ankle's animated world orientation is restored, so toes keep pointing where the clip aimed them rather than tilting with the knee.

| Option | Default | What it does |
|---|---|---|
| `maxDrop` | 0.35 m | How far the pelvis may sink. Caps the crouch on extreme terrain. |
| `maxLift` | 0.6 m | How far a single foot may be raised. |
| `damping` | 12 (1/s) | Smoothing on both the pelvis drop and each foot offset. |

Read-only accessors for instrumentation and tests: `pelvisOffset` (current damped drop, in world metres, always `<= 0`) and `footWorldPositions()` (each solved foot's world position — allocates, so never call it in the render loop).

## `solveTwoBoneIK` — the solver underneath

An analytic two-bone IK solve for a root → mid → tip chain: hip → knee → ankle, or shoulder → elbow → wrist. It is the closed-form law-of-cosines formulation, so there is no iteration and nothing to tune for convergence, and it allocates nothing per call.

```js
import { solveTwoBoneIK } from './procedural/two-bone-ik.js';

root.updateWorldMatrix(true, true); // caller owns world-matrix hygiene
const ok = solveTwoBoneIK(hip, knee, ankle, targetWorldPos, {
  pole: kneePoleWorldPos, // which way the knee bends
  softness: 0.98,         // refuse the last 2% of extension
});
```

- **`pole`** decides which way the middle joint bends — knee forward, elbow back. It also breaks the tie when the chain starts perfectly straight and there is no bend plane to infer.
- **`softness`** caps how far the chain will extend as a fraction of its full reach. The default 0.98 is what prevents the harsh straight-leg snap when a target sits at the limit.
- Returns `false` only for a degenerate chain (a zero-length bone). An out-of-reach target returns `true` and extends the chain toward it as far as it goes, which is the behaviour you want at the edge of a step.

Bone lengths are preserved exactly; the solve only ever rotates.

> **Why not `CCDIKSolver` from three.js?** It is iterative, it needs a `SkinnedMesh`-specific setup with `iks[]` descriptors indexed into `skeleton.bones`, and it is tuned for MMD-style chains. This solve is exact for the three-joint case, works on any `Object3D` chain, and is deterministic — which is what lets the foot planter damp it frame to frame without jitter.

---

## Where it runs today

| Surface | Layer | Where |
|---|---|---|
| Corner walk companion | Look-at (cursor gaze) | [`walk-sdk/src/companion.js`](../walk-sdk/src/companion.js) `_updateGaze()` |
| The walkaround world (`/walk`) | Foot planting on terrain | [`src/walk.js`](../src/walk.js) `rebuildFootPlant()` (in AR mode the ground callback returns the flat `GROUND_Y`, so the layer stands down) |
| `/walk` NPCs | Look-at (they watch the player) | [`src/walk-npcs.js`](../src/walk-npcs.js) `_updateGaze()` |
| Agent avatars (`AgentAvatar`) | Look-at (`setLookTarget`, `LOOK_AT`) | [`src/agent-avatar.js`](../src/agent-avatar.js) `_applyLookTarget()` |
| `<agent-3d>` web component | Look-at (`lookAt()` public API) | [`src/runtime/scene.js`](../src/runtime/scene.js) `lookAt()` |

### The companion's cursor gaze

On by default; pass `lookAt: false` to `createWalkCompanion()` to keep the pre-0.4 fixed gaze. It also switches itself off under `prefers-reduced-motion`, on touch devices with no fine pointer, and after the cursor has been still for four seconds — in each case the gaze fades back to the clip rather than freezing mid-turn.

### Agent avatars

`AgentAvatar.setLookTarget(worldPos)` and the `LOOK_AT` protocol action now actually move the avatar. Before this layer they stored a target that nothing read, so both were silently inert.

```js
agentAvatar.setLookTarget(new Vector3(1, 1.5, 2)); // look at a world point
agentAvatar.setLookTarget(null);                   // release
```

`LOOK_AT` with `target: 'user'` (or `'camera'`) tracks the **live** camera position each frame, so the gaze holds while the viewer orbits. An explicit `setLookTarget()` always overrides camera tracking.

### The `<agent-3d>` component

`lookAt()` on the web component (and on `SceneController`) takes a `Vector3` or one of `'camera'`, `'user'`, `'center'`, or `null` to release:

```js
document.querySelector('agent-3d').lookAt('user');
```

The gaze is a **standing state**, not a one-off pose write: it re-applies after the mixer every frame, so it survives on an avatar that is playing a clip. The named targets re-resolve each frame, so `lookAt('camera')` keeps holding the viewer's eyes while they orbit. A rig with no head chain falls back to yawing the whole model, which is the best a headless rig can do.

### `/walk` NPCs

Every NPC watches the player within 14 m — wider than the 4 m greeting range, because noticing someone happens long before greeting them. A wanderer can glance over without breaking stride, since the gaze is an overlay on the walk cycle rather than a replacement for it. Past the clamp the layer releases rather than pinning the head, so an NPC the player has walked behind simply returns to its clip.

The NPC gaze report (`gazeReport(target)` on the object `createWalkNpcs()` returns) lists each NPC's `dist`, `alignment` (null when the rig exposes no head chain), `tracking` (true while a headed rig is inside the 14 m gaze range), and `headYaw`, which is what the Playwright checks read to prove a gaze actually moved a head.

---

## Adding a layer

New layers belong in `src/procedural/` and must follow the contract above: cache bones in the constructor, expose `enabled`, be a no-op when the rig cannot support them, use `pose-baseline.js` if you write to bones a clip may not track, and allocate nothing in `update()`. Export it from [`index.js`](../src/procedural/index.js), cover it in [`tests/procedural-anim.test.js`](../tests/procedural-anim.test.js) against synthetic bone chains, and add a row to the table above.

If you hit a rig whose bones do not resolve, the fix is a bone-name mapping in [`src/glb-canonicalize.js`](../src/glb-canonicalize.js) (with a case in `tests/glb-canonicalize.test.js`) — never a hardcoded rig list in the layer.

## Related

- [animations.md](animations.md) — the pre-baked clip library these layers run on top of
- [avatar-pipeline.md](avatar-pipeline.md) — how avatars are generated and rigged
- [agent-system.md](agent-system.md) — `AgentAvatar`, the protocol, and the emotion layers
