# 04: PBR texture and material realism

Read `prompts/quality-bar/_shared.md` first. Its operating clause applies: finish 100%, never ask.

## Mission

Close the material gap. A perfect mesh still looks fake with a flat albedo texture. Every GLB
the platform produces should carry a complete PBR set (albedo + normal + roughness/metallic,
AO where the pipeline can bake it) tuned per material class, so skin reads as skin and metal
reads as metal under the viewers' image-based lighting.

## Current state (verify)

- `workers/texture/` is the SDXL texture worker; the swarm raised its SDXL settings to the
  platform bar today (02f1d0230). `workers/remesh/`, `workers/stylize/` exist as services.
- `restyle_material` MCP tool re-skins GLBs from an instruction or PBR preset
  (see `api/` MCP handlers). TRELLIS and Hunyuan3D emit their own textures.

## Tasks

1. **Audit what each lane actually emits.** For TRELLIS, Hunyuan3D, TripoSR/SG outputs: open
   real GLBs (three.js or `@gltf-transform/core`, both in the dependency tree) and inspect
   which PBR channels exist. Build a small `scripts/` inspection tool if none exists, and
   record a channel matrix per lane in the report.
2. **Derive missing maps.** Where a lane emits albedo-only, add a post-stage in the texture
   worker (GPU, credits approved): normal-from-height estimation and a roughness/metallic
   inference pass keyed by the director's material classification from prompt 01 (person /
   metal / wood / fabric / plastic / glass). Wire it into the forge pipeline as an opt-out
   final stage, not a separate user step.
3. **Material presets that match reality.** Extend `restyle_material`'s preset library with
   measured-value presets (real-world roughness/metallic/IOR values: skin 0.45-0.6 roughness,
   nonmetal 0.0 metallic, brushed steel anisotropy hints, car paint clearcoat via
   `KHR_materials_clearcoat`, glass via `KHR_materials_transmission`). Registered three.js
   loaders already handle these extensions; verify each preset renders correctly in the
   platform viewer before shipping it.
4. **Skin, eyes, hair for avatars.** For `text_to_avatar` / `forge_avatar` outputs, ensure the
   avatar path applies: subtle subsurface approximation (three.js `MeshPhysicalMaterial`
   thickness/attenuation or a baked SSS tint), separate eye material with high specular and
   clear cornea, hair with alpha-cutout double-sided setup. This is what makes people look IRL
   instead of mannequin.
5. **Texture resolution by tier.** Free tier keeps current sizes; standard/high go to 2K/4K
   albedo with matching normal maps (GPU cost is credits). Confirm GLB payload stays sane with
   KTX2/Basis compression where the viewer path supports it (`three/examples/jsm/loaders/KTX2Loader`
   is available; test on mobile Safari before defaulting it on).
6. **Prove it.** Benchmark set (prompt 09 set, or create per prompt 01 task 6) rendered in the
   platform viewer, before/after per lane. Skin/metal/glass/wood subjects mandatory.

## Definition of done

- Channel matrix documented; every lane emits or gains a full PBR set.
- Presets verified in-viewer; avatar skin/eye/hair path shipped and screenshotted.
- Mobile payload check done (a 4K-textured GLB must still load on a mid phone; if not, tier the
  delivery: viewer fetches compressed, download button offers full-res).
- Changelog entry + `workers/texture/README.md` updated. Pathspec commits only.

## Anticipated blockers, pre-answered

- KTX2 encode tooling: `toktx` or `@gltf-transform/cli` with the basisu encoder; add as a dev
  dependency or use the container the texture worker builds, do not hand-roll an encoder.
- Normal-map estimation model choice: prefer what the texture worker already ships (SDXL
  aux/controlnet stack) over adding a new model download; if adding one, it must come from the
  weights bucket, not a runtime hub pull.
- A preset that looks wrong under one HDRI: test under all environment presets the viewer
  ships (prompt 05 lists them) before tuning values.
