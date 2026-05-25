# Task 49 — Walk Documentation: Full Developer & User Docs

## Priority: MEDIUM

## Objective
Write and publish complete documentation for the entire walking avatar system — user guides, developer integration docs, API reference, and the Chrome extension guide — all at `https://three.ws/docs/walk`.

## Scope
- New files under `public/docs/walk/`:
  - `index.html` — overview + navigation sidebar
  - `getting-started.html` — "Walk your first avatar in 5 minutes"
  - `walk-page.html` — controls, camera modes, environments, multiplayer, AR
  - `embed-iframe.html` — iframe embed guide with live preview
  - `embed-sdk.html` — JS SDK reference (`window.ThreeWalkAvatar` API)
  - `postmessage-events.html` — full event spec (task 48)
  - `rest-api.html` — programmatic control API (task 47)
  - `chrome-extension.html` — install, configure, site list, TTS narration
  - `companion-mode.html` — site-wide walk mode on three.ws
  - `analytics.html` — embedding analytics dashboard
  - `changelog.html` — version history with real dates and feature descriptions

- Each page:
  - Sidebar with active state tracking (highlight current page)
  - Code examples with syntax highlighting (Prism.js, vendored)
  - Copy button on every code block
  - Where applicable: embedded live demo (real iframe, not screenshot)
  - "Edit this page" link pointing to the real GitHub file (for open PRs)

- Route `vercel.json`: `/docs/walk/*` → `public/docs/walk/$1.html`
- Docs are indexed in `llms.txt` and `llms-full.txt` (already used by the repo for AI discoverability)

## Definition of Done
- All 11 pages exist and are complete (no "coming soon" sections)
- Every code example is real, tested, copy-pasteable
- Live demos on embed pages work
- `/docs/walk` returns 200, sidebar navigation works
- llms.txt updated to include walk docs
- No console errors

## Rules
Complete 100%. No stubs. No "coming soon". Every example must be real and tested. Wire end-to-end.
