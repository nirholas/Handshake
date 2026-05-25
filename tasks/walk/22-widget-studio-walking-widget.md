# Task 22 — Widget Studio: Walking Avatar Widget Type

## Priority: URGENT

## Objective
Add "Walking Avatar" as a first-class widget type in the Widget Studio (`pages/widget-studio.html`) so users can configure, preview, and publish a walking avatar widget the same way they configure other widget types.

## Scope
- Files: `pages/widget-studio.html`, `src/widget-studio.js` (locate the widget-type registry)
- Register new widget type: `walking-avatar`
- Schema (drives the editor UI on the left panel):
  - `avatarId` (avatar picker, required)
  - `controls` (enum: joystick | keyboard | none)
  - `environment` (enum: from environments list, task 18)
  - `autoplay` (bool)
  - `size` (preset: S/M/L/custom + W/H)
  - `position` (corner: tl/tr/bl/br/inline)
  - `bg` (color picker, supports transparent)
  - `walkSpeed` (slider 0.5–2.0)
  - `enableNarration` (bool — narrator from task 09; for site-embedded widgets)
- Live preview (right panel) renders the actual widget exactly as it will appear on a customer site — uses real iframe pointing to `/walk-embed`
- Save: persists widget config to `/api/widgets` (existing endpoint per the codebase) with `type: 'walking-avatar'`
- Publish: emits the snippet for the chosen embed flavor (iframe or JS SDK) and copies to clipboard
- Widget client (`public/widget-client.js`) must learn to render the walking type — extend its dispatcher to recognize `type: 'walking-avatar'` and inject the iframe accordingly

## Definition of Done
- Open Widget Studio → "Walking Avatar" appears as a widget type option
- All editor fields work and update the preview in real time
- Save persists to the real backend; refresh shows the saved widget in the user's widget list
- Embed snippet renders the configured widget on a blank page
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real backend persistence, real preview. Wire end-to-end.
