# RM-PARAM: Parametric avatar editor, phase 2 onward

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/roadmap-avatar-parametric-editor.md`".
It is complete on its own. Also read `prompts/finish/roadmap-00-README.md` and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end with a question, a plan you did not execute, or "should I proceed?".
2. Additive only. `src/glb-canonicalize.js`, `src/animation-retarget.js` and the export bake are
   shared cores: preserve 100% backward compatibility and prove it with tests.
3. CLAUDE.md hard rules: no mocks, no TODO comments, no em-dash or en-dash characters. Stage
   explicit paths only.

## The architectural decision everything hangs on

**One canonical parametric body. Everything else is a parameter over it.** Shape is morph
targets, proportions are skeleton parameters, hair and clothes are conforming attachments that
inherit skinning and morphs, skin is layered textures over fixed UVs, and identity capture
(selfie, text) is a solver that outputs a parameter vector rather than a mesh. Fixed topology
is what makes "change everything" tractable.

## Step 0: re-derive current state (trust nothing below)

```bash
ls public/avatars/parametric-base.glb avatar-sources/anny scripts/build-parametric-base.mjs
npx vitest run tests/parametric-base.test.js
node -e "1" && grep -c "" avatar-sources/anny/*/*.target 2>/dev/null | tail -3
npm run dev   # open /create/studio?base=parametric and count the sliders that render
```

**Phase 1 is shipped (2026-07-22):** `avatar-sources/anny/` (vendored CC0 MakeHuman/MPFB2 data
with provenance), `scripts/build-parametric-base.mjs` (the baker),
`public/avatars/parametric-base.glb` (52-bone `mixamorig:*` skeleton, 4 submeshes, 122 sparse
morph sliders), the Base switcher in Avatar Studio (`?base=parametric`), the Ears and Head Shape
sculpt groups, and `tests/parametric-base.test.js`. 472 target files are vendored and roughly
350 remain uncurated, so growing 122 sliders toward 400+ is a MORPHS-table edit plus a rebake,
not new engineering.

`src/avatar-sculpt.js` renders sliders for whatever morphs the loaded GLB carries, so every
morph you bake lights up in the UI with zero UI work.

## Task 1: grow the slider set (cheapest large win)

Curate the remaining vendored targets into the MORPHS table (asymmetric variants, per-segment
scale axes, navel, valgus, hands, feet), rebake, and confirm the studio renders them grouped
sensibly. Keep the GLB sane: sparse accessors only, and measure the file size before and after.
Extend `tests/parametric-base.test.js` with the new group assertions.

## Task 2: skeleton-space proportions (phase 2)

**Shipped client-side (2026-08-02).** `src/avatar-proportions.js` holds the 10-parameter table
(height, leg/torso/neck/arm length, shoulder/hip width, head/hand/foot size) and the maths;
`src/avatar-sculpt.js` renders the Proportions group above the morph sliders on both the studio
and the customizer; `AnimationManager.remeasureRigProportions()` re-measures hip height and
rebuilds every bound action so the walk does not foot-slide; the record serializes as
`appearance.proportions`, specified in `specs/AVATAR_PARAMETERS.md` and covered by
`tests/avatar-proportions.test.js`.

Design notes worth keeping: offsets scale a joint's rest offset from its parent and `scale`
params scale the joint, but rotations are NEVER written, which is what keeps the retargeter's
captured rest frames (and bind-space morph deltas) valid. Ground contact is measured on the rig
rather than derived from the ratios, with the left and right deltas averaged so a width edit
cancels out and only a length edit lifts the hips. The re-measure deliberately does not call
`attach()`, because attach re-captures rest frames and a mid-animation rig is not at rest.

**Remaining:** the server-side bake. Avatar Studio saves via a client-side `GLTFExporter` of the
live scene, so proportions bake in there for free, but `/avatars/:id/edit` PATCHes the appearance
record and lets `api/_lib/bake.js` render the GLB. Until that path applies `proportions`, a build
edited in the customizer persists and re-applies in the editor but does not reach the baked GLB
that viewers download. The shared module is written to be consumed from Node (no three.js, no DOM
imports): a sibling `api/_lib/bake-proportions.js` that resolves canonical bones with
`canonicalizeBoneName`, feeds `computeProportionTransforms`, and writes `translation`/`scale`
back, lazy-imported from `bake.js` the way `bake-garments.js` already is.

## Task 3: free sculpt (phase 4, the "change literally anything" guarantee)

A radius and falloff brush edits vertex positions directly on the mesh, recorded as a per-avatar
custom delta morph so it exports, serializes and composes with the library morphs. Symmetry
toggle on and off (asymmetry is a feature the competition lacks). Verify the delta survives a
round trip through the export bake.

## Task 4: the parameter model, as a real spec

One serializable document per avatar is what saves, shares, forks and mints. It is a
load-bearing wire format (editor, baker, shop and embeds all consume it), so it belongs in
`specs/`, not in a comment:

```json
{
  "base": "parametric-v1",
  "morphs": { "noseWidth": 0.3, "earPoint": 0.8 },
  "skeleton": { "height": 1.78, "armLength": 1.02 },
  "sculpt": "r2://sculpt-deltas/<id>.bin",
  "slots": { "hair": "asset:curly-04", "top": "asset:forge-8fa2" },
  "layers": [ { "type": "tattoo", "decal": "...", "uv": [0.4, 0.6] } ],
  "animation": { "idle": "breathing-02", "walk": "confident", "mood": "warm" }
}
```

Write `specs/PARAMETRIC_AVATAR.md` with the field-by-field contract, versioning rule, and what
each consumer is allowed to ignore. Then make the editor read and write exactly that shape.

## Definition of done

- [ ] Slider count grown, grouped and rendering; GLB size recorded before and after.
- [ ] Proportion parameters apply at load, bake at export, and do not break retargeting
      (`npm run gate` and the retarget suite green, walk verified with no foot sliding).
- [ ] Free sculpt edits export, reload and compose with library morphs, proven by round trip.
- [ ] `specs/PARAMETRIC_AVATAR.md` written; the editor reads and writes that document.
- [ ] Verified in a real browser at 320, 768 and 1440 px with no console errors.
- [ ] `npm test` green; `data/changelog.json` entry; `STRUCTURE.md` row updated if a surface
      changed.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| Hundreds of morphs look expensive at runtime | three.js handles them through texture-based morph targets and only nonzero influences cost anything. Measure before optimizing. |
| A target file does not map cleanly onto the topology | Skip it, list it in the report, and keep the curated set clean. A wrong slider is worse than a missing one. |
| The FLAME selfie lane is tempting | It is licence-blocked (owner signature with MPI) and is phase 5. Nothing in this work order waits on it. |
| A change would alter shared retarget behavior | Flag-gate it, default to current behavior, and prove backward compatibility with tests before flipping. |
| Garment fitting comes up | That is phase 3 and the `workers/garment-forge` lane. Out of scope here; note the seam. |

## Appendix: the later phases (context, not this session's scope)

- **Phase 3, conforming assets and the AI catalog flywheel (the moat):** auto-fit binds garment
  vertices to the nearest body surface and transfers skin weights and morph deltas, so a garment
  follows every slider. Slot taxonomy with per-slot body-hide masks prevents clipping. The forge
  text-to-3D lane generates garments and hair against the canonical body, auto-fits them, and
  lands them in the cosmetics shop. The competition has a fixed paid catalog; we get an infinite
  prompted one.
- **Phase 5, identity lanes resolve into parameters:** selfie via dense fit projected into the
  morph library (least-squares over slider space, residual as a custom morph), text via an LLM
  mapping a prompt to a parameter vector over the named slider set.
- **Phase 6, skin and texture layers:** base tone, complexion, makeup, tattoos and decals,
  scars, age maps, eye colour, composited to one atlas at export.
- **Phase 7, animation personality:** per-avatar default idle and walk, gesture intensity,
  mood-blend defaults, saved emote loadouts. Retarget cost is zero because everything sits on
  one canonical skeleton.
