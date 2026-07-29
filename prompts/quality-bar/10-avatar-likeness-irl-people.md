# 10: Avatar likeness, IRL people quality

Read `prompts/quality-bar/_shared.md` first. Its operating clause applies: finish 100%, never ask.

## Mission

Photo→avatar and text→avatar outputs should look like real people: correct proportions,
believable skin, hands with five fingers, clothes with fabric behavior, and a rig that
animates without breaking the illusion. This prompt owns the human-specific end of the
realism campaign.

## Current state (verify)

- `avatar-reconstruction` service is LIVE on Cloud Run. `unirig` (skeleton/skinning/ARKit-52)
  is LIVE. `text_to_avatar` and `forge_avatar` chain mesh+rig with a humanoid gate; degrade
  paths shipped 07-16 (3e22c3e82). Portrait realism cues went into the hunyuan worker today
  (f131e51b0). Animation retarget is universal (`src/glb-canonicalize.js`,
  `src/animation-retarget.js`); never add a rig allowlist.

## Tasks

1. **Audit the avatar path end to end** with 6 real test cases: text prompts (athlete,
   grandmother, child-safe stylized kid, businessperson) and 2 reference photos (CC0 portrait
   sets). Score against the IRL bar: proportions, face fidelity, hands, feet, clothing,
   texture seams at the neck/hairline. Document per-case failures precisely.
2. **Route avatars through the strongest lane.** Once Hunyuan3D is live (prompt 02), the
   avatar mesh stage should prefer it with the portrait realism cues; verify the humanoid gate
   still passes its output to unirig cleanly, T/A-pose normalized (bind pose sanity: the
   glb-canonicalize suite covers naming, `tests/glb-canonicalize.test.js`).
3. **Face fidelity pass for photo input.** For photo→avatar, the reference pipeline must
   preserve identity: feed the actual user photo (multi-view if the user gave several) to the
   image→3D lane rather than a re-generated lookalike, and keep the face region's texture
   resolution highest (UV area weighting if the pipeline exposes it). Never generate an avatar
   of a named third party from text alone; photo input implies consent by upload, text-only
   real-person names get the generic treatment (existing director behavior; keep it).
4. **Skin/eye/hair materials** land here for avatars specifically (coordinate with prompt 04
   task 4; if that prompt already shipped the material module, wire it, do not duplicate).
5. **Animation dignity check.** Idle/walk retargeted onto 10 differently-sourced rigs
   (Mixamo-, VRM-, Avaturn-style naming per glb-canonicalize coverage) with no candy-wrapper
   twists, foot sliding, or T-pose flashes at 320px mobile and desktop. Fix retarget bugs at
   the mapping layer, add test cases for any new bone convention encountered.
6. **The /irl moment.** Place 3 finished avatars in AR (the USDZ animated-bake path from
   8b23b8d9e) and screenshot; the pin should read as a person standing there, not a figurine.
   ACES lighting for pins is live (07-15); verify avatars specifically benefit.
7. **Prove and publish.** Before/after gallery of all 6 test cases through the whole chain
   (mesh, materials, rig, animation, AR). Changelog entry in holder language. Update
   `.agents/skills` create-3d-avatar guidance if defaults changed.

## Definition of done

- 6/6 test cases visibly improved with the gallery in the report; hands specifically called out
  (count fingers in the screenshots).
- Retarget suite green plus any new bone-convention cases added.
- AR screenshots included; no regression in the humanoid-gate degrade paths (kill-test one
  rig failure and confirm the mesh still ships with a working fallback).

## Verification status (2026-07-29)

Evidence lives in `prompts/quality-bar/_generated/10/`. Only what is listed as PROVEN below
has measured evidence behind it; everything else is still open.

### Task 5, animation dignity: PROVEN

- Tool: `scripts/animation-dignity-sweep.mjs` (run it with `--verbose` for per-limb numbers,
  `--json` for machine-readable output). It builds ten minimal skinned GLBs, one per bone-naming
  convention, drives the real `idle` and `walk` clips onto each, and MEASURES the outcome rather
  than checking that nothing threw: retarget coverage, per-limb rotation swing in degrees, and
  end-effector world travel in hip-heights for both hands and both feet, composed off real
  three.js world matrices. Every rig runs down both production paths (ingest-canonicalized and
  raw-runtime).
- Result: **10/10 conventions animate both arms and both legs on both lanes.** Committed evidence:
  `_generated/10/animation-dignity-sweep.txt` (verbose report) and `.json` (full per-limb data).
  Conventions covered: Mixamo, Avaturn/RPM, Unreal mannequin, VRM 0.x/VRoid, VRM 1.0,
  Daz/Genesis 8, MakeHuman, Blender Rigify, a simple `shoulderL` hobby rig, and a novel
  anatomical-Latin scan rig the canonicalizer had never seen.
- **Five of the ten were broken before this run, and nothing in the suite noticed.** 30 of the 53
  tracks in every clip address a finger joint, so a rig whose hands do not name-map scores about
  40% coverage, falls under `MIN_COVERAGE` in `src/animation-retarget.js`, and gets NO action
  built at all: the avatar stands frozen in its bind pose, arms and legs included. Measured
  before/after coverage: Unreal 39.6% to 96%, VRM 1.0 43.4% to 100%, Daz 43.4% to 100%,
  MakeHuman 41.5% to 98%, Rigify 41.5% to 98%. The novel anatomical rig went from 7.5% (3 of 52
  joints mapped, nothing moved at all) to 100%.
- Fixes landed at the mapping layer only, in `src/glb-canonicalize.js`: Unreal finger chain
  (`index_01_l`), VRM 1.0 phalanx naming (`leftIndexProximal`, `leftThumbMetacarpal`), Daz
  numbered fingers (`lIndex1`, `lMid1`), Rigify fingers (`f_index.01.L`, `thumb.01.L`),
  MakeHuman digit numbering (`finger2-1.L`), and the whole anatomical-Latin skeleton
  (`lumbar`, `thoracic`, `cervical`, `cranium`, `humerus.L`, `ulna.L`, `femur.L`, `tibia.L`,
  `talus.L`, `metatarsus.L`, `index_proximal.L`). No rig allowlist was added.
- Regression cover: `tests/glb-canonicalize.test.js` gained per-convention finger cases plus an
  anatomical-skeleton block; `tests/animation-retarget.test.js` gained a coverage-floor suite that
  asserts six conventions clear the PRODUCTION `MIN_COVERAGE` default against the real clips and
  map all 30 finger joints.
- One open defect, reported not papered over: on the runtime-only lane a Rigify rig binds the
  `LeftArm`/`RightArm` clip track to `shoulder.L`/`shoulder.R` (the clavicle) because
  `shoulder.L` and `upper_arm.L` normalize onto the same canonical name and no name-only table can
  separate them (the simple hobby rig spells its upper arm `shoulderL` too). The arm still
  animates, but it swings from the shoulder blade. The ingest canonicalizer resolves this
  structurally (`canonicalizeJointNodes` pass 1.5), and every avatar three.ws stores is
  canonicalized at ingest, so production is correct; only a third-party GLB loaded straight into
  the viewer is affected. Remedy: port pass 1.5/1.6 into `canonicalNodeMapFromObject` in
  `src/animation-retarget.js`. The sweep prints this as a warning with the remedy attached.

## Anticipated blockers, pre-answered

- Hunyuan3D not Ready yet: run the full audit and material/rig/AR work on the TRELLIS lane
  now; the lane swap is one env var and a re-run, note it as the follow-up command.
- Hands are the hardest failure: if mesh-level hands stay bad at max budgets, the honest
  mitigations are pose choice (relaxed hands), higher reference-image hand visibility, and
  the director explicitly requesting "hands visible, fingers separated" in reference views.
  Document what moved the needle with screenshots.
- Child-safety: stylized kid case must stay clearly stylized; if any output drifts
  photoreal-child, drop the case from public galleries and note it; never ship photoreal
  minors' likenesses.
