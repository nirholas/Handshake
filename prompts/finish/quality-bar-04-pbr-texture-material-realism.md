# QB-04: PBR texture and material realism

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/quality-bar-04-pbr-texture-material-realism.md`".
It is complete on its own. Also read `prompts/finish/quality-bar-_shared.md` and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end with a question, a plan you did not execute, or "should I proceed?".
2. Every blocker has a pre-answered route at the bottom. Use it and keep going.
3. CLAUDE.md hard rules: no mocks, no stubs, no TODO comments, no em-dash or en-dash
   characters. Stage explicit paths only. Do not push unless asked.
4. GPU and Vertex spend is pre-approved. Never downgrade quality to save credits.

## Mission

A perfect mesh still looks fake with a flat albedo texture. Every GLB the platform produces
should carry a complete PBR set (albedo, normal, roughness/metallic, AO where bakeable) tuned
per material class, so skin reads as skin and metal reads as metal under the viewers'
image-based lighting.

## Step 0: re-derive current state (trust nothing below)

```bash
ls workers/texture workers/remesh workers/stylize
grep -rn "restyle_material" api/_mcp3d/ api/_mcp/ mcp-server/src/tools/ | head
gcloud run services list --region us-central1 --project aerial-vehicle-466722-p5 \
  --format="value(metadata.name)" | grep -E "texture|remesh|stylize"
sed -n '1,40p' scripts/compress-glbs.mjs
```

Then generate one real GLB per live lane through `POST https://three.ws/api/forge` and inspect
which PBR channels each actually emits. `@gltf-transform/core` and `three` are already in the
dependency tree; do not add a library for this.

## Tasks

1. **Channel matrix.** Build `scripts/inspect-glb-materials.mjs` (if no equivalent exists) that
   prints, per material: which of baseColor, normal, metallicRoughness, occlusion and emissive
   textures exist, their resolutions, and the extension list. Run it over one real output per
   lane. The matrix goes in the report and in `workers/texture/README.md`.
2. **Derive the missing maps.** Where a lane emits albedo only, add a post-stage in
   `workers/texture/` (GPU, credits approved): normal-from-height estimation plus a
   roughness/metallic inference pass keyed by the director's material classification
   (`api/_lib/forge-director-prompts.js`). Wire it into the forge pipeline as a final, opt-out
   stage, never a separate user step.
3. **Measured-value presets.** Extend `restyle_material`'s preset library with real-world
   values: skin roughness 0.45 to 0.6, nonmetal metallic 0.0, brushed-steel anisotropy hints,
   car paint via `KHR_materials_clearcoat`, glass via `KHR_materials_transmission`. Render each
   preset in the platform viewer under every HDRI the viewer ships before shipping it.
4. **Skin, eyes, hair for avatars.** For `text_to_avatar` and `forge_avatar` outputs: subsurface
   approximation (`MeshPhysicalMaterial` thickness/attenuation or a baked SSS tint), a separate
   eye material with high specular and a clear cornea, hair with an alpha-cutout double-sided
   setup. This is the difference between a person and a mannequin.
5. **Texture resolution by tier.** Free tier keeps current sizes; standard and high go to 2K/4K
   albedo with matching normals. Keep payloads sane by extending the existing meshopt plus WebP
   chain in `scripts/compress-glbs.mjs` rather than writing a second encoder. Verify a
   4K-textured GLB still loads under Playwright WebKit and Android Chrome emulation; if it does
   not, tier the delivery (viewer fetches compressed, download offers full-res).
6. **Prove it.** Run the fixed benchmark set (`data/quality-bench/prompts.json`) through
   `node scripts/quality-bench.mjs` before and after, covering skin, metal, glass and wood
   subjects. `node scripts/quality-bench.mjs --compare=latest,previous` exits nonzero on a mean
   drop greater than 1.0; that gate must pass.

## Definition of done

- [ ] Channel matrix documented per lane; every lane emits or gains a full PBR set.
- [ ] Presets verified in-viewer under all shipped HDRIs, with screenshots.
- [ ] Avatar skin/eye/hair path shipped and screenshotted at 320, 768, 1440 px.
- [ ] Mobile payload check done, with real byte sizes.
- [ ] Quality-bench comparison run and no regression; numbers in the report.
- [ ] `npm test` green; `data/changelog.json` entry; `workers/texture/README.md` updated.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| KTX2 or WebP encode tooling | Use `@gltf-transform` plus the encoder already wired in `scripts/compress-glbs.mjs`. Never hand-roll an encoder. |
| A new model download looks necessary | Prefer what the texture worker already ships. If unavoidable, pull it from `gs://three-ws-model-weights`, never a runtime hub fetch. |
| A preset looks wrong under one HDRI | Test under every environment preset the viewer ships before tuning; record which HDRI drove the value. |
| Vertex refuses a prompt | The reason is in `promptFeedback.blockReason`, not `finishReason`. Rephrase and continue. |
| A GPU worker is cold or scaling | Expected. Wait or raise minScale within quota; never switch to a weaker lane to save time. |

## Report format

The channel matrix, before and after renders, the quality-bench delta, real byte sizes, and any
single remaining owner action. No recap of this file.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/quality-bar-04-pbr-texture-material-realism.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
