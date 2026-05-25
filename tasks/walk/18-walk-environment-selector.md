# Task 18 — Walk Page: Environment / Scene Selector

## Priority: HIGH

## Objective
Let users choose the environment their avatar walks in: park, cyberpunk street, beach, gallery, abstract void, three.ws office. Each environment is a real GLB scene with appropriate lighting, skybox, and ground.

## Scope
- New module: `src/walk-environments.js`
- Source environments — use real CC0 / properly licensed assets:
  - `park` — green grass, trees, simple bench (Poly Pizza / Quaternius CC0 packs)
  - `cyberpunk` — neon street scene
  - `beach` — sand, water shader, palm trees
  - `gallery` — white-walled art space (good for showcase)
  - `void` — minimal grid floor, gradient sky (procedural, no GLB needed)
  - `office` — three.ws virtual office (start with a simple room, can be replaced later)
- Store at `public/environments/<name>/scene.glb` + `preview.jpg` (256×256)
- Each environment includes:
  - GLB scene
  - HDR environment map (`public/environments/<name>/env.hdr`) for IBL
  - Recommended directional light direction/intensity (stored in `public/environments/index.json` metadata)
  - Walkable ground plane (avatar collides with `y=0` plus the GLB ground mesh raycast)
- URL param: `?env=park` — environment loads on page open
- HUD: environment picker dropdown showing previews; swap is smooth (fade to black 300ms, swap, fade in)
- Persists last selection in `localStorage`

## Definition of Done
- All six environments load and look visually distinct
- Avatar collides correctly with each ground (no clipping, no floating)
- Lighting matches environment (cyberpunk is dim with neon; beach is bright)
- `?env=beach` loads beach on first paint
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real GLBs, real HDRs, real licenses. No "coming soon" environments. Wire end-to-end.
