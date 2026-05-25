# Task 15 — Walk Page: Speech Bubbles & Chat Overlay

## Priority: HIGH

## Objective
Render speech bubbles above the avatar's head that follow it across the screen as it walks. The bubbles are used by the chat system, the narrator (extension task 09), and direct API calls. Bubbles look like the comic-style callouts in games like Animal Crossing or The Sims.

## Scope
- New module: `src/walk-speech-bubble.js`
- DOM-based bubbles (overlay div, not WebGL text) — easier to style, real text selection, accessible
- Each frame: project avatar head bone world position to screen coords (`Vector3.project(camera)`), set bubble CSS `transform: translate(...)` 
- Bubble structure:
  - `.walk-bubble` container — max-width 280px, white background, rounded 16px, drop shadow
  - Pointer triangle below bubble pointing at the head
  - Text wraps; supports markdown bold/italic (use existing markdown lib if any in `node_modules`; if not, simple regex)
  - Optional avatar name pill above bubble (small)
- API:
  - `walk.say(text, opts?)` — opts: `{ duration: 4000, voice: false, gesture: 'talking' }`
  - Returns a Promise that resolves when bubble dismisses
  - Queue: multiple `say()` calls queue and play in order
- Auto-behaviors:
  - If `voice: true`, calls `/api/tts/speak` and times the bubble to audio length (uses `audio.duration` from real audio)
  - During speech, triggers `talking` gesture from task 14
  - Bubble fades out 600ms after duration ends
- Off-screen handling:
  - When avatar is behind camera: bubble hides (don't show backward-projected bubbles)
  - When avatar is at edge of screen: bubble clamps to screen edge with an arrow indicator pointing toward the avatar
- Bubble click: dismisses early

## Definition of Done
- `walk.say('Hello, world!')` from console shows a bubble that tracks the avatar smoothly
- Bubbles queue correctly when called rapidly
- TTS bubbles match audio length exactly (no early dismiss)
- Off-screen clamp + indicator works when avatar walks past camera edge
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real TTS for voice option. Wire end-to-end.
