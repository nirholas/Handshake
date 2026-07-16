# 03 - Presentation: every 3D surface renders at the cinematic bar

Read `README.md` in this directory first (never-stop contract, standing approvals, shared
context). Never end a turn with a question. GCP spend is pre-approved; no new third-party APIs.

## Mission

A photoreal mesh shown in a flat-lit viewer still looks fake. The IRL camera view set the bar
on 07-15: ACES filmic tone mapping, rich key/fill/rim lighting, soft shadows, sharp textures.
Avatar-result viewers were partially aligned (commit 8cd1be411). This prompt finishes the
sweep: every place a model or avatar renders on the platform uses the same cinematic pipeline,
and every generated asset gets a presentation-quality thumbnail.

## Current state (verified 2026-07-16; re-verify)

- The bar: IRL view modules (find via `grep -rln "ACESFilmicToneMapping" src/`). Elements:
  `renderer.toneMapping = ACESFilmicToneMapping`, physically-correct lights, environment map,
  shadow-mapped key light, `outputColorSpace = SRGBColorSpace`.
- Known viewer surfaces (enumerate more from `STRUCTURE.md` and `grep -rln "new WebGLRenderer" src/ public/`):
  the main agent viewer, /forge result viewer, /avatar and pose studio, /scene Studio, /ar,
  /irl, /walk + /play worlds, marketplace cards, agent profile pages, the `<agent-3d>` embed
  (`apps-sdk/embodiment/embodiment-stage.js`), README-3D, Shopify tour embeds.
- Thumbnails: `forge_creations` records carry thumbnail URLs; memory rule: never synthesize
  thumbnail URLs, always render real ones.
- /walk exhausted WebGL contexts with 8 iframes once (memory 07-10): shared-context or
  frugal-context patterns matter on multi-viewer pages.
- A frame governor + Eco mode shipped for /play (07-14): respect it; cinematic must not cost
  battery on low-power mode.

## Tasks

1. **Inventory.** Every renderer creation site in `src/`, `public/`, `apps-sdk/`, plus each
   page that shows a GLB. Table: surface, current tone mapping, lighting rig, env map, shadows,
   pixel ratio handling. This inventory drives the rest and goes in the report.
2. **Extract the standard.** One shared module (e.g. `src/shared/cinematic-stage.js`, or extend
   the one 8cd1be411 used) exporting the canonical setup: tone mapping, color space, light rig,
   env, shadow config, and a `quality` knob (high / balanced / eco) that the frame governor and
   embed contexts can select. Small API, no framework.
3. **Adopt everywhere.** Convert every inventoried surface. Visual check each at 320/768/1440
   widths. Embeds (`<agent-3d>`, Shopify, README-3D) must default to balanced and honor an
   explicit quality attr.
4. **Thumbnails at the same bar.** The thumbnail/OG render path for generated assets renders
   with the same stage (lighting is most of why thumbnails look cheap). Regenerate thumbnails
   for the most-viewed existing assets (query `forge_creations` by views/downloads; backfill
   cron pattern already exists in the avatar-thumbnail work, see `api/cron/`).
5. **AR parity.** iOS Quick Look uses baked USDZ (animated bake shipped 07-16 in 8b23b8d9e);
   confirm the bake inherits texture quality (no downscale below 2048 for high-tier assets) and
   the WebXR path uses the shared stage.
6. **Ship.** Deploy from a clean worktree, verify on production URLs on desktop + a phone
   viewport, commit + changelog ("every 3D view on the platform now renders with cinematic
   lighting").

## Guardrails

- No per-frame allocations in render loops; the stage must not regress the /play frame
  governor or Eco mode.
- Multi-viewer pages (/walk grid, marketplace) must not exceed ~4 live WebGL contexts; use
  poster images + lazy context creation where the inventory shows more.
- `public/*.html` pages not registered as Vite inputs ship raw `/src` (vite-raw-src trap,
  memory 07-10): if you add a page or module, register it in `vite.config.js` inputs.
- Never hand-edit generated bundles; `npx vercel build` overwriting `api/*.js` is a known trap.

## Acceptance criteria

- [ ] Inventory table in the report; every surface converted or explicitly justified.
- [ ] Same model screenshotted before/after on >= 6 surfaces (forge, avatar studio, marketplace card, agent profile, embed, IRL) showing the uplift.
- [ ] Thumbnails regenerate through the cinematic stage; top-viewed assets backfilled (count in report).
- [ ] No new console errors; frame rate on /play and /walk unchanged (measure with the existing governor stats).
- [ ] Committed with changelog + docs; `npm test` green.
