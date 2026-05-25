# Task 43 — Walk AR Mode: WebXR Immersive-AR Polish

## Priority: HIGH

## Objective
The existing walk page has a camera-feed AR mode stub. Upgrade it to real WebXR immersive-ar so the avatar walks on real-world surfaces detected via plane detection — not just overlaid on a flat camera feed.

## Scope
- File: `pages/walk.html`, `src/walk.js`
- Replace the current camera-feed overlay approach with real WebXR:
  - `navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test', 'plane-detection', 'dom-overlay'] })`
  - Use hit-test to cast a ray from the screen center to detected surfaces; avatar stands on the first hit
  - Plane detection: once a real horizontal plane is detected, lock the avatar to that plane's Y and allow walking on it
  - Shadows: use `XRLightEstimate` to match real-world lighting for the avatar
- UI flow:
  - AR button visible only if `navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')`
  - On enter AR: existing walk controls (joystick or tap-to-walk) reposition the avatar relative to the detected plane
  - Tap on a detected surface → avatar walks to that point
  - Pinch to scale avatar (0.5–2×)
  - Exit AR: `session.end()`, restore canvas-based walk
- On unsupported devices: fallback shows a camera-feed overlay (existing behavior); do not break existing fallback
- Dom overlay: the joystick and HUD buttons remain accessible via `domOverlay: { root: document.getElementById('walk-hud') }`

## Definition of Done
- On an ARCore device (Android Chrome), enter AR → avatar stands on real floor
- Tap on floor → avatar walks there using plane-normal movement
- Lighting roughly matches real-world brightness via `XRLightEstimate`
- Fallback on non-AR devices shows camera-feed mode, no errors
- AR session exits cleanly

## Rules
Complete 100%. No stubs. No fake data. Real WebXR, real hit-test, real plane detection. Wire end-to-end. If a real AR device is unavailable for testing, document the limitation clearly but implement fully.
