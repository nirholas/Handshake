# Rig Doctor

**[Rig Doctor](https://three.ws/rig-doctor) tells you whether a `.glb` will actually animate on three.ws, before you upload it anywhere.**

Drop a file and you get four things in about a second: a verdict, a limb-by-limb coverage score, a live preview of your own rig performing the real clip library, and (when the bone names need it) a repaired copy of the file to download.

Everything runs in your browser. The file is read with `FileReader` and analysed on your machine; no bytes are posted to any server. You can disconnect your network and the diagnosis still works.

**On this page:** [The problem](#the-problem-a-rig-that-loads-but-never-moves) · [Reading the verdict](#reading-the-verdict) · [Coverage](#coverage-which-limbs-will-move) · [The repair](#the-repair) · [Generated output](#generated-output) · [Conventions](#recognised-rig-conventions) · [The canonical skeleton](#the-canonical-skeleton) · [Programmatic use](#programmatic-use)

Related: [Avatar CLI](./avatar-cli.md) turns the generated manifest into a validated, hash-anchored file. The [web component reference](./web-component.md) covers the `<agent-3d>` element the embed tab emits. [Asset pipeline](./3d-asset-pipeline.md) covers FBX and GLB conversion upstream of all of this.

---

## The problem: a rig that loads but never moves

Every animation clip on three.ws is authored against one skeleton and stores its motion as tracks addressed **by bone name**: `Hips.quaternion`, `LeftForeArm.quaternion`, `RightUpLeg.quaternion`, and so on across 52 joints.

When your rig names those same joints something else, the track addresses a bone that does not exist. Nothing errors. The GLB parses, the materials render, the animation mixer runs at 60fps, and the character stands in its authored bind pose forever.

That failure is invisible from the outside, which is what makes it expensive. A creator exports from Unreal, uploads, sees a T-pose, and has no way to learn that the only problem was `upperarm_l` instead of `LeftArm`.

Rig Doctor moves that answer to the front of the process and makes it local.

---

## Reading the verdict

The banner at the top of the report is one of three levels. It mirrors the runtime gate exactly (`AnimationManager.supportsCanonicalClips()`), so what it says is what the platform will do.

### Ready

Every limb group resolved. Retargeted clips drive the whole character: torso, arms, hands, and legs.

The notes below the headline still carry useful detail, most often about lip-sync. A rig can be fully drivable and still lack the blendshapes that let it speak.

### Partial

The rig animates, but at least one limb group did not map and will stay at its bind pose while everything else moves.

This is the most common result, and the most common shape of it is **legs**. A halfbody avatar or a rig using a non-standard leg naming convention produces a character that glides across the floor with frozen knees during a walk cycle. The verdict names exactly which joints are missing.

### Will not animate

One of two things is true:

- **No skinned mesh.** There is no skin binding a mesh to a skeleton, so no clip can deform anything. The model renders as a static prop and every animation affordance is hidden. Fix it by re-exporting with skinning enabled, or by running the mesh through the auto-rigger (`POST /api/forge?action=rig` with a `glb_url`).
- **Under the joint floor.** Fewer than **8** joints mapped to the canonical set. Below that threshold a retargeted clip moves a limb or two on an otherwise frozen statue, which reads worse than not animating at all, so the platform substitutes the default rig instead.

---

## Coverage: which limbs will move

A single percentage is not actionable. "62% covered" does not tell a creator what to fix. Rig Doctor scores four groups independently, each with its own set of **key joints** whose absence is visible in motion:

| Group | Key joints | What breaks without them |
|---|---|---|
| Torso | `Hips` | Root motion and sway. Everything else hangs off this anchor. |
| Arms | `LeftArm`, `LeftForeArm`, `RightArm`, `RightForeArm` | Waves, claps, and gestures. The arms stay out at the bind pose. |
| Hands | `LeftHandIndex1`, `RightHandIndex1` | Sign language and detailed emotes. Walk cycles survive without fingers. |
| Legs | `LeftUpLeg`, `LeftLeg`, `RightUpLeg`, `RightLeg` | Walk and run cycles. The avatar slides instead of stepping. |

A group is marked **Will animate** only when every key joint mapped. The bar shows total coverage for that group including the non-key joints, so a rig with `LeftArm` but no `LeftShoulder` reads as drivable with an incomplete bar, which is exactly right: it moves, slightly less expressively.

Use the clip buttons under the live preview to see this directly. Each clip is labelled with the group it exercises, and a clip whose group is unmapped is tinted so you know before pressing it that the point is to watch something *not* move.

---

## The repair

When your joint names are recognisable but non-canonical (a Mixamo rig, an Unreal mannequin, a VRoid export), Rig Doctor offers **Download the repaired GLB**.

The repair runs [`canonicalizeGLBBones`](https://github.com/nirholas/three.ws/blob/main/src/glb-canonicalize.js) in your browser, the same function the upload path uses server-side. It:

- rewrites the names of nodes referenced from `skins[].joints[]` to their canonical form
- folds a non-identity armature orientation when one is present, reverting the fold if it would have moved the mesh
- copies the binary chunk through byte for byte

It does **not** touch geometry, materials, textures, morph targets, or animations. The output is a valid glTF 2.0 binary with the same visual result and a skeleton the clip library can address.

The button only appears when a repair would change something. A rig that is already canonical gets no button, because handing back a byte-identical file would be a lie about having helped.

> The live preview shows the **original** file, not the repaired one. Retargeting canonicalizes names in memory anyway, so a Mixamo rig performs correctly in the preview without downloading anything. Downloading matters for tools that are not three.ws: Blender, Unity, your own three.js scene.

---

## Generated output

The **Ship it** panel writes three artefacts from the file you dropped.

**Manifest** is a [schema v1](https://github.com/nirholas/three.ws/blob/main/packages/avatar-schema/schema/avatar.v1.json) avatar manifest with everything the file could tell us already filled in: triangle count, joint counts, morph-target count, lip-sync capability, and the correct `skeleton` enum value for your detected convention. You supply `id`, `name`, `owner`, and the public `mesh.uri`, none of which a local file can know.

**Embed** is the `<agent-3d>` loader and element, ready to paste into any page.

**CLI** is the [`@three-ws/avatar-cli`](./avatar-cli.md) invocation that produces the same manifest with a real `sha256` over the mesh bytes, plus the validate call. Run it when you are ready to anchor the manifest for real:

```bash
npx @three-ws/avatar-cli init \
  --name "Michelle" \
  --mesh ./michelle.glb \
  --mesh-uri https://your-host.example/michelle.glb \
  --owner YOUR_SOLANA_ADDRESS \
  --out michelle.avatar.json

npx @three-ws/avatar-cli validate michelle.avatar.json
```

---

## Recognised rig conventions

The convention detector reports which authoring tool your skeleton came from and what evidence it used. Detection is ordered most-specific first, so Ready Player Me is distinguished from plain Mixamo (they share bone names and differ only in their `Wolf3D_*` mesh nodes).

| Convention | Detected by | Manifest `skeleton` |
|---|---|---|
| Ready Player Me | `Wolf3D_*` mesh nodes over a Mixamo skeleton | `rpm` |
| Mixamo | `mixamorig:` joint prefix | `mixamo` |
| VRM / VRoid | `J_Bip_*` humanoid joint names | `vrm-humanoid` |
| Reallusion Character Creator | `CC_Base_*` joint prefix | `custom` |
| Unreal Engine mannequin | `pelvis`, `thigh_l`, `clavicle_l` | `custom` |
| 3ds Max Biped | `Bip01` / `Bip001` prefix | `custom` |
| Blender Rigify | `DEF-` / `ORG-` / `MCH-` bone layers | `custom` |
| Autodesk HumanIK / MotionBuilder | character-namespaced joints (`Character1:Hips`) | `custom` |
| Daz Genesis | `lShldr`, `abdomen`, `lThigh` | `custom` |
| MakeHuman / Blender side-suffix | `.L` / `.R` suffixes | `custom` |
| Avaturn / three.ws canonical | joint names already match exactly | `avaturn` |

An unrecognised rig is not automatically a failing rig. The canonicalizer strips vendor prefixes and normalises separators before it looks anything up, so a rig with no fingerprint can still map every joint. Detection tells you *where the file came from*; coverage tells you *whether it works*.

### When your rig is not recognised

The **Unrecognised joints** panel lists every joint name the canonicalizer could not resolve. If those names belong to a standard rig, they are precisely what belongs in [`src/glb-canonicalize.js`](https://github.com/nirholas/three.ws/blob/main/src/glb-canonicalize.js). Open an issue with the list and every future upload of that rig animates for everyone, not just for you.

---

## The canonical skeleton

52 joints. Torso and head:

```
Hips  Spine  Spine1  Spine2  Neck  Head
```

Each arm (mirrored `Left` / `Right`):

```
LeftShoulder  LeftArm  LeftForeArm  LeftHand
```

Each hand, three joints per finger (mirrored):

```
LeftHandThumb1..3   LeftHandIndex1..3   LeftHandMiddle1..3
LeftHandRing1..3    LeftHandPinky1..3
```

Each leg (mirrored):

```
LeftUpLeg  LeftLeg  LeftFoot  LeftToeBase
```

This is the Avaturn reference rig, the same skeleton every clip in `/public/animations/clips/` is authored against. Rename your joints to match and no retargeting is needed at all.

---

## Programmatic use

The analysis is a pure function of the GLB bytes, exported from `src/rig-report.js`. It has no DOM, WebGL, or network dependency, so it runs in Node as well as in the browser:

```js
import { readFileSync } from 'node:fs';
import { analyzeGlb } from './src/rig-report.js';

const buf = readFileSync('./michelle.glb');
const report = analyzeGlb(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), {
  fileName: 'michelle.glb',
});

console.log(report.verdict.level);        // 'pass' | 'warn' | 'fail'
console.log(report.verdict.headline);     // one sentence you can print
console.log(report.skeleton.convention);  // { id: 'mixamo', label: 'Mixamo', … }
console.log(report.skeleton.mapped);      // 52
console.log(report.skeleton.unmapped);    // joint names with no canonical form

for (const g of report.skeleton.groups) {
  if (!g.driven) console.log(`${g.label} frozen, missing ${g.missingKey.join(', ')}`);
}
```

That makes it usable as a CI gate. Exit non-zero when a rig regresses and a broken avatar never reaches production:

```js
if (report.verdict.level === 'fail') {
  console.error(report.verdict.headline);
  process.exit(1);
}
```

### Exported API

| Export | Returns |
|---|---|
| `analyzeGlb(buffer, { fileName })` | the full report. Throws only when the bytes are not a readable glTF 2.0 binary. |
| `readGlbJson(buffer)` | `{ json, jsonBytes, binBytes }` for inspecting the raw glTF document. |
| `manifestFromReport(report, identity)` | a schema-v1 avatar manifest. `identity` supplies `id`, `name`, `meshUri`, `owner`, `createdAt`, and optionally `sha256`. |
| `formatBytes(n)` | a human-readable size string. |
| `MIN_CANONICAL_BONES` | `8`, the drivability floor. |
| `CANONICAL_TOTAL` | `52`, the size of the canonical set. |
| `LIMB_GROUPS` | the group definitions, including each group's key joints. |

---

## Sharing a result

Every sample rig is linkable, which is how the failure states in this document can be checked against a live page rather than taken on faith:

- [A Mixamo rig that fully animates](https://three.ws/rig-doctor?sample=/avatars/michelle.glb)
- [A halfbody avatar with frozen legs](https://three.ws/rig-doctor?sample=/avatars/realistic-halfbody.glb)
- [A skinned but non-humanoid rig](https://three.ws/rig-doctor?sample=/avatars/fox.glb)
- [A static mesh with no skeleton](https://three.ws/rig-doctor?sample=/avatars/mannequin.glb)

Your own file cannot be shared this way, because it never leaves your machine.
