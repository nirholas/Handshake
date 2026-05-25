# Task 45 — Walk Shareable Links + Dynamic OG Image Generation

## Priority: HIGH

## Objective
Every `/walk?avatar=<id>` URL must generate a rich Open Graph preview image showing the actual avatar in a walk pose — so sharing on Twitter/X, iMessage, Slack, Discord, or Farcaster unfurls beautifully.

## Scope
- New Vercel function: `api/og/walk.js`
  - Accepts `?avatar=<id>&env=<name>` query params
  - Fetches the avatar's thumbnail from `/api/avatars/<id>/thumb`
  - Fetches environment preview from `public/environments/<name>/preview.jpg`
  - Composes an OG image (1200×630) using `@vercel/og` (Edge Function with ImageResponse):
    - Background: environment preview (blurred, 20% opacity)
    - Center: avatar thumbnail, standing pose, no background (PNG with transparency)
    - Bottom-left: "Walk with @<handle>" in Inter Bold, 48px white
    - Bottom-right: three.ws logo
  - Returns `Content-Type: image/png` with `Cache-Control: public, max-age=3600`
- Wire into `pages/walk.html` meta tags:
  ```html
  <meta property="og:image" content="https://three.ws/api/og/walk?avatar=<id>&env=<env>" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="https://three.ws/api/og/walk?avatar=<id>&env=<env>" />
  ```
  - Avatar ID and env are injected server-side (or as a redirect from the walk route that passes params)
- `/walk` route in `vercel.json` must return real HTML with populated meta tags (not client-rendered) — use a server-side render function if the existing route is client-rendered
- Short URLs: `https://three.ws/w/<avatarId>` → 302 to `/walk?avatar=<avatarId>` (new route in vercel.json)

## Definition of Done
- Share `https://three.ws/walk?avatar=<id>` in iMessage → avatar OG image unfurls
- Test with `npx og-preview "https://three.ws/walk?avatar=<id>"` or similar tool
- OG image is 1200×630, real avatar visible, real environment background
- Short URL `/w/<id>` redirects correctly
- No console errors, no meta-tags missing

## Rules
Complete 100%. No stubs. No fake data. Real OG generation with real avatar images. Wire end-to-end.
