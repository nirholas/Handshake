# Task 05 — Chrome Extension: Scaffold & Manifest

## Priority: URGENT

## Objective
Create the Chrome extension scaffold that allows users to inject a walking three.ws avatar onto any website they visit. This is the foundation task — subsequent tasks build on it.

## Scope
- New directory: `extensions/walk-avatar/`
- `manifest.json` — Manifest V3, permissions: `storage`, `activeTab`, `scripting`; host_permissions: `<all_urls>`
- `popup.html` + `popup.js` — Extension popup: shows avatar picker (fetches user's avatars from `https://three.ws/api/avatars/mine` if logged in, else shows a default), toggle button to enable/disable avatar on current tab
- `content.js` — Content script injected into every page: injects the walk-embed iframe, handles page navigation cleanup
- `background.js` — Service worker: stores selected avatar ID in `chrome.storage.local`, relays messages between popup and content script
- `icons/` — 16, 32, 48, 128px icons (use the existing `public/pwa-icon.svg` as source)
- `styles/` — Isolated CSS for the injected iframe container (must not bleed into host page)
- Add build script: `npm run build:extension` using Rollup or esbuild, outputs to `dist/extension/`
- Add `extensions/walk-avatar/README.md` with load-unpacked instructions

## Definition of Done
- Extension loads in Chrome via `chrome://extensions` → Load unpacked → `dist/extension/`
- Popup renders with toggle and avatar selection
- No manifest errors in Chrome extension panel
- Background service worker registers without errors

## Rules
Complete 100%. No stubs. No fake data. Wire every step end-to-end and verify in a real browser with the dev server running.
