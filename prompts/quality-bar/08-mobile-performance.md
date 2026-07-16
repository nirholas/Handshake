# 08: Mobile experience and asset performance

Read `prompts/quality-bar/_shared.md` first. Its operating clause applies: finish 100%, never ask.

## Mission

A crypto-native audience lives on phones. Make the platform genuinely excellent on a mid-tier
phone: fast first paint, smooth 3D, no WebGL exhaustion, small GLB payloads, thumb-friendly
controls.

## Tasks

1. **Baseline.** Lighthouse (mobile preset, throttled) on the top 15 pages: home, forge,
   markets, news, agents/marketplace, a coin page, dashboard, walk, irl, ar, play, launches,
   changelog, docs start, an agent profile. Record LCP/CLS/TBT/transfer size. These numbers
   anchor the report.
2. **GLB delivery pipeline.** Add a compression pass where models are served: Draco or
   meshopt mesh compression + KTX2 texture compression via `@gltf-transform` (dependency-check
   first per open-source-first rule). Serve compressed by default with full-res on the
   download action (pairs with prompt 04 tiering). Target: typical forge output under 8MB over
   the wire without visible quality loss. Verify decode support on iOS Safari WebGL and
   Android Chrome before defaulting on; feature-detect and fall back to uncompressed.
3. **WebGL context discipline.** Enforce the one-visible-viewer rule sitewide (prompt 05 task 4
   ships the mechanism; you verify it on real mobile viewports and fix stragglers). Pages with
   model grids use static thumbnails that upgrade to live 3D on tap.
4. **Input ergonomics.** Touch targets 44px minimum, viewer gestures (orbit/pinch) not
   fighting page scroll (use proper touch-action CSS), bottom-reachable primary actions on
   generation flows, safe-area insets respected.
5. **Network resilience.** Generations survive tab backgrounding and flaky mobile networks:
   poll with backoff and resume, never lose a finished result because the socket dropped.
   Test by throttling to Slow 3G mid-generation.
6. **Re-measure.** Same Lighthouse matrix after. Publish the wins honestly (only real numbers)
   in the changelog entry.

## Definition of done

- Before/after Lighthouse matrix in the report; every top-15 page improved or explained.
- Compressed GLB path proven on iOS Safari + Android Chrome (real device lab not available:
  use Playwright WebKit + Chrome mobile emulation and note the caveat).
- No page can exceed 2 live WebGL contexts; grid pages tap-to-activate.
- Changelog entry; docs updated where the embed/SDK behavior changed.

## Anticipated blockers, pre-answered

- `@gltf-transform` version conflicts with the three.js in the tree: pin the CLI as a
  devDependency and run it in scripts (build-time), keeping runtime untouched.
- KTX2 on old devices: the KTX2Loader transcoder needs its wasm assets served locally; copy
  them into static assets (never CDN hotlink), and fall back to png/jpg textures on decode
  failure.
- Where GLBs are stored on R2: the compression pass runs at upload/finalize time in the
  worker/API path that writes R2 (`api/_lib/r2.js` callers), not as a bulk rewrite; optionally
  add a lazy migrate-on-first-serve for old assets.
