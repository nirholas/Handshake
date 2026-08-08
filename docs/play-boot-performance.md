# Why `/play` opens fast, and how to keep it that way

`/play` is the heaviest page on three.ws. Opening a coin world means booting a WebGL renderer, a WASM physics solver, a procedurally generated city, a skinned avatar, a Colyseus room, an economy HUD, and a crowd of NPCs, all from a cold cache when someone clicks a shared link.

That work is unavoidable. What *is* avoidable is paying for it at the wrong moment. This document records the boot-cost invariants that keep the first ten seconds fast, so a future change does not quietly undo one of them. Each section names the regression it prevents, because each of them actually shipped once and was measured on the live site.

Related docs: [how /play stays safe, honest, and light](./play-hardening.md), [architecture](./architecture.md).

## How to measure before you claim anything

Boot cost is not something to reason about from the source. Load the real page in a real browser and read the numbers:

```js
// Paste into DevTools on https://three.ws/play?coin=<mint>
new PerformanceObserver((l) => l.getEntries().forEach((e) =>
  console.log('longtask', Math.round(e.startTime), Math.round(e.duration))))
  .observe({ entryTypes: ['longtask'] });

performance.getEntriesByType('resource')
  .map((r) => ({ url: r.name, kb: Math.round((r.transferSize || 0) / 1024), start: Math.round(r.startTime) }))
  .sort((a, b) => b.kb - a.kb).slice(0, 20);
```

Two numbers matter and they fail independently:

- **Bytes on the critical path.** Anything a `<script type="module">` reaches through *static* imports is fetched and parsed before the page can run, whether the user needs it in the first second or not.
- **Work landing on one frame.** three.js compiles a material's GPU program the first time it draws it, so geometry added in a burst compiles in a burst, on whichever single frame happens to come next.

---

## 1. The physics runtime is never a static import

**Invariant: `@dimforge/rapier3d-compat` is reached only through the dynamic `import()` inside `initRapier()` in [src/physics/physics-world.js](../src/physics/physics-world.js).**

The `-compat` build of Rapier base64s its WebAssembly binary into its JavaScript. That is what makes it convenient (no decoder file to host) and what makes it dangerous to import carelessly: Rollup folds a statically imported module into the chunk that imports it, so a single top-level `import RAPIER from '@dimforge/rapier3d-compat'` put **2.27 MB of parsed JavaScript, 774 KB over the wire**, into the shared chunk that `/play` and `/walk` both modulepreload. The browser paid a multi-second parse before the first frame, for a solver nothing needs until the world is already standing.

Nothing about the physics boot was ever synchronous. `PhysicsWorld.create()` is awaited, and both scenes document a direct-mutation movement fallback for the frames before the WASM lands. The static import bought nothing and cost the entire critical path.

**If you add a physics-using scene, import `PhysicsWorld` freely. Do not import the Rapier package itself anywhere.**

## 2. World entry is the busiest moment, so nothing decorative joins it

**Invariant: work that is not the player's own world waits for the world to settle.**

The ambient crowd in [src/game/ambient-crowd.js](../src/game/ambient-crowd.js) is scenery: wandering avatars so a quiet world does not read as an empty room. It used to fetch the public avatar gallery at module load (measured at 4.6s into a cold boot, before the world existed) and build its wanderers the instant the world opened, each one a multi-megabyte GLB download plus a skeleton retarget.

That landed on top of the physics boot, the district build, the player's own avatar, and the room join. Now the crowd waits `SETTLE_MS` of actual world time before it fetches anything or builds anyone.

**Scenery must never compete with the thing it decorates.** If you add ambient life, NPCs, or background content to a world, gate it behind the same settle window.

## 3. Shader programs compile before the frame that draws them

**Invariant: a burst of scene additions during entry is followed by `_warmShaders()` in [src/game/coincommunities.js](../src/game/coincommunities.js).**

`enter()` adds the biome, the district grid, the coin totem, the jumbotron, the chart screen, and the oracle ribbon inside one synchronous task, then the player's skinned avatar inside another. No frame renders mid-task, so *the very next frame after each burst* had to compile and link every one of those programs at once: one multi-hundred-millisecond stall, on the exact frame the player first looks at the world.

That is the signature users describe as "slow at first, then it stabilizes" -- compiled programs are cached for the rest of the session, so the stall never recurs and the world feels fine forever after.

`_warmShaders()` runs `renderer.compileAsync()`, which uses `KHR_parallel_shader_compile` where the driver supports it so linking happens off the main thread. Rendering is suspended for its duration (the canvas holds its last frame) so a `requestAnimationFrame` tick cannot slip in and force the synchronous compile the warm-up exists to avoid. The suspension is capped by `WARM_TIMEOUT_MS`, so a driver that never reports completion degrades to the old behaviour rather than freezing the canvas.

**If you add a batch of meshes to world entry, add them before an existing warm pass, not after it.**

## 4. The scene is lit on its first frame, never after a download

**Invariant: [`loadEnvironment()`](../src/shared/cinematic-render.js) installs the procedural `RoomEnvironment` synchronously, and only then upgrades to an HDRI.**

The curated HDRIs are 1-2 MB files (`/hdri/outdoor.hdr` is 1.4 MB). A scene that waited for one rendered its metals and roughness response unlit until the download and PMREM convolution finished, then popped to full lighting all at once. `RoomEnvironment` is convolved from a handful of emissive boxes and costs about a millisecond, so it now lights every scene immediately and the HDRI refines an already correct image.

This applies to all 20+ callers, not just `/play`. The HDRI path also drops its interim render target and disposes the `PMREMGenerator` scratch, and it declines to overwrite `scene.environment` if another call re-pointed it while the file was in flight.

## 5. One asset is decoded once

**Invariant: shared artwork goes through a memoized loader, not a fresh `TextureLoader` per surface.**

The coin's artwork appears on the totem's two faces and on the jumbotron panel. Each surface used to run its own `TextureLoader` against the same URL. The HTTP cache deduped the *download*, which made this look free, but the browser still decoded the image twice and three.js still uploaded two independent textures. Token art routinely runs past half a megabyte (the flagship `$THREE` image is 567 KB) and that second decode landed inside world entry.

`_loadCoinArt()` memoizes the promise per URL for the life of the world and drops it in `leave()`, so the next coin loads its own art and this one's texture is freed with the meshes that carry it.

## 6. The render-tier watchdog does not judge a world that is still assembling

**Invariant: `_loop()` gives the frame watchdog `WATCHDOG_GRACE_MS` after a world becomes playable.**

[src/club-perf.js](../src/club-perf.js) steps the render tier down after two sustained slow seconds and only climbs back after six sustained fast ones. World entry keeps working after the player takes control: agent desks arrive over the network, the NPC crowd builds, the HDRI upgrade convolves. Judged live, that burst downgraded the pixel ratio of machines that had no trouble drawing the world at all, and the asymmetric recovery window meant the player spent their first ten seconds looking at a needlessly soft image.

Frames during entry are slow because the world is still assembling, not because the device cannot draw it. The grace period is not a way to hide a real performance problem; it is a refusal to draw a conclusion from unrepresentative data.

---

## Verifying a change

Before shipping anything that touches `/play` boot:

1. `npm run dev`, open `/play?coin=<mint>` with an empty cache, and confirm no long task over ~500ms after `domcontentloaded`.
2. Check the network panel: nothing over 100 KB should be fetched that the first visible frame does not need.
3. Confirm no new static import pulls a WASM-bearing or multi-megabyte package into a shared chunk. `npx vite build` and look at the emitted chunk sizes.
4. `npm test`.
