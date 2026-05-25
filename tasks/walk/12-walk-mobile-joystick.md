# Task 12 — Walk Page: Mobile Joystick + Haptics

## Priority: HIGH

## Objective
Make the mobile walk experience first-class: a responsive virtual joystick with proper dead zone, multi-touch support (joystick + camera drag simultaneously), and tactile haptic feedback.

## Scope
- File: existing joystick code in `pages/walk.html` / `src/walk.js`
- Joystick:
  - Anchored bottom-left, 120px outer / 56px inner thumb
  - Thumb follows touch within outer ring; clamped at ring radius
  - Magnitude → walk speed (0..1), angle → heading
  - Dead zone of ~12% (no movement for tiny touches)
  - Floating mode: tap anywhere on the left half of the screen to re-anchor the joystick at touch point
- Camera drag:
  - Single-finger drag on right half of screen orbits the camera around the avatar
  - Pinch (two fingers) on right half zooms
  - Touch events must be multi-touch aware (use `Pointer Events` not `Touch Events` where possible)
- Action buttons (bottom-right cluster):
  - Jump (large circular button, primary)
  - Wave / gesture (secondary)
  - Camera flip (third-person / first-person)
- Haptics:
  - `navigator.vibrate(10)` on jump press
  - `navigator.vibrate(5)` on action button press
  - Behind a setting (default on, toggleable in HUD overlay)
- iOS Safari quirks:
  - Disable pull-to-refresh and rubber-band scroll on the canvas container (`overscroll-behavior: none`, `touch-action: none`)
  - Honor `viewport-fit=cover` safe areas (`env(safe-area-inset-*)`)
- Landscape/portrait responsive — HUD reflows correctly

## Definition of Done
- Tested on real iOS Safari and real Android Chrome (or via remote debugging with a real device)
- Joystick + camera drag work simultaneously without input crosstalk
- Jump button vibrates on press where supported
- No accidental page zoom or scroll while playing
- 60 FPS sustained on a recent iPhone

## Rules
Complete 100%. No stubs. No fake data. Real device verification preferred — emulator at minimum. Wire end-to-end.
