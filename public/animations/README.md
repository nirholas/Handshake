# public/animations

Source-of-truth folder for runtime animations. Drop new clips here, then wire them through the build.

Full reference: **[../../docs/animations.md](../../docs/animations.md)** — collections, agent slots, known issues.

## Adding a new animation

1. Drop the source file into `../../animation-sources/` if it's an `.fbx` (build-time input, never shipped in the deploy bundle), or into this folder if it's a `.glb` that is also served at runtime. The build looks in both.
2. Add an entry to [`../../scripts/animations.config.json`](../../scripts/animations.config.json):
   ```json
   { "name": "av-my-anim", "source": "My Anim.fbx", "label": "My Anim", "icon": "🎬", "loop": true }
   ```
3. Build:
   ```sh
   npm run build:animations
   ```
   This retargets to the Avaturn rig (`public/avatars/cz.glb`), writes a JSON clip to `clips/`, and rewrites `manifest.json`.
4. Add the entry to the `clips` collection in [`registry.json`](registry.json).
5. (Optional) Wire to an agent slot in [`../../src/runtime/animation-slots.js`](../../src/runtime/animation-slots.js) if you want the agent to play it automatically.

## What lives here

- `*.fbx` / `*.glb` — source clips. Drop new ones at the root of this folder.
- `clips/*.json` — built, retargeted clips loaded at runtime. **Generated — do not hand-edit.**
- `manifest.json` — runtime index of built clips. **Generated.**
- `registry.json` — human-readable catalogue of every animation asset in the project (incl. orphans and other pipelines).
- `mixamo/` — name maps and catalogue for the Mixamo source library.
- `robotexpressive.glb` — legacy fallback rig, not loaded at runtime.

## Gotchas

- A file dropped here **does nothing** until it's listed in `animations.config.json` and built. Orphaned FBX files are tracked in `registry.json` under `orphaned_fbx`.
- The build skips entries whose source file is missing *and* that have no built clip yet (currently 6 pole-dance entries) — that's expected and unrelated to new additions. An entry whose source is missing but whose clip is already built is republished from the built JSON and logged as `PREBUILT`, so gitignored sources (`mx-*.fbx`) don't drop live clips on a clean checkout.
- A source that has been round-tripped through Blender or glTF-Transform can carry a baked armature transform that leaves the avatar off its mark or on its back. Correct it with `recenterHips` / `uprightFix` in the config entry — see [../../docs/animations.md](../../docs/animations.md#config-entry-fields).
- `name` in `animations.config.json` becomes the clip's runtime ID. Convention: `av-<kebab-case>` for Avaturn-retargeted clips, bare `<kebab-case>` for the original Mixamo set.
