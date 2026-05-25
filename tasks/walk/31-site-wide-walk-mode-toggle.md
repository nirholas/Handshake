# Task 31 — Site-Wide Walk Mode: Persistent Companion Across three.ws Pages

## Priority: URGENT

## Objective
Build a "Walk Mode" toggle that, when enabled, makes the user's avatar walk along with them as they navigate `three.ws` itself — across every page on the site. The avatar persists across SPA-style navigations, follows the user's mouse/scroll, and serves as a tour guide.

## Scope
- New module: `src/walk-companion.js` — loaded globally on every three.ws page (add to the base layout / global JS bundle entry)
- Toggle: `?walk=1` URL param, plus a persistent button in the global nav (`public/nav.html` + `public/nav.js`) — state persisted in `localStorage` as `walk:companion:enabled`
- When enabled:
  - Inject a fixed-position 200×280 canvas in bottom-right (same z-index strategy as Chrome extension content script, task 06)
  - Loads the user's primary avatar (or `?avatar=` override)
  - Avatar idles by default; walks toward the user's cursor when the cursor moves
  - On page navigation (link click): avatar plays `wave` gesture briefly, then the companion canvas survives navigation by being attached to a persistent host outside the page's main content (a root-level container injected once on `DOMContentLoaded`)
- Cross-page persistence approach: since three.ws is multi-page (not SPA), use one of:
  - Option A (preferred): use a Service Worker to serve a persistent shell; avatar lives in the shell
  - Option B (fallback): use `localStorage` to record avatar state (position, rotation, anim) on `beforeunload` and restore on next page load — avatar appears to teleport but resumes seamlessly
- Avatar reacts to page context:
  - On `/pricing` → walks to and points at the recommended tier
  - On `/features` → walks to the most-viewed feature card
  - On agent detail page → walks to and waves at the agent's name
- Disable button on the companion: clicking removes companion for the session

## Definition of Done
- Toggle walk mode → avatar appears on every page navigation
- State (position/animation) persists across page loads
- Page-context behaviors fire on pricing, features, agent detail
- Disable button removes companion and respects choice for the rest of the session
- No console errors
- No layout breakage on any page

## Rules
Complete 100%. No stubs. No fake data. Real persistence (SW or localStorage), real avatar, real context-awareness. Wire end-to-end across the whole site.
