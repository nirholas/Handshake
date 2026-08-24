# Rigging the pump.fun pill mascot

**[The pill](https://three.ws/pill) is a static capsule with four nubs that now walks, runs, waves, jumps and dances. This is how it got there, and how to do the same thing to a character our humanoid auto-rigger refuses.**

pump.fun verified $THREE as officially ours. The mascot they use is a rounded green-and-white capsule with a painted face, two stubby arms and two stubby legs, sculpted mid-stride. We rigged it and put it on a stage at [/pill](https://three.ws/pill).

The interesting part is not the result, it is why the normal path did not work and what replaced it. If you have a mascot, a logo character, a blob, a plush, or anything else that reads as a character to a person and as noise to a rigger, this page is for you.

**On this page:** [Why auto-rigging failed](#why-the-normal-path-failed) · [The pipeline](#the-pipeline) · [Running it](#running-it) · [What ships](#what-ships) · [Reusing it](#reusing-it-on-your-own-character)

Related: [the avatar pipeline](./avatar-pipeline.md) covers the normal humanoid path (generate, auto-rig, skin, animate). [Rig Doctor](./rig-doctor.md) tells you whether a finished `.glb` will actually animate here. [The 3D asset pipeline](./3d-asset-pipeline.md) covers FBX and GLB conversion upstream of all of it.

---

## Why the normal path failed

three.ws auto-rigs humanoids with Make-It-Animatable (`workers/rig`). It predicts joint positions for a 52-bone Mixamo skeleton from the shape of a body: a head on a neck, a torso, two long arms, two long legs, standing roughly upright.

The pill has none of those landmarks.

- **No neck and no separate head.** The white "head" is the top half of one continuous capsule. There is no narrowing anywhere for a neck predictor to find.
- **Nubs, not limbs.** Each arm is about 0.1 units thick and 0.47 long on a body 2.1 units tall. As a fraction of the figure, they are closer to fingers than to arms.
- **A sculpted action pose.** The right arm is thrown up beside the head, the right leg is kicked out to the side. Riggers expect a T-pose or an A-pose, and prediction quality falls apart away from one.
- **297,000 triangles.** Scan-quality density for a shape a hundredth of that describes exactly.

Feeding that to a humanoid predictor produces a skeleton in roughly the right bounding box and wrong everywhere that matters. So the pill got a purpose-built pipeline: [`scripts/rig-pill-mascot.py`](https://github.com/nirholas/three.ws/blob/main/scripts/rig-pill-mascot.py).

---

## The pipeline

### 1. Decimate first

[`scripts/decimate-glb.mjs`](https://github.com/nirholas/three.ws/blob/main/scripts/decimate-glb.mjs) takes the mesh from 296,962 triangles to 44,544 and the file from 12.58 MB to 1.68 MB, with no visible difference: the mascot's detail lives entirely in its texture, and quadric simplification is nearly free on a smooth organic surface.

Order matters. Simplification rewrites the vertex list, and skin weights are per-vertex, so decimating a rigged model destroys its rig. The script refuses to run on a mesh that already has `JOINTS_0`.

### 2. Find the limbs from the inside

The mesh is voxelized and its euclidean distance transform taken, which gives every interior voxel its distance to the surface: the shape's own thickness field. The body is everything thicker than a limb. Remove that and its fillet, and exactly four connected components are left over: the four nubs. No landmark detection, no template, no assumption about what a limb looks like.

The result is stable across a wide range of thresholds, which is the sign that the split is a real feature of the shape rather than a tuned constant.

### 3. Trace each nub back into the body

From each nub's tip, a minimum-cost path back to the body core (`skimage.graph.route_through_array`, with cost weighted to prefer thick interior) follows the limb's actual medial curve. That is how the mascot's bent foot ends up with a bent foot bone instead of a straight line through it, and how the knee lands where the leg actually bends.

Joints are then dropped along that curve: hip, knee, ankle, toe for legs; shoulder, elbow, wrist for arms, plus five three-joint finger chains inside each mitt.

### 4. Skin by what is inside, not what is nearby

This is the step that decides whether the rig looks rigged or looks melted.

In the sculpted pose, the mascot's raised hand rests **against the side of its head**. Straight-line distance says those two surfaces are neighbours. Geodesic distance through the mesh says the same thing, because they are touching. Skin either way and lowering the arm drags a crater across the cheek.

So membership is decided somewhere else entirely: each vertex climbs the thickness field's gradient inward until it reaches the medial axis of whatever part it is skin for. A hand vertex lands on the hand's axis. A cheek vertex lands on the body's. Those are half a body apart, and the head stays still.

That classification is a watershed, so it has hard edges. Two neighbouring vertices on the crotch webbing can climb to different ridges, and an unsmoothed seam tears into a fin the moment the leg swings. The classification is blurred across the surface before it is used, at a radius derived from the mesh's own vertex spacing so the same code behaves identically on the 300k-triangle original and its 45k-triangle decimation.

### 5. Bind mid-stride, rest standing

glTF stores the **bind pose** (inverse bind matrices) separately from the **rest pose** (node transforms), and three.ws's retargeter replays clip motion as a delta on the *rest* pose. A walk cycle applied on top of a mid-stride sculpt walks mid-stride: one arm stays in the air the whole time.

So the rigger binds against the sculpted pose, where the geometry actually is, solves a neutral standing pose, and bakes that pose into the shipped vertex positions. The file you download stands with its legs under its hips and its arms out, and its bind pose and rest pose are the same thing. Every clip after that starts from somewhere sane.

Blending a 50-degree leg correction closes the crevice between leg and belly, and linear blend skinning resolves a closing crevice by stretching it. The bake measures each vertex's neighbourhood before and after and relaxes only the vertices whose local spacing collapsed, leaving the 97% that posed cleanly untouched.

### 6. Animate for the proportions it has

Six clips ship inside the GLB: `idle`, `walk`, `run`, `wave`, `jump`, `dance`. They are authored as offsets from the rest pose, in code, against a mascot with nub limbs and no neck. A human mocap walk retargets onto this rig correctly and still looks wrong, because it was performed by something with knees.

`wave` deliberately returns the character to the pose it was sculpted in.

---

## Running it

The rigger needs a small scientific Python stack that is not part of the repo's npm tree:

```bash
pip install numpy scipy scikit-image trimesh pygltflib Pillow
```

Then, from the repo root:

```bash
# 1. Decimate the raw model (skip if yours is already reasonable)
node scripts/decimate-glb.mjs raw-mascot.glb public/avatars/my-mascot-static.glb --ratio=0.15

# 2. Rig it
python3 scripts/rig-pill-mascot.py public/avatars/my-mascot-static.glb \
    --out public/avatars/my-mascot.glb --debug-dir /tmp/rig-debug
```

`--debug-dir` writes two orthographic sheets, `sculpted.png` and `neutral.png`, with the skeleton drawn over the mesh in front, side and top view. Look at them before you look at the render: a joint in the wrong place is obvious there and ambiguous in a shaded viewport.

The run prints what it found, and those lines are the check that it understood the model:

```
  facing [0. 0. 1.] from 347 face pixels (painted 3.6 deg off axis)
  RightLeg   root [-0.313 -0.364 -0.008] tip [-0.565 -0.844  0.016] r=0.136
  LeftArm    root [ 0.359 -0.016 -0.008] tip [ 0.791 -0.22   0.028] r=0.100
  skeleton: 52 bones
  skinned: 46/52 bones carry weight above 2%
```

Forward is detected from the model's own texture: the eyes and mouth are the only near-black pixels on the head, so their centroid off the body axis gives the facing direction, snapped to the nearest world axis (the platform's convention is that avatars face +Z).

---

## What ships

`/avatars/pumpfun-pill-cupsey.glb`, 2.6 MB:

| | |
|---|---|
| Skeleton | 52 bones, `mixamorig:` names |
| Triangles | 44,544 |
| Clips | `idle`, `walk`, `run`, `wave`, `jump`, `dance` |
| Clip-library coverage | 100% (53 of 53 tracks map) |
| Validator | 0 errors |

The static input is kept beside it as `/avatars/pumpfun-pill-cupsey-static.glb` so the rig is reproducible from the repo.

The coverage number is the one that outlives this page. Because the skeleton uses the canonical bone names, [`src/glb-canonicalize.js`](https://github.com/nirholas/three.ws/blob/main/src/glb-canonicalize.js) maps every joint 1:1 and the whole three.ws clip library retargets onto the pill: it is not limited to the six clips it ships with. Load it in the [Animation Studio](https://three.ws/pose) and try any of them.

Finger chains are part of that. Thirty of the 53 tracks in every baked clip address a finger joint, and [`src/animation-retarget.js`](https://github.com/nirholas/three.ws/blob/main/src/animation-retarget.js) drops any clip whose coverage falls under 50%. A mascot with mitts still needs finger bones inside those mitts, or it throws away the entire library. They also give the mitt a soft squish when a clip curls a hand, which is a nicer result than the alternative.

---

## Reusing it on your own character

`scripts/rig-pill-mascot.py` is written for the capsule-with-nubs family, not for the pill specifically. Nothing in it is keyed to this model: no hardcoded joint positions, no baked-in dimensions, no character name. It will rig any mesh that satisfies these:

- **One body mass and exactly four limbs.** The limb finder expects four leftover components and stops with a clear error if it finds a different number. A five-limbed character needs the bone map extended; a two-limbed one needs the skeleton definition trimmed.
- **Limbs meaningfully thinner than the body.** The split is `thickness > 0.26` in model units by default (`BODY_THICKNESS`). A character whose arms are as thick as its torso has no such split to find.
- **A sealed surface.** Small holes are closed automatically before the flood fill; a hole you could see through is refused rather than guessed at.
- **A visible face.** Forward is read from dark pixels on the head. A character with no painted face falls back to +Z.

If your character is genuinely humanoid, do not use this. Use the [standard auto-rigger](./avatar-pipeline.md), which is a one-call API and better at humanoids than this script will ever be.
