# Task: Performance pass — bundle, 3D, and runtime jank

Make three.ws feel instant. Target: fast first paint, lazy-loaded 3D, no main-
thread jank, good Lighthouse scores (`.lighthouserc.json` defines the budget).

## Scope
`vite.config.js` (build/rollup config), `src/viewer.js` and the Three.js modules,
the home hero (`src/home-v4-hero.js`, `src/home-v4-scroll.js`, `src/home-act2-viewer.js`),
and any route that imports Three.js eagerly.

## Method
1. **Measure first.** `npm run build`, inspect the rollup output for the largest chunks. Run Lighthouse against `npm run dev` for `/` and `/marketplace`. Record baseline numbers.
2. **Code-split heavy modules.** Three.js, GLTF loaders, draco/ktx2 decoders, and the club/walk scenes should be dynamically `import()`-ed only when their view is active — never in the initial home bundle.
3. **Lazy-load 3D assets.** Defer GLB loads until the canvas is in view (IntersectionObserver). Show a skeleton/poster until ready.
4. **Kill jank.** Debounce resize/scroll/input handlers. Use `transform`/`opacity` for animation (not layout-triggering props). Add `will-change` only where it pays. Cap devicePixelRatio on the renderer for high-DPI phones.
5. **Trim the critical path.** Preconnect fonts (already partially done in `home.html`), defer non-critical scripts, remove unused imports (`npx knip`).

## Constraints
- No visual regressions — the page must look identical or better.
- No fake/skeleton-only "perf" — the underlying load must actually be deferred.

## Definition of done
- Largest initial chunk meaningfully smaller; Three.js no longer in the home critical bundle.
- Lighthouse performance improved vs baseline (report both numbers); within `.lighthouserc.json` budgets where possible.
- 60fps scroll on the home hero; no long tasks > 50ms during load on a mid-tier profile.
- `npm run dev` + `npm run build` both clean. Run the **completionist** subagent.
- Report: baseline vs after metrics, and what changed.
