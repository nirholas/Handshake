# Task 33 — Walk-Aware Page Transitions: Themed Per Destination

## Priority: MEDIUM

## Objective
Make the transition between pages thematically match the destination — e.g., walking to `/walk` triggers a "stepping into the world" zoom, walking to `/pricing` triggers a brief "store opening" effect. Subtle but memorable.

## Scope
- Module: `src/walk-companion-transitions.js` — registered by `src/walk-companion.js`
- Per-route transition presets (config table):
  - `/walk` → camera-zoom-into-avatar effect: avatar grows to fill viewport, then crossfades to walk page canvas
  - `/pricing` → curtain-pull from top
  - `/agent/*` → spotlight expand from where the link was clicked
  - `/marketplace` → corridor depth zoom
  - `/dashboard` → softer fade with subtle glow
  - default → simple fade + slide from task 32
- Each preset is a function: `(fromEl, toEl, avatarEl) => Promise<void>` that runs the animation
- Use Web Animations API (`element.animate`) — no jQuery, no framer-motion
- Respect `prefers-reduced-motion`: all presets degrade to simple fade
- Settings UI in nav toggle area: "Themed transitions on/off"

## Definition of Done
- Click `/walk` link → camera-zoom transition plays
- Click `/pricing` link → curtain-pull plays
- `prefers-reduced-motion: reduce` → all degrade to fade
- No console errors
- No layout shift after transitions complete

## Rules
Complete 100%. No stubs. No fake data. Real animations, real preference detection. Wire end-to-end.
