# Task 28 — Profile Page: Walking Avatar Hero

## Priority: MEDIUM

## Objective
Replace the static avatar image on user profile pages (`pages/profile.html`, `pages/handle.html`) with a live walking avatar canvas in a stage area. Avatar walks idly when no visitor interacts; reacts when a visitor clicks.

## Scope
- Files: `pages/profile.html`, `pages/handle.html`
- Hero section gets a 480×600 canvas (responsive: full-width on mobile)
- Avatar: the profile owner's primary avatar
- Background: gradient based on profile's accent color (read from `profile.theme.accent`)
- Default behavior: avatar wanders within stage area
- Visitor interactions:
  - Click stage → avatar walks to click point, plays `wave`
  - Hover stage → avatar turns to face cursor
  - "Say hi" button → visitor records a short voice clip → sent to profile owner's inbox (real `/api/messages`); avatar plays `agree` gesture and shows bubble "Got it!"
- Stats overlay (top-right of stage): follower count, agent count, joined date — real values from `/api/profiles/<handle>`
- "Walk with me" CTA → opens full `/walk?avatar=<id>&handle=<handle>` (multiplayer-aware: drops visitor into same room if profile owner is currently online)

## Definition of Done
- Visit a profile → avatar walks live in hero stage
- Click stage → avatar reacts as specified
- "Say hi" sends a real message and the owner sees it in their inbox
- Profile stats are real values
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real avatar, real profile data, real messaging. Wire end-to-end.
