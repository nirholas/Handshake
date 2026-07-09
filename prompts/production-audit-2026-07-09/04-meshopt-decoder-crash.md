# 04 — Wire the Meshopt decoder on the 7 pages that crash loading it

## Mission

`THREE.GLTFLoader: setMeshoptDecoder must be called before loading compressed files` is thrown
on 7 pages: `/cosmos`, `/minted`, `/creations`, `/vault`, `/agenc/embodied`, `/pitch`,
`/lipsync/mic`. Every server-baked avatar (the `/api/avatars/<id>/glb` lane and Forge output)
emits `EXT_meshopt_compression`; any viewer that doesn't register a Meshopt decoder before its
first load throws instead of rendering. **The fix already exists and is already used correctly
on ~25 other pages** (`pages/forge.html`, `pages/marketplace.html`, `pages/home.html`, etc. all
include it) — this is a "these 7 pages shipped without it" gap, not a missing capability.

## Context — three distinct call patterns exist in this codebase; match the right one per page

1. **`<model-viewer>` custom element, static script tag** — the common case. The shared fix is
   `public/model-viewer-meshopt.js`: a classic (non-module) script that sets
   `model-viewer`'s static `meshoptDecoderLocation` the instant the element is defined, racing
   and winning against an eager `<model-viewer>` that starts loading in the same microtask.
   Read its header comment in full — timing is the entire point of the file (a deferred module
   that runs after model-viewer's own module script loses the race).
   **Fix:** add `<script src="/model-viewer-meshopt.js"></script>` to the page, anywhere in the
   document — it works as a classic parser-executed script regardless of position because
   `model-viewer.min.js` is always loaded as `type="module"` (deferred), so a classic script
   anywhere in the HTML runs first. Copy the exact pattern from `pages/forge.html` (search it
   for `model-viewer-meshopt.js`).
   **Applies to:** `pages/cosmos.html`, `pages/minted.html`, `pages/creations.html`,
   `pages/vault.html`, `pages/pitch.html` — confirm each currently loads `<model-viewer>` via
   `https://ajax.googleapis.com/ajax/libs/model-viewer/...` or similar and is currently missing
   the meshopt include (grep each file for `model-viewer-meshopt` to confirm the gap before
   editing).

2. **`<model-viewer>` loaded dynamically at runtime by a shared embed module.**
   `/agenc/embodied` renders via `<three-ws-agent>`, a custom element defined in
   `public/agenc/embed.js`. That file's `ensureModelViewer()` injects the model-viewer CDN
   script (`https://cdn.jsdelivr.net/npm/@google/model-viewer@.../model-viewer.min.js`) into
   `document.head` on first connect — there is no static `<script>` tag in `embodied.html` to
   attach a sibling classic script next to, and `embed.js` is also the public embed snippet
   third parties paste onto their own sites (see the file's own usage doc comment), so a page's
   own preemptive workaround wouldn't help those. **Fix inside `ensureModelViewer()` itself:**
   apply the same `meshoptDecoderLocation` assignment (and the same `customElements.define()`
   interception, since the CDN script is injected async and may still race an already-connected
   `<three-ws-agent>` element) directly in `public/agenc/embed.js`, so every consumer of
   `<three-ws-agent>` — the `/agenc/embodied` page and any third-party embedder — gets it for
   free with no per-page include needed. Reuse `public/model-viewer-meshopt.js`'s logic rather
   than reimplementing it differently; consider having `embed.js` load that file, or inlining
   the same three-step (synchronous / define-intercept / whenDefined-fallback) pattern directly.

3. **Raw `THREE.GLTFLoader` in an inline module script — no `<model-viewer>` at all.**
   `/lipsync/mic` (`public/demos/lipsync-mic.html`) imports `GLTFLoader` directly from
   `three/addons/loaders/GLTFLoader.js` and calls `new GLTFLoader()` (search the file for
   `const loader = new GLTFLoader()`). This needs the *other* existing pattern used elsewhere in
   the codebase for raw-loader consumers: `loader.setMeshoptDecoder(decoder)` with a decoder
   sourced the same way `walk-sdk/src/internal/meshopt.js` (`getMeshoptDecoder()`) or
   `page-agent-sdk/src/stage.js` already do — a lazy dynamic
   `import('three/addons/libs/meshopt_decoder.module.js')` resolving `MeshoptDecoder`, called
   once before `loader.loadAsync(...)`. Wire it the same way `apps-sdk/embodiment/embodiment-stage.js`
   does (`getDecoders()` → `loader.setMeshoptDecoder(meshoptDecoder)`), scoped to what
   `lipsync-mic.html`'s inline script actually needs (it likely only needs Meshopt, not
   Draco/KTX2 — check what GLBs `/lipsync/mic` actually loads before adding decoders it doesn't
   need).

## Tasks

1. Confirm the gap on each of the 7 pages (grep for `model-viewer-meshopt` / `setMeshoptDecoder`
   — absence confirms the bug before you touch anything).
2. Apply pattern 1 to `cosmos.html`, `minted.html`, `creations.html`, `vault.html`, `pitch.html`.
3. Apply pattern 2 inside `public/agenc/embed.js`'s `ensureModelViewer()`.
4. Apply pattern 3 to `public/demos/lipsync-mic.html`'s inline GLTFLoader setup.
5. Verify each of the 7 pages against a **compressed** GLB specifically — an uncompressed GLB
   won't reproduce the crash even if the decoder is still missing, so don't trust a clean
   console alone; confirm the model that was actually flagged in the crawl is the one you test
   with (server-baked avatars and Forge output are Meshopt-compressed by default).

## Verification (must all pass, per page, in a real browser)

- [ ] `/cosmos` — no `setMeshoptDecoder` error in console; the model that previously failed now
      renders.
- [ ] `/minted` — same.
- [ ] `/creations` — same.
- [ ] `/vault` — same.
- [ ] `/agenc/embodied` — same, **and** spot-check that `public/agenc/embed.js`'s fix doesn't
      regress the standalone `<three-ws-agent>` embed snippet on a throwaway test page (paste
      the embed's own documented usage example into a scratch HTML file and confirm it still
      loads).
- [ ] `/pitch` — same.
- [ ] `/lipsync/mic` — same; also confirm the mic-driven viseme/lipsync feature itself still
      works end to end (this page's core function, unrelated to the decoder fix — don't let a
      decoder change silently break the loader's callback wiring).

## Do not

- Do not write a fourth, novel meshopt-wiring pattern — this codebase already has two
  (the `<model-viewer>` classic-script bootstrap, and the raw-`GLTFLoader` `getMeshoptDecoder()`
  helper). Every page here fits one of the two; use the matching one.
