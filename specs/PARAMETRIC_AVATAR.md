# Parametric Avatar v1

**Status:** live. Base body, morph library, skeleton proportions and free sculpt all ship. Conforming assets (phase 3), identity capture into parameters (phase 5), texture layers (phase 6) and animation identity (phase 7) are reserved and named at the bottom.

This spec describes the **base body and the editing pipeline over it**: what `parametric-base-v1` is, what a consumer is allowed to assume about it, and which of its capabilities every downstream surface must honour. The serialized record that describes one avatar built on it is [`AVATAR_PARAMETERS.md`](./AVATAR_PARAMETERS.md); the two are read together.

## The architectural decision

**One canonical parametric body. Everything else is a parameter over it.**

Shape is morph targets. Build is skeleton parameters. Anything neither can express is free-sculpt vertex deltas. Garments and hair are conforming attachments that inherit the same skinning. Identity capture (a selfie, a text prompt) is a solver whose *output* is a parameter vector, not a mesh.

Fixed topology is what makes all of that tractable. Because every avatar on this base has the same vertex ordering, the same UVs and the same 52-bone skeleton, a delta recorded on one body is meaningful on another, a garment fitted once fits every variant, and the whole pre-baked animation library retargets by construction.

## `parametric-base-v1`

| Property | Value | Source of truth |
|---|---|---|
| Asset | `public/avatars/parametric-base.glb` | `scripts/build-parametric-base.mjs` |
| Source data | CC0 MakeHuman / MPFB2 | `avatar-sources/anny/README.md` |
| Skeleton | 52 joints, `mixamorig:*`, Y-up metres, feet on the floor, facing +Z | `avatar-sources/anny/rigs/rig.mixamo.json` |
| Submeshes | `Body`, `Eyes`, `Teeth`, `Tongue`, one primitive each | `SUBMESHES` in the baker |
| Body topology | 14517 vertices, 26756 triangles | the GLB |
| Morph sliders | 306, all sparse glTF morph targets | `MORPHS` in the baker |
| Hips rest height | 0.912 m | the GLB |

The bone names canonicalize through `src/glb-canonicalize.js`, which is what makes every clip in `public/animations/clips/` play on this rig with no per-rig authoring. `tests/parametric-base.test.js` asserts that, plus geometry validity, morph localization and the budget below.

### Selecting it

Avatar Studio at `/create/studio?base=parametric`. Any surface that loads the GLB directly gets the same body; there is nothing else to opt into.

### Morph inventory

The sculpt panel renders one slider per morph target the loaded GLB exposes, so **the base defines the editor**. Adding a slider is an entry in the baker's `MORPHS` table plus a rebake; no UI change. Current grouping (`CATEGORIES` in `src/avatar-sculpt.js`):

| Group | Sliders | Group | Sliders |
|---|---|---|---|
| Eyes | 42 | Neck | 10 |
| Nose | 36 | Torso | 22 |
| Mouth | 35 | Hips & Midsection | 17 |
| Ears | 32 | Arms | 15 |
| Head Shape | 27 | Legs | 22 |
| Cheeks | 16 | Body | 12 |
| Jaw | 14 | Brows | 6 |

Naming rules, because the group a slider lands in is derived from its name and nothing else:

- Face regions keep **per-side** sliders (`earTriangleLeft` / `earTriangleRight`). Facial asymmetry is an identity feature, and the panel's mirror lock already collapses a pair to one control for users who do not want it.
- Limbs use **one symmetric slider** driving both sides (`armsUpperWider`). A one-armed width edit reads as a defect, not a look.
- A `decr` / `incr` source pair becomes two `0..1` sliders, because the panel has no negative range.
- Every name MUST match one category regex. `tests/parametric-base.test.js` fails the build's test stage if a slider would fall into the "Other" drawer.

### The VRAM budget (the real ceiling on slider count)

three.js uploads morph targets as an RGBA32F `DataArrayTexture` with **one dense layer per target**, allocated whether a slider sits at zero or not (`node_modules/three/src/renderers/webgl/WebGLMorphtargets.js`). The cost is therefore `targets x vertices x 16 bytes`, and it is paid by every viewer of every avatar built on this base, not only by the editor.

Sparse glTF accessors keep the *download* small (306 sliders cost 6.5 MB on disk, up from 4.1 MB at 122) and do nothing at all for VRAM. At 306 targets the base needs **68.0 MB**. The baker enforces a **96 MB** ceiling (`MORPH_VRAM_BUDGET_MB`) and a 12 MB file ceiling, and fails the bake rather than shipping past them. `tests/parametric-base.test.js` asserts the same number independently.

Growing well past 306 sliders therefore needs the identity-morph fold described under **Reserved** below, not a bigger budget.

## Editing pipeline

Three parameter classes, in the order they are applied. Each is independent: changing one never invalidates another.

### 1. Morphs (shape)

`appearance.morphs`, `{ name: weight }`. Applied to `morphTargetInfluences` in the browser and to node weights in the bake. Full contract in [`AVATAR_PARAMETERS.md`](./AVATAR_PARAMETERS.md#morphs-shape).

### 2. Proportions (build)

`appearance.proportions`, `{ id: ratio }` around 1.0. A morph cannot lengthen a limb (its deltas are fixed in bind space, so the skin tears off the bone that drives it), so length, width and stature rewrite the rest `position` / `scale` of canonical bones instead.

The maths lives once, in `src/avatar-proportions.js`, and is dependency-free precisely so all three consumers run the identical solver:

| Consumer | Adapter |
|---|---|
| Browser live preview | `applyProportionsToRoot` in `src/avatar-proportions.js` |
| Server bake | `applyProportions` in `api/_lib/bake-proportions.js` |
| Tests | `computeProportionTransforms` directly |

`tests/bake-proportions.test.js` asserts the browser and server adapters produce bit-comparable bone locals on the real base. Invariants (rotations never written, feet stay grounded, root motion re-measured) are specified in [`AVATAR_PARAMETERS.md`](./AVATAR_PARAMETERS.md#proportions-build).

**The server pass is what lands a build, on every path, including the one that looks like it does not need it.** Avatar Studio saves by exporting the live scene, which reads like proportions come along for free. They do not: `exportSceneGlb` calls `poseSkeletonsToBind` first so a clip caught mid-frame cannot be frozen into the file, and that resets every bone from the skin's inverse bind matrices, which a proportion edit deliberately never touches. The build is therefore absent from the exported GLB and is restored by the bake that follows the appearance PATCH. Same on `/avatars/:id/edit`, which never exports at all. If the export neutraliser changes, `tests/bake-proportions.test.js` is the test that says so.

### 3. Free sculpt (everything else)

`appearance.sculpt`. A radius-and-falloff brush that pushes vertices along their own surface normal, recorded as **one extra morph target per mesh**, named `customSculpt`, pinned at weight 1.

Recording it as a morph target rather than editing `POSITION` is the load-bearing choice: the edit stays additive with every library slider, survives `GLTFExporter` with no special case, can be re-applied to the pristine base from the serialized document, and is reversible by clearing one target.

**Space.** Morph deltas live in bind space; the user is pointing at a skinned, morphed, proportion-edited body on screen. Every stroke builds the exact per-vertex bind-to-world map (`bindMatrixInverse x blended bone matrices x bindMatrix`, then the mesh world matrix), displaces in world space, and maps the result back through that map's inverse. The map is sampled once per drag, at pointer-down, so the host freezes clip playback and the procedural idle while the brush is on (`TalkScene.setRigPaused`, `IdleAnimation.getChannels`).

**Symmetry** mirrors the *brush*, not the vertices: the stroke is applied a second time at the point reflected across the avatar's own X = 0 plane, with the direction reflected too. Turning it off is what makes asymmetry reachable.

**Wire format** (`src/avatar-sculpt-doc.js`, dependency-free so browser, server and tests share it):

```json
{
  "version": 1,
  "meshes": {
    "Body": {
      "count": 812,
      "vertexCount": 14517,
      "scale": 3.1e-6,
      "indices": "<base64 Uint32Array[count], little-endian>",
      "deltas":  "<base64 Int16Array[count * 3], little-endian>"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `version` | Document version. A reader MUST reject a version it does not know rather than guess. |
| `meshes` | Keyed by the three.js mesh name, which equals the glTF mesh name on this base. |
| `count` | Recorded vertices for this mesh. Capped at `SCULPT_MAX_VERTS` (20000). |
| `vertexCount` | The mesh's vertex count when the sculpt was recorded. A mismatch means a different topology and the entry MUST be skipped, never force-fitted. |
| `scale` | Metres per quantisation step. `delta_metres = int16 * scale`. |
| `indices` | Vertex indices into the mesh's `POSITION`, ascending. |
| `deltas` | `[dx, dy, dz]` per index, in bind space, clamped to `SCULPT_MAX_DISPLACEMENT` (0.12 m). |

Quantisation is int16 over the recorded peak, which resolves a 0.12 m range to under 4 micrometres: four orders of magnitude finer than anything a viewer can see, and it turns a megabyte of floats into tens of KB of JSON-safe text.

| Consumer | Adapter |
|---|---|
| Browser brush + replay | `src/avatar-sculpt-brush.js` |
| Server bake | `api/_lib/bake-sculpt.js` |
| Record validation | `sanitizeSculptDoc` in `src/avatar-sculpt-doc.js` |

## Versioning

`base` in the appearance record names the body a document was authored against. Absent means `parametric-v1` for a document that carries `sculpt` or parametric morph names, and "whatever GLB this avatar points at" otherwise, which is the pre-parametric behaviour and stays supported.

- **Morph names are permanent.** Once a slider ships, its name is a public identifier: it is a key in stored records. Renaming one silently drops a user's edit. Add a new slider instead, and leave the old one baked.
- **Adding sliders is a minor change.** Consumers ignore names they do not have, so an older viewer loading a newer base is a body with fewer controls, never an error.
- **Changing topology is a major change** and mints a new base id. Vertex ordering is the contract free sculpt, garment fitting and skin-weight transfer all depend on; a body that renumbers its vertices is a different body. Existing avatars keep their old base.
- **The document versions are independent.** `sculpt.version` describes the delta encoding, not the body.

## What each consumer may ignore

Every consumer MUST **skip what it cannot apply and still render**, never fail the whole avatar. Beyond that:

| Consumer | MUST honour | MAY ignore |
|---|---|---|
| Avatar Studio / avatar editor | everything it offers a control for | nothing; an unrenderable field still round-trips untouched on save |
| Server bake (`api/_lib/bake.js`) | `morphs`, `proportions`, `sculpt`, `colors`, `hidden`, `outfit`, `accessories`, `garments` | `attachments` (never fetched server-side, applied at runtime) |
| Embeds / `<agent-3d>` | the baked GLB as served | the whole record; it consumes geometry, not parameters |
| External engines (Blender, Unreal, model-viewer) | the baked GLB | the record entirely |
| Identity solvers (phase 5) | the named slider set as their output space | any slider the base does not expose |

The rule behind the table: **the record is authoritative for editors, the baked GLB is authoritative for viewers.** A viewer must never need the parameter document to render correctly, and an editor must never need the baked GLB to reconstruct the parameters.

## Reserved

| Item | For |
|---|---|
| Identity-morph fold | Folding applied identity morphs into `POSITION` at bake time, with recomputed normals, so a served avatar carries only the ARKit expression targets. That is what lifts the 96 MB budget and unblocks 400+ sliders. It needs correct normal recomputation on a skinned mesh, which is why it is not in v1. |
| `slots` | Conforming hair and garments auto-fitted to the canonical body (phase 3, `workers/garment-forge`) |
| `layers` | Texture layers over the canonical UVs: complexion, makeup, tattoos, decals, age maps (phase 6) |
| `animation` | Per-avatar animation identity: default idle and walk, gesture intensity, mood blend, emote loadout (phase 7) |

## Related

- [`AVATAR_PARAMETERS.md`](./AVATAR_PARAMETERS.md): the serialized appearance record.
- [`GARMENT_MANIFEST.md`](./GARMENT_MANIFEST.md): the wearables that conform to this body.
- [`EDITOR_SPEC.md`](./EDITOR_SPEC.md): the authoring surface.
- [`../docs/avatar-studio.md`](../docs/avatar-studio.md): the user-facing guide.
- [`../avatar-sources/anny/README.md`](../avatar-sources/anny/README.md): source data and licence.
