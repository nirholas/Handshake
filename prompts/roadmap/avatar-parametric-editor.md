# Parametric Avatar Editor: the Avaturn-and-beyond plan

Goal: an avatar editor where **every parameter of the character is editable**, minor and major: face regions (nose, ears, mouth, eyes, jaw, brow, cheeks), body shape (weight, muscle, proportions), individual limbs, hair, clothing, skin, and animation. Avaturn exposes a fixed template with a curated slider set and a paid catalog. We go past it on three axes: parameter depth (hundreds of sliders plus free sculpt), an AI-generated infinite asset catalog, and identity lanes (selfie and text prompt) that resolve into the same parameter space instead of a black-box mesh.

## The one architectural decision everything hangs on

**One canonical parametric body. Everything else is a parameter over it.**

Avaturn, MetaHuman, MakeHuman, and Daz all converge on this: a single fixed-topology base mesh where

- shape = morph targets (vertex deltas),
- proportions = skeleton parameters (per-bone scale/offset),
- hair/clothes = conforming attachments that inherit the body's skinning and morphs,
- skin = layered textures over a fixed UV layout,
- identity capture (selfie, text) = a solver that outputs a parameter vector, not a mesh.

Fixed topology is what makes "change everything" tractable: every asset, morph, texture layer, and identity solver targets the same vertex ordering and UV space, so they all compose. Our current composer mixes baked parts across 4 RPM bodies; that gives variety but can never give sliders, because the bases have no morph library. The parametric backbone is the missing piece the composer README and `docs/avatar-reconstruction.md` v3 both already name.

## What we already have (do not rebuild)

| Layer | Exists today | Where |
|---|---|---|
| Slider UI | Morph slider panel, grouped, renders ANY morphs a GLB exposes; MetaHuman-style 2D face blend wheel | `src/avatar-sculpt.js` |
| Studio shell | Create/edit modes, live scene, export | `src/avatar-studio.js`, `/avatar-studio` |
| Part composition | Cross-base skinned-part grafting on a shared 67-joint skeleton, recolor, scale | `api/_lib/avatar-composer/` |
| Wardrobe UI | Layered garment recolor + hide/show | `src/avatar-wardrobe.js`, `src/avatar-edit.js` |
| Accessories | Bone-attached GLB merge bake | `api/_lib/bake.js`, `public/accessories/` |
| Animation | 111 baked clips, universal retarget, additive overlays, ARKit-52 runtime, lipsync, face mocap | `src/animation-manager.js`, `src/animation-retarget.js`, `src/glb-canonicalize.js` |
| Rigging | Auto-rig worker (Mixamo skeleton + skinning + ARKit-52) | `workers/rig/` |
| Selfie face | MediaPipe 468-landmark shape morph onto template, `register_head_to_target` dense-registration primitive validated | `workers/avatar-reconstruction/` |
| Export/bake | Morph bake, accessory merge, weld/quantize/meshopt, GLB/VRM/USDZ | `api/_lib/bake.js`, `src/avatar-export.js` |
| Economy | Cosmetics shop, ownership, x402 settlement | `api/_lib/cosmetics*.js` |

Key leverage: `avatar-sculpt.js` renders sliders for whatever morphs the loaded GLB carries. Ship a base with 300 morphs and the editor lights up with 300 sliders with zero UI work.

## The build, in phases

### Phase 1: the parametric backbone (unlocks everything): SHIPPED v1, 2026-07-22

Shipped by adopting [naver/anny](https://github.com/naver/anny)'s CC0 repackaging of the MakeHuman/MPFB2 data instead of hand-porting targets: `avatar-sources/anny/` (vendored data + provenance), `scripts/build-parametric-base.mjs` (baker), `public/avatars/parametric-base.glb` (52-bone mixamorig skeleton, 4 submeshes, 122 sparse morph sliders), Base switcher in Avatar Studio (`?base=parametric`), Ears/Head Shape sculpt groups, `tests/parametric-base.test.js`. 472 target files are vendored; ~350 remain uncurated (asym, per-segment scale axes, navel, valgus, hands, feet), so growing 122 sliders toward 400+ is a MORPHS-table edit plus rebake, no new engineering. Original plan for reference:

Adopt a commercially-clean parametric base and port a large morph library onto it.

- **Base mesh + rig: Anny** (Apache-2.0 code, CC0 assets). Humanoid, game-ready topology, designed for morph-based customization.
- **Face topology + ARKit: ICT-FaceKit** (MIT). Gives ARKit-52 + identity basis on a clean license; deformation-transfer its expression set onto the Anny head so lipsync/mocap keep working.
- **Body morph library: MakeHuman targets** (CC0 output). Hundreds of body/face targets (per-region nose, ears, jaw, lips, eyes, torso, limbs, age, weight, muscle, gender spectrum). Port via one offline Blender/gltf-transform script that maps targets onto the Anny topology (nearest-surface + RBF, same math as `register_head_to_target`).
- **Statistical prior: GHUM** (Apache-2.0) later, for realistic covariance ("heavier build also thickens wrists") behind a "realism lock" toggle. Not needed for v1.
- Bake the result to `public/avatars/parametric-base.glb` (or one per build preset) with the full morph set. Three.js handles hundreds of morphs via texture-based morph targets; only nonzero influences cost anything at runtime.

Output: the studio loads the parametric base and every slider is real. This single phase beats Avaturn's slider depth.

### Phase 2: skeleton-space proportions (limbs, height, frame)

Morphs cannot lengthen an arm without breaking skinning; bone parameters can.

- Parameter set: height, leg/arm length, shoulder width, neck length, head size, hand/foot scale, hip width. Implemented as per-bone scale + rest-pose offsets on the canonical skeleton, applied at load and baked at export.
- Verify against the retarget stack: clips play through `animation-retarget.js` hip-translation rescale already; extend its hip rescale to honor per-bone leg scale so walks don't foot-slide.
- UI: a "Proportions" group in the sculpt panel (sliders already generic).

### Phase 3: conforming assets + the AI catalog flywheel (the moat)

Hair, clothes, shoes, facial hair as **conforming attachments**: assets authored (or generated) once against the canonical body, auto-fitted forever after.

- **Auto-fit tool** (offline + on-upload): bind garment vertices to nearest body surface, transfer skin weights and all morph deltas (deformation transfer). A garment then follows every slider automatically: widen the hips, the pants widen.
- **Layering**: slot taxonomy (hair, headwear, top, outerwear, bottom, footwear, gloves, facial-hair, accessories xN) with per-slot body-hide masks (vertex groups) so layered clothing never clips.
- **The flywheel**: wire the forge text-to-3D lane to generate garments/hair against the canonical body ("generate a cyberpunk jacket"), pipe results through auto-fit, land them in the catalog and cosmetics shop. Avaturn has a fixed paid catalog; we have an infinite prompted one, priced in $THREE via the existing cosmetics economy.
- Migrate the 4 RPM bases' hair/outfits through auto-fit so the composer's existing variety carries over; this also deletes the rest-pose-group restriction (composer v2 vertex rebinding falls out for free).

### Phase 4: free sculpt (change literally anything)

Brush-drag directly on the mesh: radius/falloff brush edits vertex positions, recorded as a per-avatar **custom delta morph** (so it exports, serializes, and composes with the library morphs). Symmetry toggle on/off (asymmetry is a feature Avaturn lacks). This is the "every single minor thing" guarantee: anything no slider covers, the brush does.

### Phase 5: identity lanes resolve into parameters

- **Selfie**: MICA+FLAME dense fit (owner approved paying MPI for the commercial FLAME license; blocked on that signature) feeding `register_head_to_target`, then project the result INTO the morph library (least-squares fit over slider space + residual as a custom morph). The user gets their face AND every slider still works on it. Avaturn gives you a locked scanned head.
- **Text**: LLM maps a prompt ("older, sharper jaw, elvish ears, lean runner's build") to a parameter vector over the named slider set. Cheap, no GPU, huge demo value; ship early behind the same parameter API.
- **Randomize/seed**: composer-style seeded recipes become parameter-vector presets.

### Phase 6: skin and texture layers

Layered material system over the canonical UVs: base tone, complexion (freckles/redness), makeup, tattoos/decals (project-on-click), scars, age maps, nail/lip/eye color, heterochromia. Live as separate layers in the editor; composited to a single atlas at export by extending `api/_lib/bake.js` (sharp is already in the pipeline). Optional AI restyle pass (existing restyle lane) as a layer, not a replacement.

### Phase 7: animation personality

The clip library and retargeter already outclass Avaturn. Add per-avatar animation identity: default idle/walk pick, gesture intensity, mood-blend defaults (embodiment/emotion.js already blends), and saved emote loadouts. Because everything sits on one canonical skeleton, retarget cost for the parametric base is zero.

## Parameter model (the contract)

One serializable document per avatar; this is what saves, shares, forks, and mints:

```json
{
  "base": "parametric-v1",
  "morphs": { "noseWidth": 0.3, "earPoint": 0.8, "...": 0 },
  "skeleton": { "height": 1.78, "armLength": 1.02, "...": 1 },
  "sculpt": "r2://sculpt-deltas/<id>.bin",
  "slots": { "hair": "asset:curly-04", "top": "asset:forge-8fa2", "...": null },
  "layers": [ { "type": "tattoo", "decal": "...", "uv": [0.4, 0.6] } ],
  "animation": { "idle": "breathing-02", "walk": "confident", "mood": "warm" }
}
```

Spec lands in `specs/` when Phase 1 ships (it is a load-bearing wire format: editor, baker, shop, and embeds all consume it).

## Licensing gates (the only external blockers)

- FLAME commercial license: owner signs with MPI (Phase 5 selfie lane only; nothing else waits on it).
- MakeHuman targets are CC0 with a community caveat on fully-automated pipelines: port via our own one-time conversion script and commit the converted artifacts, which is the accepted clean pattern.
- Everything else chosen (Anny, ICT-FaceKit, GHUM) is Apache/MIT/CC0.

## Build order rationale

Phase 1 alone is a visible leap (the studio goes from ~10 usable morphs to hundreds). Phases 2 and 4 complete "change everything". Phase 3 is the competitive moat and revenue surface. 5 to 7 are compounding differentiators. Each phase ships independently behind the existing studio UI; no phase requires a rewrite of the animation, export, or economy stacks.
