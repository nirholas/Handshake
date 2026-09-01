# Animations

Animations are the motion clips (idle, wave, dance, and about 3,000 more) that bring three.ws avatars to life. Browse and preview every clip at [three.ws/animations](https://three.ws/animations); this page is the developer reference for how the clip collections are organized, how the runtime loads them, and how agents pick which clip to play.

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
   - Clips are written compact: every number at 7 significant digits (lossless for float32 keyframes), which is about half the bytes of double-precision output. `node scripts/compact-clips.mjs` rewrites the committed clips the same way and `--check` fails if any is not compact; run `npm run build:motion-signatures` afterwards, since the signature index is computed from the clip bytes.
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

Retarget sources are deliberately never committed: everything in `animation-sources/` except its README is gitignored, so a clean checkout has none of them and the built clips in `clips/` are the shipped artifact. When a configured clip's source is absent but its built JSON is already in `clips/`, the build republishes the built clip and logs `PREBUILT`. That is the normal path on a fresh clone, not an edge case. Only an entry with neither a source nor a built clip fails, and the failure message points at `npm run extract:animations` to regenerate extracted sources. Retiring a clip is therefore done by removing its config entry, not by deleting its source.

## Agent slots

Slots are the fixed vocabulary the agent avatar uses to express emotion and gesture. They resolve to clip names at runtime. Defined in `src/runtime/animation-slots.js`.

Every slot below is previewable on a live avatar at [three.ws/gestures](https://three.ws/gestures), which also builds the override JSON for you.

| Slot | Default clip | Notes |
|---|---|---|
| `idle` | `idle` | Always playing |
| `wave` | `wave` | |
| `nod` | `nod` | |
| `shake` | `xbot-head-shake` | A "no" head shake. The only baked head-shake clip |
| `think` | `think` | |
| `celebrate` | `celebrate` | |
| `concern` | `defeated` | |
| `bow` | `sitclap` | **Approximation.** No bow clip is baked; `sitclap` reads as gratitude. The one slot whose clip does not mean what the slot means |
| `point` | `point` | |
| `shrug` | `shrug` | |
| `fidget` | `av-listening-music` | Clean anchored restless loop. Was the never-baked `Fidget` (fixed 2026-07-08), then `av-waiting`, whose loop seam measures open in `signatures.json` and snapped every cycle |
| `dance` | `rumba` | |
| `inspect` | `lookdown` | Reading data, examining a chart |
| `present` | `av-brag-claps` | Showing a result off |
| `sign` | `xbot-agree` | Authorizing a wallet signature |
| `curiosity` | `av-spy` | Looking around, alert |
| `patience` | `av-idle-anim` | Waiting on a long task. A looping slot needs a clean anchored loop, which rules out `av-waiting` here too |
| `manipulate` | `av-push-block` | Handling a scene object |
| `conjure` | `av-conductor` | Creating something from nothing |

Agents can override individual slots via `meta.edits.animations`:

```json
{ "edits": { "animations": { "dance": "av-offabean-dance", "think": "av-smoking" } } }
```

An override wins over the default; any clip name in the manifest is valid. Unmapped slot names fall through to a clip of the same name, so an agent can point a slot at a clip the platform never wired.

Two ways to write the map, both landing at `meta.edits.animations`:

- **Agent editor, Body tab, Gesture slots.** One row per slot; `Platform default` inherits the platform clip.
- **`PUT /api/agents/:id/animations`** with an `animationSlots` object (owner-authenticated). Keys are validated against `SLOTS`, so a typo is a 400 rather than a gesture that silently never plays; `{}` clears every override. The agent's public manifest then carries the map as `animationSlots`, which is how an `<agent-3d>` embed picks it up.

Both ends of that path were dead until 2026-07-30: nothing could write the map (no field, no UI) and nothing applied it (`setAnimationMap` had no callers), so the override documented here had no effect anywhere. `tests/agent-animation-slots.test.js` pins the write contract and asserts each consumer still applies it.

## Skill animation hints

A skill declares `animationHint` (see `src/agent-skills.js` and its siblings) and the avatar plays the matching slot when that skill starts. `resolveHint()` maps a hint to a slot: exact slot names pass through, the namespaced `gesture-*` family aliases onto one, and an unknown hint in a known family falls back to that family so a new `gesture-something` still animates.

| Hint | Slot | Declared by |
|---|---|---|
| `inspect` | `inspect` | read-only lookups (19 skills, the most common hint in the catalog) |
| `gesture` | `point` | trade and launch actions (19 skills) |
| `curiosity` | `curiosity` | scanning and discovery skills |
| `think` | `think` | reasoning skills |
| `celebrate` | `celebrate` | successful launches and claims |
| `present` | `present` | `present-model` |
| `wave` | `wave` | greetings |
| `nod` | `nod` | acknowledgements |
| `sign` | `sign` | `sign-action` (wallet signature) |
| `patience` | `patience` | long-running work |
| `concern` | `concern` | failure paths |
| `gesture-magic` | `conjure` | `scene-create-object` |
| `gesture-manipulate` | `manipulate` | `scene-update-object` |

`tests/animation-slots.test.js` scans every `animationHint` literal under `src/` and fails if one resolves to no slot, or to a clip missing from the manifest. That guard exists because a hint nobody wired up reads exactly like a working one at the call site: `inspect`, `gesture`, `present`, `sign`, `curiosity` and `patience` silently played nothing until 2026-07-30, and the two commonest of them covered 38 skill declarations.

The walk state machine keeps a parallel gesture library (`src/animation-state-machine.js` `GESTURES`) for player-driven gestures on `/walk`, with an `upper`/`full` layer per gesture so an avatar can wave or shrug while it keeps walking. Those clip names are held to the manifest by `tests/walk-gestures.test.js`.

## Keeping the registry true

`public/animations/registry.json` is regenerated by `scripts/sync-animation-registry.mjs` (`npm run sync:animation-registry`, and automatically at the end of `npm run build:animations`). It derives each clip's label, icon and loop flag from the built manifest, its source path from `scripts/animations.config.json`, and its `agent_slots` by reversing `DEFAULT_ANIMATION_MAP`, so a slot can never be recorded on two clips. Hand-written `note` fields survive. `tests/animation-registry.test.js` fails if the committed file is not what the script would produce.

Its measured companion is `public/animations/signatures.json`: a motion-signature index (duration, energy, speed, per-region movement shares, loop cleanliness) computed from every baked clip by `scripts/build-motion-signatures.mjs` (`npm run build:motion-signatures`, also chained into `build:animations`; `npm run audit:motion` fails when it is stale). Slot defaults consult it: a looping slot like `fidget` or `patience` needs a clip whose loop measures clean, which is why neither maps to `av-waiting`.

## The /animations gallery

[three.ws/animations](https://three.ws/animations) is the public browse surface over every clip: the curated studio manifest, the full R2-hosted motion-capture library (`GET /api/animations/library`, ~2,900 clips; `total` on that response is the live count), and community-published clips (`GET /api/animations/clips?visibility=public`).

- **Poster thumbnails**: a WebP still of the preview avatar posed mid-motion, rendered offline by `node scripts/build-animation-thumbnails.mjs` (which drives `scripts/thumbnail-harness.html` in headless Chromium through the site's own retarget engine). Curated thumbs are committed at `public/animations/thumbs/<name>.webp`; library thumbs upload to R2 alongside their clips via `npm run mixamo:upload`, which publishes each one as the manifest entry's `thumb` URL. Added a clip? Re-run the thumbnail script, then re-upload. **The library manifest's `thumb` field is the only source of truth for a library thumbnail.** Coverage is partial (853 of 2,874 entries carry no `thumb` as of 2026-08-16), and the gallery renders the clip's icon for those instead of guessing a CDN path: the guess 404s on every one of them, which cost a blocked cross-origin request per card.
- **Categories** — the Mixamo catalog carries no category metadata, so `src/animation-categories.js` derives one per clip from its label (ordered keyword rules; curated clips keep their hand-assigned `animation-presets.js` category). Covered by `tests/animation-categories.test.js`, which also asserts <10% of the real library falls into the "More" catch-all.
- **Live previews** — one shared WebGL engine (`src/animations-live-preview.js`) serves every card hover and the detail modal: a single renderer + preview avatar; the canvas moves into whichever card is previewing. Nothing 3D loads until the first hover.
- **Deep links**: `?clip=<id>` opens a clip's detail modal directly; `q`, `cat`, `filter`, and `sort` round-trip through the URL so filtered views are shareable. Every one of them is validated against the values the controls can represent, so a hand-edited `?sort=bogus` falls back to `featured` rather than blanking the sort menu, and an arriving `?filter=once` presses the matching segmented button instead of filtering invisibly.
- **Detail modal**: a real dialog. Focus moves into it on open, Tab wraps inside it, Escape closes it and returns focus to the card that opened it. Arrow keys step through the filtered list (except while a slider is focused, which owns its own arrows), and Space toggles playback. The transport row only appears once a clip is actually on the stage, so a preview that fails to load shows the error and its Studio link rather than controls that do nothing.

## Known issues

- **`bow` is an approximation.** No bow clip is baked, so the slot resolves to `sitclap`, which reads as gratitude/applause rather than a bow. Tracked in `public/animations/registry.json` under `known_issues` (`bow-slot-approximation`), with the Mixamo source to add.

Resolved (see `public/animations/registry.json` under `resolved_issues`): the `wave`, `nod`, `point`, `think`, and `shrug` slots each play their own dedicated clip instead of a borrowed `reaction`/`pray`/`defeated` stand-in (2026-07-30); the skill hints `gesture`, `inspect`, `present`, `sign`, `curiosity`, and `patience` all resolve to real slots via `resolveHint()` instead of silently no-oping (2026-07-30); the `fidget` slot no longer points at the never-baked `Fidget` clip (2026-07-08, later moved to `av-listening-music` when `signatures.json` measured `av-waiting`'s loop seam open); and the 6 formerly-orphaned source FBX (`Cover To Stand`, `Goalkeeper Scoop`, `Jumping Down` ×3, `Removing Driver`) are entries in `scripts/animations.config.json` and built into the manifest.

## Related

- [Agent Gestures](/gestures): the live slot-and-hint reference, with an override builder
- [Choreography](/docs/choreography): sequence gesture slots into named, replayable routines, authored at [/choreograph](https://three.ws/choreograph)
- [Give your agent body language](/tutorials/animate-your-agent): the walkthrough
- [3D asset pipeline](/docs/3d-asset-pipeline): the full generate, rig, animate, export chain
- [Animation Studio](/docs/animation-studio): author and preview clips in the browser
- [3D Viewer](/docs/viewer): how clips play back in the viewer and embeds
- [Clip Director](/docs/clip-director): gesture slots used for trade reaction cards
