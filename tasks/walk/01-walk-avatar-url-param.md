# Task 01 — Walk Page: ?avatar= URL Parameter Support

## Priority: URGENT

## Objective
The existing `/walk` page must fully support loading any avatar by ID via the `?avatar=<uuid>` query parameter. When the URL `/walk?avatar=bacff13e-b64b-4ac0-860d-44f0168ad23b` is opened, the page must fetch that avatar's GLB from the three.ws avatar API, load it into the Three.js scene, and begin the walk experience with that avatar immediately — no login required to view.

## Scope
- File: `pages/walk.html` and its corresponding JS entry (likely `src/walk.js` or inline script in that page)
- On page load, parse `new URLSearchParams(location.search).get('avatar')` 
- Fetch `/api/avatars/<id>` to resolve the avatar's GLB URL
- Load the GLB into the existing Three.js walk scene using the existing loader pipeline
- If no `?avatar=` param, fall back to the current default avatar (do not break the default flow)
- If the avatar ID is invalid or the fetch fails, show a real error state with a "try another avatar" CTA — no silent failures

## Definition of Done
- `https://three.ws/walk?avatar=bacff13e-b64b-4ac0-860d-44f0168ad23b` loads that specific avatar and it walks
- Network tab shows a real API call to `/api/avatars/<id>`
- Works on mobile (joystick controls) and desktop (WASD/arrow keys)
- No console errors
- No mocks, no hardcoded avatar paths

## Rules
Complete 100%. No stubs. No fake data. Wire every step end-to-end and verify in a real browser with the dev server running.
