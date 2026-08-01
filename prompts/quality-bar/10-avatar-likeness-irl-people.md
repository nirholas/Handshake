# QB-10: Avatar likeness, IRL people quality

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/quality-bar/10-avatar-likeness-irl-people.md`".
It is complete on its own. Also read `prompts/quality-bar/_shared.md` and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan.
2. Blockers have pre-answered routes at the bottom.
3. CLAUDE.md hard rules: no mocks, no TODO comments, no em-dash or en-dash characters. Stage
   explicit paths only. Never add a rig allowlist; fixes go at the mapping layer.

## Mission

Photo-to-avatar and text-to-avatar outputs should look like real people: correct proportions,
believable skin, hands with five fingers, clothes with fabric behavior, and a rig that animates
without breaking the illusion.

## Step 0: re-derive current state (trust nothing below)

```bash
node scripts/animation-dignity-sweep.mjs --verbose   # ten bone-naming conventions, measured
ls prompts/quality-bar/_generated/10/                # committed evidence from the last pass
npx vitest run tests/glb-canonicalize.test.js tests/animation-retarget.test.js
gcloud run services list --region us-central1 --project aerial-vehicle-466722-p5 \
  --format="value(metadata.name)" | grep -E "avatar-reconstruction|model-rig|hunyuan"
```

**Already proven, do not redo:** task 5 (animation dignity) is measured and green. Ten rig
conventions animate both arms and both legs down both production paths; the fixes landed in
`src/glb-canonicalize.js` with regression cover in both test files, and the evidence is
committed at `prompts/quality-bar/_generated/10/animation-dignity-sweep.{txt,json}`.

**One known open defect from that pass:** on the runtime-only lane a Rigify rig binds the
`LeftArm`/`RightArm` clip track to `shoulder.L`/`shoulder.R` (the clavicle), because
`shoulder.L` and `upper_arm.L` normalize onto the same canonical name and no name-only table
separates them. The ingest canonicalizer resolves it structurally
(`canonicalizeJointNodes` pass 1.5), so stored avatars are correct and only a third-party GLB
loaded straight into the viewer is affected. **Remedy, part of this work order:** port pass
1.5/1.6 into `canonicalNodeMapFromObject` in `src/animation-retarget.js` and cover it with a
case in `tests/animation-retarget.test.js`.

## Tasks

1. **Fix the Rigify runtime-lane defect above.** Structural resolution, not a name special-case.
2. **Audit the avatar path end to end** with 6 real cases: four text prompts (athlete,
   grandmother, stylized kid, businessperson) and two CC0 reference photos. Score each against
   the IRL bar: proportions, face fidelity, hands, feet, clothing, texture seams at the neck
   and hairline. Document per-case failures precisely, with screenshots.
3. **Route avatars through the strongest live lane.** Confirm which mesh lane is Ready, prefer
   the highest-quality one with portrait realism cues, and verify the humanoid gate still hands
   its output to the rig worker cleanly with a normalized bind pose.
4. **Face fidelity for photo input.** Feed the actual user photo (multi-view when several were
   given) to the image-to-3D lane rather than a regenerated lookalike, and keep the face
   region's texture resolution highest. Never generate an avatar of a named third party from
   text alone; photo input implies consent by upload, text-only real-person names keep the
   generic treatment.
5. **Skin, eye and hair materials for avatars.** If QB-04 already shipped the material module,
   wire it. Do not duplicate it.
6. **The `/irl` moment.** Place three finished avatars in AR through the animated USDZ bake
   path and screenshot each. The pin should read as a person standing there, not a figurine.
7. **Publish.** Before and after gallery for all six cases through the whole chain (mesh,
   materials, rig, animation, AR), `data/changelog.json` entry in holder language, and an
   update to the `create-3d-avatar` skill guidance if defaults changed.

## Definition of done

- [ ] Rigify runtime-lane defect fixed structurally, with a regression test.
- [ ] `node scripts/animation-dignity-sweep.mjs` still 10/10 on both lanes after your changes.
- [ ] 6 of 6 test cases visibly improved, gallery in the report, hands specifically called out
      (count the fingers in the screenshots).
- [ ] AR screenshots included; humanoid-gate degrade path kill-tested (force a rig failure and
      confirm the mesh still ships with a working fallback, never a T-pose).
- [ ] `npm test` green; `npm run audit:rig-coverage` clean.
- [ ] `data/changelog.json` entry; `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| The strongest mesh lane is not Ready | Run the full audit and material, rig and AR work on the lane that is. The swap is one env var and a re-run; note it as the follow-up command. |
| Hands stay bad at max budgets | The honest mitigations are pose choice (relaxed hands), higher hand visibility in the reference views, and the director explicitly requesting "hands visible, fingers separated". Document what moved the needle with screenshots. |
| A stylized kid case drifts photoreal | Drop the case from public galleries and say so. Never ship photoreal likenesses of minors. |
| A new bone-naming convention appears | Add its mapping to `src/glb-canonicalize.js` plus a case in `tests/glb-canonicalize.test.js`. Never add a curated rig allowlist. |
| A GPU lane is cold | Wait it out. Do not fall back to a weaker lane for the quality audit. |

## Report format

The per-case scoring table with before and after images, the sweep result, the AR screenshots,
and any single remaining owner action. No recap of this file.
