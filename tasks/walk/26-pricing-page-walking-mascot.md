# Task 26 — Pricing Page: Walking Mascot

## Priority: MEDIUM

## Objective
Add a small walking avatar mascot to the pricing page (`pages/pricing.html` and/or `pages/x-pricing.html`) that walks across the pricing tier cards and reacts when the user hovers a tier. Subtle, charming, drives engagement.

## Scope
- File: `pages/pricing.html` (and `x-pricing.html`)
- Embed a walking avatar via the JS SDK from task 04, but in "stage" mode:
  - Avatar walks along an invisible horizontal path that spans the pricing tier row
  - On hover over a tier card, dispatch `walk:goto` postMessage with the tier's center X coord → avatar walks to that tier and stops, plays `point` gesture toward the tier
  - On mouse leave, resumes wandering
- Avatar size: 120×160px, transparent background, positioned absolutely above the pricing cards
- Speech bubble (task 15) shows tier-specific copy when avatar stops:
  - Free: "Great starting point!"
  - Pro: "Most popular!"
  - Studio: "Power-user pick."
- Disable on `prefers-reduced-motion` and on small mobile (<480px width)

## Definition of Done
- Visit pricing page → avatar walks along the tier row
- Hover a tier → avatar walks to it and points with a bubble
- Reduced motion users see a static avatar instead of animated wandering
- No console errors
- No layout breakage on mobile

## Rules
Complete 100%. No stubs. No fake data. Real avatar, real animation, real interaction. Wire end-to-end.
