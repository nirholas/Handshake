# 02 - Photoreal humans: faces, skin, hair that read as IRL people

Read `README.md` in this directory first (never-stop contract, standing approvals, shared
context). Never end a turn with a question. GCP spend is pre-approved; no new third-party APIs.

## Mission

Avatars generated on three.ws should look like actual people: skin with pores and asymmetry,
believable hair, eyes with catchlights, not glossy mannequins. The person-realism prompt work
landed 07-16 (`PERSON_REALISM_SUFFIX` in `api/_mcp3d/text-to-image.js`); this prompt finishes
the job across the whole avatar chain: reference image -> reconstruction -> rigging -> the way
skin is shaded in every viewer.

## Current state (verified 2026-07-16; re-verify against the tree)

- `PERSON_SUBJECT_RE` routes human prompts to portrait-photography language (85mm DSLR, pores,
  hair strands). ART_STYLE_WORDS still correctly suppresses realism for stylized asks.
- Avatar chain: `text_to_avatar` / `forge_avatar` MCP tools -> mesh generation -> UniRig
  auto-rig (`GCP_UNIRIG_URL`, service `unirig`, live) with humanoid gate
  (`AnimationManager.supportsCanonicalClips()` fallback, never a T-pose). Universal retarget:
  `src/glb-canonicalize.js` + `src/animation-retarget.js`.
- `avatar-reconstruction` Cloud Run service (photo->avatar) is live with L4.
- Viewers: the IRL view got ACES filmic tone mapping + cinematic lighting 07-15
  (`src/` IRL modules); avatar-result viewers were brought up to that bar in commit 8cd1be411.
- Hunyuan3D-2 (`GCP_HUNYUAN3D_URL`, live) reconstructs humans better than TRELLIS at high tier.

## Tasks

1. **Face fidelity through multi-view.** Bodies survive single-view reconstruction; faces do
   not. Reuse prompt 01's multi-view machinery (check `git log` for its state; if 01 has not
   run yet, build the person-specific slice here and leave a note in 01's file): front portrait
   plus 3/4-left and 3/4-right views via Gemini image edit ("same exact person, head turned 40
   degrees left, identical lighting"), fused in the reconstruction. The face must survive a
   90-degree orbit without smearing.
2. **Skin shading in the viewers.** Reconstructed textures often ship flat albedo. In the
   shared viewer setup (the module 8cd1be411 touched; find it via
   `grep -rn "ACESFilmicToneMapping" src/ | head`), ensure avatar materials get: correct sRGB
   texture encoding, a modest clearcoat=0 / roughness floor (glossy skin reads mannequin),
   and environment lighting from the existing HDRI/room env. If the GLB carries PBR maps, do
   not override them.
3. **Hair.** Reconstruction collapses hair to a helmet. Mitigate at the reference stage: the
   portrait prompt should specify visible individual hair strands and avoid flyaway backlight
   halos (they reconstruct as spikes). Measure on the eval set; if reference-stage language is
   insufficient, document what a dedicated hair pass would need (do not bolt on a new model).
4. **The full-body proportion check.** Full-body prompts must produce anatomically plausible
   proportions for rigging (UniRig fails or produces bad skinning on distorted bodies). Add a
   pre-rig sanity gate if failures show up in `forge_creations` records for avatar jobs.
5. **Eval set (definition of done).** Generate at standard and high, before/after: "a
   middle-aged carpenter with a gray beard", "a young woman with curly red hair, freckles",
   "an elderly man in a linen suit", "a female astronaut, helmet off", "a teenage boy in a
   hoodie". For each: 4-angle render, rigged idle-animation check (the retarget must drive it;
   no T-pose), and the platform quality score. Faces must hold up at 90-degree orbit.
6. **Ship.** Deploy, one live production avatar per tier E2E (generation -> rig -> animated in
   the viewer), commit + changelog ("avatars now look like real people").

## Guardrails

- Never regress stylized asks: "cartoon knight" must stay cartoon (ART_STYLE_WORDS test).
- Rigging gate stays universal: no rig allowlists (CLAUDE.md stack note); a new skeleton
  convention gets a bone-name mapping in `glb-canonicalize.js` + test.
- Bone names with punctuation broke a USDZ bake once (bone-name-sanitize, memory 07-15): run
  the iOS AR bake path on one eval avatar to confirm no regression.

## Acceptance criteria

- [ ] Eval faces survive a 90-degree orbit (before/after renders in the report).
- [ ] Avatar materials render with sRGB + env lighting in the shared viewers (screenshot proof).
- [ ] All 5 eval avatars rig and play the canonical idle (no T-pose, no console errors).
- [ ] One live production avatar per tier E2E; URLs in the report.
- [ ] Committed with changelog + docs; `npm test` green; report shows every measurement.
