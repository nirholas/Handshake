# Task 14 — Walk Page: Avatar Gestures (Wave, Dance, Sit, Point, Cheer)

## Priority: HIGH

## Objective
Add a gesture/emote system so the avatar can express itself while walking — wave, dance, sit, point, cheer, agree/disagree. These are triggered by the user and also by other systems (TTS narration triggers "talking" gesture, etc.).

## Scope
- New module: `src/walk-gestures.js`
- Animation source: use real animation clips from `public/animations/` (verify available clips; if missing, source CC0 clips from Mixamo or Ready Player Me's free library and add to `public/animations/gestures/`)
- Gestures (each one a real FBX/GLB clip):
  - `wave` — raise hand and wave
  - `dance` — short looping dance (4s loop)
  - `sit` — sit on ground, idle while sitting; rises on next walk input
  - `point` — point forward (used by narrator to point at sections)
  - `cheer` — both arms up
  - `agree` — head nod
  - `disagree` — head shake
  - `talking` — mouth/upper-body talking idle (looped during TTS)
- State machine integration:
  - Extend `src/animation-state-machine.js` (existing) with a `gesture` slot that crossfades over the base walk/idle layer
  - Gestures play once unless looping; auto-return to base state
  - Walking + gesture: upper-body-only blending (use animation masks on bones above pelvis)
- UI:
  - Gesture wheel: hold `G` (desktop) or long-press action button (mobile) → radial picker fades in with 8 gesture icons; release to play selected gesture
  - Each gesture sends `walk:gesture` postMessage event from embed
- API: expose `window.walk.playGesture('wave')` for programmatic triggers (used by narrator, chat, etc.)

## Definition of Done
- All 8 gestures play smoothly with no T-pose flashes between clips
- Walking + gesture blends correctly (upper body gestures, lower body walks)
- Gesture wheel UI works on both desktop (hold G) and mobile (long-press)
- Programmatic API verified from console: `walk.playGesture('dance')`
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Use real animation clips with proper licenses. Wire to the existing state machine — do not bypass it.
