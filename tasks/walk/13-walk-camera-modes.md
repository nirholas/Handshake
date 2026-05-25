# Task 13 — Walk Page: Camera Modes (Third / First / Orbit / Cinematic)

## Priority: HIGH

## Objective
Add four switchable camera modes so users can choose the perspective that fits how they want to experience the walking avatar.

## Scope
- File: `src/walk.js` + new `src/walk-cameras.js` module
- Modes:
  1. **Third-person** (default): camera 4m behind, 1.6m up, looks at avatar head; smoothly follows movement and rotation with critically-damped spring
  2. **First-person**: camera at avatar's eye position, follows head rotation; avatar mesh culled from view OR rendered with `renderOrder` so own arms/legs visible
  3. **Orbit**: free orbit around the avatar (existing OrbitControls), no follow
  4. **Cinematic**: scripted dolly — slowly arcs around avatar at fixed radius; auto-cuts every 5s to a new angle (for screenshot/showcase mode)
- UI: small camera-mode toggle in top-right HUD, four icons; current mode highlighted; keyboard shortcut `C` cycles modes
- Mode change is smooth: 600ms lerp from old camera transform to new — no snap
- Per-mode FOV: third 50°, first 75°, orbit 45°, cinematic 35° (cinematic feel)
- Each mode persists in `localStorage` as `walk:camera-mode`
- First-person mode: hide avatar's head mesh (lookup by node name like `Head`, `Wolf3D_Head`) to avoid clipping

## Definition of Done
- All four modes work and switch smoothly with `C` or HUD button
- First-person camera does not clip into the head/body
- Cinematic mode auto-cuts and looks good for at least 60s without breaking
- Camera mode persists across page reloads
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Wire to the existing Three.js scene — do not duplicate scene setup. Verify in a real browser.
