# Task: Screenshot-worthy share / OG image generation

Make every important page shareable: dynamic Open Graph images and in-app share
cards that look premium when posted to X/Discord/Telegram. Shareability = the
distribution flywheel for $three.

## Anchor files
- Existing share UI: `src/share-panel.js`, `src/share-panel-builders.js`. Screenshot: `src/components/screenshot-modal.js`. Badge/passport HTML: `public/agent-badge.html`, `public/agent-passport.html`.
- API: `api/` — add an OG image endpoint (e.g. `api/og/[type].js`) if none exists. Check `api/render/`, `api/embed/`, and existing `og-image.png` usage in `pages/home.html` first.
- Token data for dynamic stats: `api/three-token/[action].js?action=stats` (mint `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`).

## What to build
1. **Dynamic OG images** — generate per-entity OG images (agent profile, marketplace listing, $three token page, holder badge). Use a real image-generation path (e.g. `@vercel/og` / Satori if available, or a server-rendered canvas) — server-side, cached. Embed real data (agent name + avatar, live $three price/stats, holder rank).
2. **Correct meta tags** — each page sets `og:title`, `og:description`, `og:image` (pointing at the dynamic endpoint), and full `twitter:card` tags with real per-page content. Audit the core pages; `home.html` already has a baseline — extend the pattern.
3. **In-app share card** — a polished share action that produces a downloadable/shareable image (reuse `screenshot-modal.js` / `share-panel.js`) with a deep link back.
4. **Validate** — the generated images render correctly at 1200×630; test the cards in a link-preview validator mentally / via the endpoint directly.

## Constraints
- Real data baked into images — no placeholder names/prices.
- Cache generated images; don't regenerate per request unnecessarily.

## Definition of done
- `npm run dev`: hitting the OG endpoint returns a correct 1200×630 image with real data for each entity type; core pages emit correct meta tags; in-app share produces a real shareable image.
- Zero console errors. `npm run build` clean. Run the **completionist** subagent.
- Report: entity types covered, the generation method, and caching strategy.
