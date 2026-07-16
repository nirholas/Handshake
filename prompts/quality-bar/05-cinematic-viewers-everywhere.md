# 05: Cinematic rendering in every viewer

Read `prompts/quality-bar/_shared.md` first. Its operating clause applies: finish 100%, never ask.

## Mission

The same GLB can look like a phone snapshot or a film still depending on the viewer. Bring
every 3D surface on the platform to one cinematic rendering bar: ACES tone mapping, real HDRI
image-based lighting, soft contact shadows, correct color management, and tasteful defaults.
The IRL pins and forge/avatar result viewers reached this bar (07-15/07-16, commits df8f7656
and 8cd1be411); the job is to find every OTHER viewer and bring it up.

## Tasks

1. **Inventory every viewer.** Grep for `WebGLRenderer` and `<model-viewer` and the platform's
   own viewer modules across `src/`, `public/`, `pages/`, `packages/`, `sdk/`. Known surfaces:
   /forge result, /ar, /irl, agent profile cards, marketplace/catalog tiles, /walk, /world,
   /play, scene studio, diorama, coin 3D views, embed widget (`<agent-3d>`), readme-3d,
   Shopify tour packages, viewer link pages MCP tools return. Build the full list with
   file:line; that list is a deliverable.
2. **Extract one shared rendering-quality module** (if the 07-15 work did not already create
   one): tone mapping ACESFilmic, `outputColorSpace = SRGBColorSpace`, physically correct
   lights, default HDRI environment set (small curated set: studio / outdoor / sunset, served
   from our static assets, NOT a third-party CDN), ground contact shadow, and a quality tier
   switch (mobile drops to cheaper env + no shadows). Apply it to every viewer in the
   inventory. Match existing code conventions; do not fork per-page copies.
3. **Camera and framing defaults.** Auto-frame the model (bounding-box fit with a 3/4 hero
   angle), gentle idle orbit or breathing motion where appropriate, dolly limits so users
   cannot clip inside meshes. Thumbnails/screenshots the platform bakes (agent previews,
   og-images) must use the same pipeline so cards look as good as live views.
4. **Performance guardrails.** The /walk page taught us 8 concurrent WebGL contexts kill
   phones: viewers below the fold must lazy-init on intersection, pause rendering when
   offscreen (`document.visibilityState` + IntersectionObserver), and cap pixel ratio at 2.
   Frame-governor/Eco patterns exist from the /play heat fix (8b23b8d9e); reuse them.
5. **Verify.** `npm run audit:web` full sweep: zero new console errors, and re-check any WebGL
   error serially (crawler concurrency fakes them). Screenshot the same benchmark GLB in every
   surface before/after; a room of senior engineers should not be able to tell which viewer a
   screenshot came from.

## Definition of done

- Inventory list with per-surface status shipped in the report.
- Shared module applied everywhere; per-surface screenshots attached.
- Mobile (320px, mid-tier phone throttling in devtools) stays smooth; no page exceeds 2
  simultaneously rendering contexts.
- Changelog entry ("every 3D view on the site now renders film-quality"); embed/SDK packages
  that gained the upgrade get a patch version note in their package README (publishing to npm
  stays owner-gated; prepare, do not publish).

## Anticipated blockers, pre-answered

- HDRI sourcing: use CC0 assets (Poly Haven) downloaded INTO the repo/static bucket at build
  time, compressed to `.hdr`/`.exr` small sizes or prefiltered PMREM `.ktx2`; never hotlink.
- A surface with its own bespoke renderer (play/world use different stacks): match the bar
  with that stack's equivalents rather than forcing three.js defaults; if truly impossible,
  document the gap and move on.
- og-image baking uses a headless browser already (see brand og-image refresh c70b004e8);
  reuse that harness for thumbnail parity.
