# Task 04 — Walk Embed SDK: One-Line JS Embed

## Priority: URGENT

## Objective
Build a JavaScript embed SDK (`public/walk-embed-sdk.js`) that anyone can drop into their website with a single `<script>` tag to embed a walking avatar. Similar to how Intercom or Drift embed — one script, zero configuration required, avatar appears as a floating 3D character on the page.

## Scope
- File: `public/walk-embed-sdk.js` (must be bundled, no external deps at runtime)
- Usage: `<script src="https://three.ws/walk-embed-sdk.js" data-avatar="<uuid>"></script>`
- Script reads `data-avatar` attribute from its own `<script>` tag
- Injects a fixed-position `<iframe>` (bottom-right corner, 200×300px default) pointing to `/walk-embed?avatar=<id>&controls=none&autoplay=true`
- Exposes `window.ThreeWalkAvatar` global: `{ mount(el), unmount(), setAvatar(id), setSize(w,h), setPosition('bottom-left'|...) }`
- Accepts optional `data-position`, `data-width`, `data-height` attributes on the script tag
- Listens for `postMessage` from the iframe and re-emits as `CustomEvent` on `document`: `new CustomEvent('walk:position', { detail: { x, z } })`
- Works on any website (no framework dependencies)
- Minified build goes to `dist/walk-embed-sdk.min.js` — add a Vite build config entry for this

## Definition of Done
- Drop the script tag on a blank `index.html` → avatar appears floating in corner
- `window.ThreeWalkAvatar.setAvatar('new-id')` swaps avatar live
- `window.ThreeWalkAvatar.setPosition('bottom-left')` moves it
- Zero console errors on host page
- Bundle < 10 KB (it's just an iframe injector)

## Rules
Complete 100%. No stubs. No fake data. Wire every step end-to-end and verify in a real browser with the dev server running.
