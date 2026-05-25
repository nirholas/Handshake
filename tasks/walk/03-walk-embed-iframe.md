# Task 03 — Walk Embed: Iframe-Ready Walking Avatar

## Priority: URGENT

## Objective
Create a dedicated embeddable walk page at `/walk-embed` (new file `pages/walk-embed.html`) that is stripped of all navigation, footer, and chrome — just the Three.js canvas, the joystick, and the avatar. This page must be safe to embed in any `<iframe>` on any origin.

## Scope
- New file: `pages/walk-embed.html` + `src/walk-embed.js`
- Route: add `/walk-embed` to `vercel.json` routes
- Accepts `?avatar=<uuid>` — loads that avatar via real API
- Accepts `?bg=<hex>` — sets canvas background color (default transparent/black)
- Accepts `?controls=joystick|keyboard|none` — enables appropriate controls
- Accepts `?autoplay=true` — avatar walks forward on load without user input
- No nav, no footer, no login prompts
- Sets `frame-ancestors *` in response headers (or ensure vercel.json doesn't block iframes)
- Communicates with parent window via `postMessage`: emits `{ type: 'walk:ready' }` when loaded, `{ type: 'walk:position', x, z }` on each position update

## Definition of Done
- `<iframe src="https://three.ws/walk-embed?avatar=<id>">` embeds cleanly on a blank HTML page
- Avatar loads and walks with joystick on mobile, WASD on desktop
- postMessage events verified in browser console of the parent page
- No X-Frame-Options or CSP blocking the embed

## Rules
Complete 100%. No stubs. No fake data. Wire every step end-to-end and verify in a real browser with the dev server running.
