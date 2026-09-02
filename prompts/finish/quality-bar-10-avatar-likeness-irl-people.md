# QB-10: Avatar likeness, IRL people quality

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/quality-bar-10-avatar-likeness-irl-people.md`".
It is complete on its own. Also read `prompts/finish/quality-bar-_shared.md` and `CLAUDE.md`.

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

**The clavicle-pivot defect that pass left open is also fixed** (re-verified 2026-08-01): a
Rigify rig used to bind the `LeftArm`/`RightArm` clip track to `shoulder.L`/`shoulder.R`, the
clavicle, on the runtime-only lane. `resolveArmShoulderCollisions` now lives in
`src/glb-canonicalize.js:475` and both lanes call it (ingest through `canonicalizeJointNodes`,
runtime through `canonicalBoneEntries` in `src/animation-retarget.js:121`), so the sweep passes
with no warning. If a new rig ever trips it, widen that resolver; never add a per-rig name
special-case and never add a rig allowlist.

So the rig half of this work order is done. **What is open is the likeness half:** everything
below except the sweep.

## Tasks

1. **Audit the avatar path end to end** with 6 real cases: four text prompts (athlete,
   grandmother, stylized kid, businessperson) and two CC0 reference photos. Score each against
   the IRL bar: proportions, face fidelity, hands, feet, clothing, texture seams at the neck
   and hairline. Document per-case failures precisely, with screenshots.
2. **Route avatars through the strongest live lane.** Confirm which mesh lane is Ready, prefer
   the highest-quality one with portrait realism cues, and verify the humanoid gate still hands
   its output to the rig worker cleanly with a normalized bind pose.
3. **Face fidelity for photo input.** Feed the actual user photo (multi-view when several were
   given) to the image-to-3D lane rather than a regenerated lookalike, and keep the face
   region's texture resolution highest. Never generate an avatar of a named third party from
   text alone; photo input implies consent by upload, text-only real-person names keep the
   generic treatment.
4. **Skin, eye and hair materials for avatars.** If QB-04 already shipped the material module,
   wire it. Do not duplicate it.
5. **The `/irl` moment.** Place three finished avatars in AR through the animated USDZ bake
   path and screenshot each. The pin should read as a person standing there, not a figurine.
6. **Publish.** Before and after gallery for all six cases through the whole chain (mesh,
   materials, rig, animation, AR), `data/changelog.json` entry in holder language, and an
   update to the `create-3d-avatar` skill guidance if defaults changed.

## Definition of done

- [ ] `node scripts/animation-dignity-sweep.mjs` still reports 10/10 on both lanes after your
      changes (it does today; a regression here is a release blocker).
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

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/quality-bar-10-avatar-likeness-irl-people.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
