# Task 11 — Walk Page: Keyboard Controls (WASD + Arrows + Modifiers)

## Priority: HIGH

## Objective
Polish the desktop keyboard control scheme on `/walk` so it feels like a proper 3D game: smooth acceleration, run modifier, jump, look-around — not just on/off booleans flipping a transform.

## Scope
- File: `src/walk.js` (or wherever the walk controller lives — locate the existing input handler)
- Movement keys:
  - `W` / `↑` — forward
  - `S` / `↓` — backward
  - `A` / `←` — strafe left
  - `D` / `→` — strafe right
  - `Shift` (held) — run modifier (1.8× speed)
  - `Space` — jump (uses existing jump animation if available; if not, real arc + gravity)
  - `Q` / `E` — rotate avatar 90° (snap turn — useful for fixed-camera mode)
  - `Esc` — release pointer lock / exit immersive mode
- Mouse look:
  - Click canvas → request pointer lock → mouse moves rotate the camera (third-person orbit around avatar, distance fixed)
  - Scroll wheel → zoom camera distance (clamped 2m–8m)
- Smooth input:
  - Use a per-frame accumulator with easing — do not jump from 0 → max speed in one frame
  - Damping when keys release (decel over ~150 ms)
- Wire input → animation state machine: idle ↔ walk ↔ run ↔ jump
- Accessibility: focus indicator on canvas, `aria-label`, full key map listed in a `?` overlay (toggle with `?` key)

## Definition of Done
- Movement on desktop feels smooth; no judder
- Run modifier engages and disengages animation correctly
- Jump arcs and lands cleanly with gravity
- Pointer lock requests work in Chrome and Firefox
- Key map overlay opens with `?` and is keyboard-navigable
- No console errors; no input swallowed by other listeners

## Rules
Complete 100%. No stubs. No fake data. Wire to the existing animation state machine — do not create a parallel one. Verify in a real browser with the dev server running.
