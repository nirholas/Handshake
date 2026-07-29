# Animations

Animations are the motion clips (idle, wave, dance, and about 2,000 more) that bring three.ws avatars to life. Browse and preview every clip at [three.ws/animations](https://three.ws/animations); this page is the developer reference for how the clip collections are organized, how the runtime loads them, and how agents pick which clip to play.

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
| **sims_demo** | `sims-demo/public/AnimationLibrary.glb` | sims-demo character controller only — the `sims-demo/` workspace lives outside this repo, so the GLB is not on disk here |

## How the runtime loads animations

1. `src/app.js` fetches `/animations/manifest.json` on startup
2. `src/animation-manager.js` (`AnimationManager`) loads each clip from `public/animations/clips/`
3. `src/agent-avatar.js` plays clips by resolving **slots** → clip names via `src/runtime/animation-slots.js`
4. The UI widget `src/widgets/animation-gallery.js` lists all loaded clips

## Adding a new animation to the runtime

1. Drop the FBX into `animation-sources/` (the build's first-choice source directory, gitignored so raw sources never ship). Dropping it into `public/animations/` also resolves, but that directory is served publicly, so the multi-megabyte FBX would be deployed to production alongside the built clip.
2. Add an entry to `scripts/animations.config.json`
3. Run `node scripts/build-animations.mjs` (or `npm run build:animations`) — retargets to the Avaturn rig, writes a JSON clip to `public/animations/clips/`, and updates `manifest.json`
4. Update `public/animations/registry.json` so the new clip is catalogued under the `clips` collection
5. Optionally wire a slot in `src/runtime/animation-slots.js` so the agent plays it automatically

### Config entry fields

`name`, `source`, `label`, `icon`, and `loop` are the required basics. The rest correct a source whose rig carries a baked transform the retargeter cannot see on its own:

| Field | Effect |
| ----- | ------ |
| `trim` | Cut the clip to its first N seconds. Use on a long looping source where only the opening beat is ever played. |
| `uprightFix` | Remove a constant orientation bias from the Hips track. Needed when a source bakes its up-axis conversion onto the Hips instead of a parent node, which lands the avatar on its back (`scripts/upright-hips.mjs`). |
| `recenterHips` | Remove a constant translation offset from the Hips track, anchoring the clip's first frame to the reference rig's rest Hips. Needed when a source bakes the armature's own transform onto the Hips, which leaves the avatar standing off its mark and floating (`scripts/recenter-hips.mjs`). Authored root motion is preserved. |

Both correction flags are opt-in and self-gating: a clip already upright or already on its mark is returned unchanged, so applying one to a healthy clip is a no-op. They are opt-in rather than automatic so an authored pose (a yoga fold, a clip that deliberately walks in from off-screen) is never silently "corrected".

Hip units are detected from the clip data, not the file extension. Raw Mixamo FBX is centimetre-baked and gets scaled to metres; a source round-tripped through Blender or glTF-Transform already exports metres and is left alone.

### If a source file is missing

Retarget sources are deliberately never committed: the whole `animation-sources/` directory is gitignored, so a clean checkout has none of them and the built clips in `clips/` are the shipped artifact. When a configured clip's source is absent but its built JSON is already in `clips/`, the build republishes the built clip and logs `PREBUILT`. That is the normal path on a fresh clone, not an edge case. Only an entry with neither a source nor a built clip fails, and the failure message points at `npm run extract:animations` to regenerate extracted sources. Retiring a clip is therefore done by removing its config entry, not by deleting its source.

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
| `dance` | `rumba` | |

Agents can override individual slots via `meta.edits.animations`.

## The /animations gallery

[three.ws/animations](https://three.ws/animations) is the public browse surface over every clip: the curated studio manifest, the full R2-hosted motion-capture library (`GET /api/animations/library`, ~2,000 clips), and community-published clips (`GET /api/animations/clips?visibility=public`).

- **Poster thumbnails** — every clip has a WebP still of the preview avatar posed mid-motion. Rendered offline by `node scripts/build-animation-thumbnails.mjs` (drives `scripts/thumbnail-harness.html` in headless Chromium through the site's own retarget engine). Curated thumbs are committed at `public/animations/thumbs/<name>.webp`; library thumbs upload to R2 alongside their clips via `npm run mixamo:upload`, which publishes each one as the manifest entry's `thumb` URL. Added a clip? Re-run the thumbnail script, then re-upload.
- **Categories** — the Mixamo catalog carries no category metadata, so `src/animation-categories.js` derives one per clip from its label (ordered keyword rules; curated clips keep their hand-assigned `animation-presets.js` category). Covered by `tests/animation-categories.test.js`, which also asserts <10% of the real library falls into the "More" catch-all.
- **Live previews** — one shared WebGL engine (`src/animations-live-preview.js`) serves every card hover and the detail modal: a single renderer + preview avatar; the canvas moves into whichever card is previewing. Nothing 3D loads until the first hover.
- **Deep links** — `?clip=<id>` opens a clip's detail modal directly; `q`, `cat`, `filter`, and `sort` round-trip through the URL so filtered views are shareable.

## Known issues

- **`wave` clip unreachable** — the `wave` clip is in the manifest but no agent slot or hint points to it. The `wave` slot maps to `reaction` instead.
- **Dead animation hints** — skill-emitted hints `gesture`, `inspect`, `present`, `sign`, `curiosity`, `patience` have no matching clip or slot; they silently no-op on Avaturn models. (`src/agent-avatar.js`)

Resolved (see `public/animations/registry.json` → `resolved_issues`): the `fidget` slot no longer points at the never-baked `Fidget` clip — it maps to the real `av-waiting` loop (2026-07-08); and the 6 formerly-orphaned source FBX (`Cover To Stand`, `Goalkeeper Scoop`, `Jumping Down` ×3, `Removing Driver`) are now entries in `scripts/animations.config.json` and built into the manifest.

## Related

- [3D asset pipeline](/docs/3d-asset-pipeline): the full generate, rig, animate, export chain
- [Animation Studio](/docs/animation-studio): author and preview clips in the browser
- [3D Viewer](/docs/viewer): how clips play back in the viewer and embeds
- [Clip Director](/docs/clip-director): gesture slots used for trade reaction cards
