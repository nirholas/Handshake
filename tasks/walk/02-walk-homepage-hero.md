# Task 02 — Homepage Hero: Walking Avatar

## Priority: URGENT

## Objective
Integrate the walking avatar experience into the three.ws homepage (`pages/home-next.html`) hero section. The homepage hero must render a live, animated 3D avatar that walks/idles in place within the hero canvas — not a video, not a GIF, a real Three.js scene. The avatar used should be the platform's default demo avatar (loaded from the real API, not hardcoded).

## Scope
- File: `pages/home-next.html` and `src/home-next.js` (or equivalent entry)
- Add a Three.js canvas behind or alongside the hero copy
- Reuse the walk animation state machine from `src/animation-state-machine.js` — do not duplicate animation logic
- Avatar plays idle animation on load; transitions to a slow walk cycle after 2 seconds
- Canvas is responsive: fills container on mobile, sits right-side on desktop (split layout)
- Avatar loads from `/api/avatars/featured` or the existing default avatar endpoint — real fetch
- Canvas does not block clicks on hero CTA buttons (pointer-events handled correctly)
- No autoplay video fallback — the 3D scene is the feature

## Definition of Done
- Homepage loads and the hero avatar is visible and animating within 3 seconds on a standard connection
- No layout shift (CLS) from canvas injection
- Mobile: avatar renders at correct aspect, no overflow
- Desktop: split hero layout is visually clean
- Console: zero errors
- Network: avatar GLB fetched from real API

## Rules
Complete 100%. No stubs. No fake data. Wire every step end-to-end and verify in a real browser with the dev server running.
