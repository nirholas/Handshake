# Task 44 — Walk Embed: Dedicated Snippet Generator Page

## Priority: HIGH

## Objective
Build a standalone, shareable snippet generator at `https://three.ws/embed/walk` — a visual configurator that produces the correct embed code for any combination of options. This page is the primary onboarding for developers who want to embed a walking avatar.

## Scope
- New file: `pages/embed-walk.html`, `src/embed-walk.js`
- Add route to `vercel.json`: `/embed/walk` → `pages/embed-walk.html`
- Layout (two-panel, responsive):
  - Left panel — configuration form:
    - Avatar picker: type an avatar ID or pick from "Featured" API — renders thumbnail
    - Controls: joystick | keyboard | none | auto (detects device)
    - Environment: dropdown (environments from task 18)
    - Background: transparent | color picker | none
    - Size: presets (S 200×280 / M 320×480 / L 480×720) + custom W/H
    - Autoplay: on/off
    - Narration: on/off (uses TTS narrator from task 09)
    - Walk speed: slider
    - Embed type: iframe | JS SDK
  - Right panel — live preview:
    - Real live iframe (or SDK-injected) updates instantly on every config change
    - "Copy snippet" button — native clipboard API, shows "Copied!" feedback
    - "Preview in new tab" link
    - Framework-specific tabs showing the same snippet formatted for vanilla HTML, React, Vue, and Svelte
- Framework snippets:
  - React: `<WalkEmbed avatarId="..." controls="joystick" />` — with a note to `npm i @threews/react`
  - Vue: `<WalkEmbed avatar-id="..." />` — same note
  - Svelte: same
  - These are just well-formatted snippet text — no actual package needs to be published for this task, just show the expected API
- URL state: all config options serialize to query params so the page is shareable/linkable

## Definition of Done
- Open `/embed/walk` → all controls present, live preview works
- Change any option → preview updates within 200ms
- Copy button copies correct snippet to clipboard
- URL updates reflect config (deep-link works)
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real live preview, real clipboard. Wire end-to-end.
