# Task 12: the Commons collapses to ~1fps once the full fleet loads

**Status:** open. Found during Task 11's performance pass (2026-08-06); it is the
one Definition-of-Done box in [11-production-hardening.md](11-production-hardening.md)
that could NOT be verified, so it is carved out here rather than quietly passed.

## The symptom

`/agora` holds a solid 60fps while its citizen avatars stream in, then falls off
a cliff and never recovers. Measured against the Vite dev server with Playwright,
counting real `requestAnimationFrame` callbacks in 10-second buckets:

```
frames per 10s: 597, 600, 600, 599, 596, 20, 12, 13, 6, 7, 5, 4, 4, 9, 5, 7, 3
fps:           59.7, 60.0, 60.0, 59.9, 59.6, 2.0, 1.2, 1.3, 0.6, 0.7, 0.5, ...
```

The cliff lands at ~50s, which is exactly when the avatar loader finishes: the
world requests 200 citizens (`src/agora/agora-world.js`, `loadCitizens`) and
`CitizenPopulation` streams them in `MAX_CONCURRENT_LOADS = 4` at a time
(`src/agora/citizen-avatar.js`). Steady-state frame cost is **~900-1400ms**.

## What changed since the measurement

The load path the numbers above describe no longer exists, so the ~50s cliff
timing has to be re-measured before anything is concluded from it. Since
2026-08-16 every citizen stands up on the shared default rig first (one small
GLB for the whole crowd) and only the most recently active `MAX_PERSONAL_AVATARS`
(24 on desktop, 8 on a coarse pointer) upgrade to their own model
(`src/agora/citizen-avatar.js`, `_wearOwnAvatar`); the crowd is placed ten
citizens per frame and the citizens request is prefetched in parallel with the
map (`src/agora/agora-world.js`). The full 200 are therefore standing in
seconds rather than minutes, which moves the cliff earlier, and the per-frame
cost this task is about is unchanged: `CitizenPopulation.update` still runs
`mixer.update(dt)` for every instance every frame, so the suspected per-object
cost below applies to 200 skinned meshes exactly as before.

## What was ruled out

| Hypothesis | Evidence against |
|---|---|
| JS heap leak | Heap flat at 48.1 MB over 90s (forced GC before each sample). |
| Fill-rate / rasterization | Shrinking the viewport 1280x800 → 120x90 (1% of the pixels) left fps unchanged (0.7 → 0.8). Not pixel-bound. |
| A hot JS function | CPU profile attributes only ~4% of samples to JS. The named frames (`applyBoneTransform`, `getVertexPosition`, `fromBufferAttribute`) come from `Box3.setFromObject(obj, true)` in `scaleToHeight`/`groundFeet`, which run **once per avatar at load**, not per frame. |

## What the evidence points to

92.7% of profile samples land in native `(program)` time, and `texSubImage2D`
appears in the profile. That is the per-object cost of ~200 `SkinnedMesh`
avatars: every frame each one updates an `AnimationMixer`, recomputes its
skeleton's bone matrices, and uploads a bone texture, then issues its own draw
call. `CitizenPopulation.update` updates all of them unconditionally:

```js
for (const inst of this.instances) {
    this._advanceMotion(inst, dt);
    if (!this.reducedMotion) inst.mixer?.update(dt);   // all ~200, every frame
    ...
}
```

**Caveat, stated plainly:** the test browser is headless Chromium on
`ANGLE (SwiftShader driver)`, a software rasterizer. Per-object driver overhead
(bone-texture uploads, draw calls) is dramatically more expensive there than on
real GPU hardware. The viewport test proves the cost is per-object rather than
per-pixel, but it does **not** prove a real GPU would also stall. The honest
position is that the real-device number is **unknown** and must be measured on
hardware before `/agora` can claim "60fps with a busy board and a fleet".

## The work

1. **Measure on real hardware first.** Load `/agora` on a real GPU (desktop
   Chrome, then a mid-range phone) with the full fleet and record fps. If it
   holds 60, this becomes a low-end-device budget question rather than a bug.
2. **Budget the animated fleet regardless.** 200 individually-animated skinned
   meshes is not a budget any low-end device will meet. Update mixers only for
   avatars that are on-screen and near the camera, and idle the rest. The world
   already tracks positions and has a camera focus to measure against.
3. **Consider a render cap distinct from the fetch cap.** `loadCitizens` already
   surfaces an honest "more citizens exist than are shown" message when it hits
   200; the same honesty can cover a lower *animated* cap.
4. Re-run the Task 11 measurement and record the numbers here.

## Reproduce

```js
// tests/e2e/, then: npx playwright test <file> --retries=0
await page.goto('/agora'); await page.waitForTimeout(8_000);
await page.evaluate(() => { window.__b = []; let n = 0;
  setInterval(() => { window.__b.push(n); n = 0; }, 10_000);
  (function l() { n++; requestAnimationFrame(l); })(); });
await page.waitForTimeout(90_000);
console.log(await page.evaluate(() => window.__b));
```

## Guardrails

Same as every Agora task: `$THREE` only, real data, no mocks in app code, stage
explicit paths, push to `threews` only.
