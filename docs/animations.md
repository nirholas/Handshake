# Animations

> For how FBX, GLB, and clip JSON relate — the formats, the conversions, and the full generate→rig→animate→export chain — see **[docs/3d-asset-pipeline.md](3d-asset-pipeline.md)**. This page is the runtime registry and agent-slot reference.

The full machine-readable registry is at [`public/animations/registry.json`](../public/animations/registry.json). Read it first before touching anything animation-related — it catalogues every animation asset in the project, which pipeline owns it, and its current status.

## Collections

There are 5 animation collections across the codebase. They are separate and use different rigs:

| Collection | Location | Status |
|---|---|---|
| **clips** | `public/animations/clips/*.json` | Active in main runtime |
| **presets_robotexpressive** | `public/animations/robotexpressive.glb` | Legacy, not loaded at runtime |
| **lora_pipeline** | `character-studio/public/lora-assets/animations/` | character-studio LoRA pipeline only |
| **sprite_atlas_pipeline** | `character-studio/public/sprite-atlas-assets/animations/` | character-studio sprite atlas only |
| **sims_demo** | `sims-demo/public/AnimationLibrary.glb` | sims-demo character controller only |

## How the runtime loads animations

1. `src/app.js` fetches `/animations/manifest.json` on startup
2. `src/animation-manager.js` (`AnimationManager`) loads each clip from `public/animations/clips/`
3. `src/agent-avatar.js` plays clips by resolving **slots** → clip names via `src/runtime/animation-slots.js`
4. The UI widget `src/widgets/animation-gallery.js` lists all loaded clips

## Adding a new animation to the runtime

1. Drop the FBX into `public/animations/`
2. Add an entry to `scripts/animations.config.json`
3. Run `node scripts/build-animations.mjs` (or `npm run build:animations`) — retargets to the Avaturn rig, writes a JSON clip to `public/animations/clips/`, and updates `manifest.json`
4. Update `public/animations/registry.json` so the new clip is catalogued under the `clips` collection
5. Optionally wire a slot in `src/runtime/animation-slots.js` so the agent plays it automatically

## Agent slots

Slots are the fixed vocabulary the agent avatar uses to express emotion/gesture. They resolve to clip names at runtime. Defined in `src/runtime/animation-slots.js`.

| Slot | Default clip | Notes |
|---|---|---|
| `idle` | `idle` | Always playing |
| `wave` | `reaction` | Maps to `reaction`, not the `wave` clip |
| `nod` | `reaction` | |
| `shake` | `angry` | |
| `think` | `pray` | |
| `celebrate` | `celebrate` | |
| `concern` | `defeated` | |
| `bow` | `sitclap` | |
| `point` | `reaction` | |
| `shrug` | `defeated` | |
| `fidget` | `av-waiting` | Real baked idle-fidget loop (was the never-baked `Fidget`, fixed 2026-07-08) |

Agents can override individual slots via `meta.edits.animations`.

## The /animations gallery

[three.ws/animations](https://three.ws/animations) is the public browse surface over every clip: the curated studio manifest, the full R2-hosted motion-capture library (`GET /api/animations/library`, ~2,000 clips), and community-published clips (`GET /api/animations/clips?visibility=public`).

- **Poster thumbnails** — every clip has a WebP still of the preview avatar posed mid-motion. Rendered offline by `node scripts/build-animation-thumbnails.mjs` (drives `scripts/thumbnail-harness.html` in headless Chromium through the site's own retarget engine). Curated thumbs are committed at `public/animations/thumbs/<name>.webp`; library thumbs upload to R2 alongside their clips via `npm run mixamo:upload`, which publishes each one as the manifest entry's `thumb` URL. Added a clip? Re-run the thumbnail script, then re-upload.
- **Categories** — the Mixamo catalog carries no category metadata, so `src/animation-categories.js` derives one per clip from its label (ordered keyword rules; curated clips keep their hand-assigned `animation-presets.js` category). Covered by `tests/animation-categories.test.js`, which also asserts <10% of the real library falls into the "More" catch-all.
- **Live previews** — one shared WebGL engine (`src/animations-live-preview.js`) serves every card hover and the detail modal: a single renderer + preview avatar; the canvas moves into whichever card is previewing. Nothing 3D loads until the first hover.
- **Deep links** — `?clip=<id>` opens a clip's detail modal directly; `q`, `cat`, `filter`, and `sort` round-trip through the URL so filtered views are shareable.

## Known issues

- **`fidget` slot is broken** — maps to `"Fidget"` but no such clip exists in the manifest. Silent no-op at runtime. Fix: add a Fidget FBX to `animations.config.json` and rebuild, or remap the slot. (`src/runtime/animation-slots.js:30`)
- **6 orphaned FBX files** — `Cover To Stand.fbx`, `Goalkeeper Scoop.fbx`, `Jumping Down.fbx` (×3), `Removing Driver.fbx` exist in `public/animations/` but are never built. Fix: add entries to `scripts/animations.config.json`.
- **`wave` clip unreachable** — the `wave` clip is in the manifest but no agent slot or hint points to it. The `wave` slot maps to `reaction` instead.
- **Dead animation hints** — skill-emitted hints `gesture`, `inspect`, `present`, `sign`, `curiosity`, `patience` have no matching clip or slot; they silently no-op on Avaturn models. (`src/agent-avatar.js`)
