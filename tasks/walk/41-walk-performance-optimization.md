# Task 41 — Walk Performance: LOD, Frustum Culling, Asset Compression

## Priority: HIGH

## Objective
Bring the walk page to a sustained 60 FPS on a mid-tier mobile (iPhone 12, Pixel 6) with one avatar + a populated environment + one NPC. Today's baseline is unverified — measure first, then optimize the worst offenders.

## Scope
- Profile first (real device or Chrome remote debugging):
  - Record performance trace on mobile of `/walk?env=gallery`
  - Identify worst frame-time contributors (script vs render vs GPU)
  - Document findings in `tasks/walk/_perf-baseline.md`
- LOD (Level of Detail):
  - Avatars: generate two simplified meshes at 50% and 20% triangle counts (use `meshoptimizer` via `@mesh-optimizer/simplifier` package)
  - Pre-generate at upload time if practical; otherwise generate client-side on first load and cache in IndexedDB
  - Switch LOD based on screen-space size
- Frustum culling: ensure `Frustum.intersectsObject` is called on every NPC and decorative scene mesh per frame (Three.js does this by default for `Mesh.frustumCulled`, but verify nothing has it disabled)
- Texture compression:
  - Run a build step `scripts/compress-environment-textures.mjs` that converts environment textures to KTX2 / Basis Universal
  - Three.js loads with `KTX2Loader` (real, not skipped)
- GLB compression:
  - Run `gltf-transform` on environment GLBs (Draco for geometry, WebP for textures where KTX2 isn't supported)
- Render scaling:
  - On mobile: `renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))`
  - On desktop: dynamic pixel ratio that drops when frame time exceeds 18ms (adaptive)
- Animation cost:
  - Limit `SkinnedMesh` bone count where avoidable; throttle NPC animation updates to 30 Hz
- Lights: cap at 2 dynamic + IBL; disable shadows on mobile

## Definition of Done
- Real measurement on real mobile shows ≥60 FPS sustained in default environment with one NPC
- `tasks/walk/_perf-baseline.md` documents before/after frame times
- Environment GLB total transfer < 4 MB compressed
- No visible LOD popping at default camera distance
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real measurements, real compression, real LOD. Wire end-to-end.
