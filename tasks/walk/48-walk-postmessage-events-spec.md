# Task 48 — Walk postMessage Events: Full Spec & Implementation

## Priority: MEDIUM

## Objective
Define, implement, and document a complete bi-directional postMessage contract between the walk-embed iframe and host pages. This is the integration API that makes the embed programmable from any host site.

## Scope
- Module: `src/walk-embed-events.js` (imported by `pages/walk-embed.html`)
- **Outbound events** (iframe → host):
  - `{ type: 'walk:ready', avatarId, env }` — fired on full init
  - `{ type: 'walk:position', x, z, heading }` — fired at 10 Hz while moving
  - `{ type: 'walk:gesture', gesture }` — fired when gesture plays
  - `{ type: 'walk:speak', text, durationMs }` — fired when avatar starts speaking
  - `{ type: 'walk:env', env }` — fired when environment changes
  - `{ type: 'walk:error', code, message }` — any error
- **Inbound commands** (host → iframe via `iframe.contentWindow.postMessage`):
  - `{ type: 'walk:goto', x, z }` — walk to position
  - `{ type: 'walk:gesture', gesture }` — play gesture
  - `{ type: 'walk:say', text, voice }` — speak
  - `{ type: 'walk:env', env }` — change environment
  - `{ type: 'walk:avatar', avatarId }` — swap avatar
  - `{ type: 'walk:config', speed?, bg?, controls? }` — update runtime config
- Security:
  - Validate `event.origin` against allowlist for inbound commands (default: any origin allowed; tighten per embed config)
  - Never expose session tokens or internal state via postMessage
- JS helper library:
  - `public/walk-embed-sdk.js` (from task 04) wraps all of this into a clean API: `avatar.on('position', cb)`, `avatar.goto(x, z)`, etc.
- Documentation:
  - `public/docs/walk-embed-api.html` — event reference, code examples for React, Vue, Vanilla JS
  - Interactive playground on the doc page: live iframe + code editor (CodeMirror) where devs can send commands and watch results

## Definition of Done
- All outbound events fire correctly (verified by `window.addEventListener('message', ...)` on a host page)
- All inbound commands execute within 100ms
- Security: foreign origin can send commands; test that session state is not leaked
- Doc page interactive playground works
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real events, real security, real docs with working interactive playground. Wire end-to-end.
