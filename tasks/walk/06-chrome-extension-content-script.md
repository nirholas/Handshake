# Task 06 — Chrome Extension: Content Script Avatar Injection

## Priority: URGENT

## Objective
Implement the content script that injects the walking avatar iframe into any website the user is browsing, with the avatar appearing as a persistent floating character in the corner of the page.

## Scope
- File: `extensions/walk-avatar/content.js`
- On activation (message from background): create a fixed-position `<iframe>` pointing to `https://three.ws/walk-embed?avatar=<id>&controls=joystick&bg=transparent`
- iframe must be sandboxed appropriately: `allow="autoplay; scripts; same-origin"`
- Avatar container: fixed position, bottom-right, 180×260px, z-index 2147483647 (max, above everything)
- Container is draggable by the user (mousedown/touchstart on a drag handle at top of container)
- On deactivation (toggle off): remove the iframe cleanly, no DOM residue
- Handle SPA navigation: listen for `popstate` and `pushState` mutations — do not lose the avatar on client-side route changes
- On `walk:position` postMessage from iframe: optionally tilt the avatar container slightly based on walk direction (subtle, ±2deg transform)
- Avatar container has a minimal close ×  button in the top-right corner

## Definition of Done
- Avatar appears floating on `google.com`, `github.com`, and any other arbitrary site
- Drag works on both mouse and touch
- Close button removes avatar
- Avatar survives client-side navigation on SPAs (test on twitter.com)
- No style leakage onto host page

## Rules
Complete 100%. No stubs. No fake data. Wire every step end-to-end and verify in a real browser with the dev server running.
