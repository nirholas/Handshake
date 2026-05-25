# Task 46 — Walk Landing Page: Marketing & Feature Showcase

## Priority: HIGH

## Objective
Build a dedicated marketing page at `https://three.ws/walk` that showcases the walking avatar product to newcomers — with a live demo, feature highlights, Chrome extension CTA, and embed code. This becomes the primary shareable link for the walk feature.

## Scope
- New file: `pages/walk-landing.html` (served at `/walk` via vercel.json re-route; the actual walk app moves to `/walk/app`)
  - Alternatively: `/walk` serves a splash screen that auto-redirects to `/walk/app` after 4s or on any interaction
- Sections:
  1. **Hero** — headline "Your avatar walks anywhere on the web." + subheadline. Right side: live `/walk-embed?autoplay=true&controls=none&env=void` iframe with a featured avatar walking. Primary CTA "Try it now →" opens `/walk/app`. Secondary CTA "Get the extension →"
  2. **Demo strip** — three iframes side by side showing the avatar in three different environments (park, cyberpunk, gallery). Each is interactive (joystick, not just autoplay). Label: "Choose your world."
  3. **How it works** — 3-step illustrated steps: (1) Create your avatar (2) Walk on three.ws (3) Embed it anywhere. Each step has a live mini-demo iframe
  4. **Chrome Extension** — big CTA card: "Walk the entire web." Extension icon, feature bullet list, big "Add to Chrome" button (real Web Store URL), mock screenshot of avatar on google.com
  5. **Embed for developers** — code snippet with syntax highlighting, "Copy" button, live preview below
  6. **Leaderboard teaser** — top 3 walkers from the real leaderboard (task 39)
  7. **Social proof** — real tweets/casts about the feature (manually curated list in `data/walk-social.json`, fetched at build time)
  8. **Footer CTA** — "Start walking now"
- Performance: hero is above the fold and interactive within 3s on a 4G connection (LCP ≤ 2.5s)
- SEO: proper `<title>`, meta description, structured data (WebApplication schema)

## Definition of Done
- `/walk` shows the marketing page to unauthenticated visitors
- All iframe demos are live and interactive
- "Try it now" and "Add to Chrome" links work
- Leaderboard shows real data
- Social proof loaded from data file (no hardcoded names)
- Lighthouse score ≥ 90 on Performance and SEO
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real live demos, real leaderboard, real social proof data. Wire end-to-end.
