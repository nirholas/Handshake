# Audit 3: /play performance (load weight, frame rate, memory)

The world must load fast on event wifi and hold 60fps on a mid-range laptop. Measure first, then fix the biggest numbers, then measure again.

## Where the weight lives

- Main world: `src/game/coincommunities.js` (5k+ lines; check what it imports eagerly vs lazily)
- Population and props: `src/game/ambient-crowd.js`, `src/game/world-objects.js`, `src/game/terrain.js`, `src/game/build-voxels.js`, `src/game/static-batch.js`
- Shaders and environment: `src/game/water-shader.js`, `src/game/day-night.js`, `src/game/world-env.js`
- Avatar pipeline: `src/game/boot-avatar.js`, `src/glb-canonicalize.js`, `src/animation-retarget.js`

## What to measure (before touching anything)

1. **Network.** With devtools on the canonical $THREE URL (see `docs/event-readiness/README.md`): total transferred bytes to interactive, largest individual assets, any asset fetched more than once. `scripts/play-mobile-repro.mjs` (chromium engine) prints transfer totals and attributes duplicate GLB/clip fetches to their call stacks.
2. **Frame rate.** Performance panel recording of 30s of walking through the busiest area. Note long tasks, GC spikes, and the main-loop cost breakdown.
3. **Memory.** Heap snapshot after 5 minutes idle in the world. Growth means a leak (event listeners, geometries/materials not disposed on despawn, chat log unbounded).

## Fix priorities (biggest wins first)

1. **Duplicate fetches.** Same GLB or animation clip loaded twice is pure waste; cache at the loader.
2. **Eager imports that should be lazy.** Wheel UI, cosmetics shop, voice chat, intel kiosk: anything not needed for first paint should be a dynamic `import()` triggered on approach or click.
3. **Draw calls.** Instance repeated props (trees, rocks, crowd members). Merge static geometry per zone.
4. **Texture budget.** Downsize anything over 1024px that never fills the screen; KTX2/basis if the pipeline supports it, otherwise plain resizing is fine.
5. **Per-frame allocation.** No `new Vector3()` in the render loop; reuse scratch objects.
6. **Disposal.** Everything despawned (crowd, projectiles, dropped items) must dispose geometry, material, and textures.

## Verify

- Re-run the same three measurements; the report includes before/after numbers for transfer size, worst frame time, and 5-minute heap growth.
- No visual regressions: walk the full map once after changes.
- `npm test` stays green.

## Report format

Numbers table (before/after), each fix in one line, anything intentionally skipped with the measured cost that made it not worth it.
