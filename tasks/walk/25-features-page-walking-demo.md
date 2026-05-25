# Task 25 — Features Page: Walking Avatar Demo Section

## Priority: MEDIUM

## Objective
Add a dedicated section on the features page (`pages/features.html`) that showcases the walking avatar capability: live, interactive demo embedded inline, plus benefit copy and a CTA.

## Scope
- Files: `pages/features.html`, `public/features.json`
- Add a new feature entry to `public/features.json`:
  ```json
  {
    "id": "walking-avatar",
    "title": "Walking Avatars",
    "tagline": "Your avatar walks. Anywhere on the web.",
    "description": "Embed a fully animated, voice-capable, walking 3D avatar on any page — or browse the web with your own avatar as your guide via our Chrome extension.",
    "demoType": "walking-avatar-inline",
    "ctaLabel": "Try Walking →",
    "ctaHref": "/walk"
  }
  ```
- Renderer in `pages/features.html` already handles `demoType` values; add handler for `walking-avatar-inline` that injects an iframe to `/walk-embed?avatar=<featured>&controls=joystick`
- Section layout:
  - Left: heading, tagline, 3-bullet feature list (Walk anywhere · Voice chat · Chrome extension), CTA
  - Right: 360×480 walking avatar iframe with rounded corners
- Below the section: three smaller cards linking to (a) `/walk` page, (b) Chrome extension store page, (c) embed snippet copy
- Mobile: stacks vertically, iframe shrinks to viewport width

## Definition of Done
- Visit `/features` → walking avatar section appears with a real, interactive walking avatar
- Joystick works inside the embedded iframe on the features page
- All three sub-CTAs link to real destinations (extension link points to the Web Store URL once published; until then, link to `/extension` info page)
- No console errors
- Mobile layout clean

## Rules
Complete 100%. No stubs. No fake data. Real iframe, real demo. Wire end-to-end.
