# Task 36 — Walk Path Visualization: Footstep Trails & Routes

## Priority: LOW

## Objective
Render aesthetic visual trails behind the walking avatar — footprints, glow particles, or a faint line — so users see where they've been on the page or in the 3D walk scene. Pure delight feature.

## Scope
- Module: `src/walk-trails.js`
- Three trail styles, user-selectable in settings:
  - `footprints` — alternating left/right footprint icons fade in/out (DOM overlay for 2D, decals for 3D scene)
  - `glow` — soft particle trail (Three.js Points or 2D canvas particles)
  - `line` — single continuous polyline that fades over time
- Trails fade over 5 seconds, then are removed from the scene
- In 3D walk scene: decals on the ground using Three.js DecalGeometry, properly oriented to ground normal
- In 2D companion mode (across site): SVG path/circles overlaid behind the avatar canvas
- Performance budget: cap at 60 trail elements at once; oldest removed first
- Trail color: derived from avatar's accent color (read from `avatar.meta.accent` or fallback to brand accent)

## Definition of Done
- Each trail style works in both 2D companion and 3D walk modes
- Trails fade smoothly with no visible "pop" on removal
- 60-element cap enforced (verify by walking continuously for 30s)
- No FPS drop with trails on
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real decals / real SVG / real particles. Wire end-to-end.
