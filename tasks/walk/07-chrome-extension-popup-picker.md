# Task 07 — Chrome Extension: Popup Avatar Picker

## Priority: URGENT

## Objective
Build the extension popup UI so users can sign in, browse their three.ws avatars, pick one, and toggle the walking avatar on/off for the current tab. The picker must show real avatars from the real three.ws API — no placeholders.

## Scope
- File: `extensions/walk-avatar/popup.html`, `popup.js`, `popup.css`
- Layout (360×480px popup):
  - Header: three.ws logo, "Sign in" or signed-in user pill (shows handle from `/api/me`)
  - Tab bar: "My Avatars" | "Featured" | "Recent"
  - Avatar grid: 3 columns of 96×96 thumbnails, each loads via `/api/avatars/<id>/thumb` real endpoint
  - Selected avatar gets accent border (var(--accent) from site CSS)
  - Footer: large toggle switch "Enable on this site" + speed slider (0.5x–2x walk speed)
- Auth: extension opens `https://three.ws/login?redirect=ext` in a new tab; site posts back the session token via `window.postMessage`; popup stores in `chrome.storage.local` as `threews_session`
- On avatar select: write `{ avatarId, walkSpeed, enabled }` to `chrome.storage.local`; send `chrome.tabs.sendMessage` to current tab → content script swaps the iframe `src`
- Empty state if user has zero avatars: CTA "Create your first avatar" → opens `https://three.ws/create-selfie`
- Loading state: real skeleton shimmer (no fake loading spinner)
- Error state on API failure: shows real error message + retry button

## API endpoints to wire (all already exist or must exist — verify in `api/`)
- `GET /api/me` — session check
- `GET /api/avatars/mine` — user's avatars list
- `GET /api/avatars/featured` — featured avatars
- `GET /api/avatars/<id>/thumb` — thumbnail JPG

If any of these endpoints don't exist, create them in `api/` as real Vercel functions with real database queries — do not stub.

## Definition of Done
- Sign in flow works end-to-end from popup
- Real avatars from real API render in the grid
- Selecting an avatar in the popup immediately swaps the avatar on the current tab
- Speed slider live-updates the iframe via postMessage
- Toggle off removes the iframe from the tab
- No console errors in popup DevTools or content script

## Rules
Complete 100%. No stubs. No fake data. Wire every step end-to-end and verify in a real browser with the dev server running. If an API endpoint is missing, build it for real — do not mock.
