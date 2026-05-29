# Animation Studio — build plan

This directory contains **sequenced task prompts**. Each `NN-*.md` file is meant to be
pasted into a **fresh agent chat** in this repo. Run them **in order** — later tasks
depend on earlier ones. Every task assumes the agent has already loaded the repo's
`CLAUDE.md` operating rules (no mocks, no stubs, wire 100%, real APIs, design every state).

## The goal (what we are building)

Turn the existing `/pose` page (today: a click-to-pose primitive mannequin) into a full
**Animation Studio**:

1. **Load a rig.** Users can pose either the built-in primitive mannequin (default) **or**
   a real rigged GLB — including **their own custom avatars made on three.ws**, loaded by
   `?avatar=<id>` or picked from a gallery.
2. **Pose ergonomically.** Click/drag joints with rotation gizmos and **inverse kinematics**
   (drag a hand or foot, the limb solves) — not just raw per-axis sliders.
3. **Keyframe a timeline.** Set a pose → drop a keyframe → advance the playhead → re-pose →
   drop another. The tool interpolates between keyframes and plays the result. This is how a
   user authors a walk cycle, a wave, a dance.
4. **Export.** Download as a **GLB with embedded animation** and/or as a three.ws **clip JSON**.
5. **Save to account.** Persist animations to the signed-in user's account; manage a library
   (rename, retag, set visibility, delete).
6. **Works across three.ws.** Saved/public animations play back anywhere via the existing
   `AnimationManager` / viewer (avatar pages, embeds).
7. **Monetize.** Users can put a price on an animation and sell it for USDC via the existing
   x402 rails; buyers pay once and download. Listed in the marketplace + bazaar.

## Task sequence

| # | File | Depends on | What it delivers |
|---|------|-----------|------------------|
| 1 | `01-avatar-loading-and-rigged-posing.md` | — | Load rigged GLB + own avatars into `/pose`; pose real skeletons with gizmos + IK; keep mannequin as default |
| 2 | `02-keyframe-timeline-and-export.md` | 1 | Timeline UI, keyframe model, bake to `AnimationClip`, live preview, GLB + clip-JSON export |
| 3 | `03-backend-animation-clips-api.md` | — (can run anytime) | DB migration + `/api/animations` CRUD with auth, ownership, visibility, pricing columns |
| 4 | `04-save-and-library.md` | 2, 3 | "Save to account", thumbnail capture, "My animations" library drawer in the editor |
| 5 | `05-playback-across-platform.md` | 3 | Saved/public animations resolvable + playable via `AnimationManager`/viewer; public gallery |
| 6 | `06-monetization.md` | 3, 4 | Price an animation → x402 paid download (USDC), per-creator payout, marketplace + bazaar listing |
| 7 | `07-nav-promotion-and-polish.md` | 1–6 | Shared nav/header/footer on the page, rename + promote out of Labs, cross-linking, final QA |

Tasks 1 and 3 are independent and can be started in parallel. Everything else follows the
dependency column.

---

## Shared architecture & conventions (READ THIS — every task relies on it)

These are real, verified facts about the codebase as of this writing. Cite file paths in your
work and **read the referenced files before editing**.

### The pose studio today
- Page: [pages/pose.html](../../pages/pose.html) — standalone page, routed at `/pose`
  ([vercel.json](../../vercel.json), [vite.config.js](../../vite.config.js)). It loads
  `/nav.css` but does **not** currently inject the shared nav/header/footer.
- Logic: [src/pose-studio.js](../../src/pose-studio.js) — `setupScene()` builds the
  `Scene`/`PerspectiveCamera`/`WebGLRenderer` (with `preserveDrawingBuffer: true` for PNG
  export), `OrbitControls`, lights, a `ShadowMaterial` ground + `GridHelper`, and a `propLayer`
  `Group`. Raycaster-based joint picking + drag-to-rotate. PNG export via `canvas.toDataURL`.
- Mannequin: [src/pose-mannequin.js](../../src/pose-mannequin.js) — `Mannequin` class with 16
  joints (`JOINT_NAMES`: pelvis, spine, chest, neck, head, shoulder/elbow/wrist L+R,
  hip/knee/ankle L+R). API: `setJointRotation(name, axis, radians)`, `getJointRotation(name)`,
  `applyPose(pose)`, `getPose()`, `resetPose()`, `setConstraintsEnabled()`, `setBuild()`,
  `setColor()`. Pose JSON is a flat map `{ jointName: {x,y,z}, rootPosition?: {x,y,z} }`.
- Presets: [src/pose-presets.js](../../src/pose-presets.js) — `PRESETS[]`, `getPresetById()`,
  `getPresetsByGroup()`.

### Loading rigged avatars
- GLTFLoader pattern with Draco/KTX2/Meshopt decoders lives in
  [src/viewer.js](../../src/viewer.js) (~lines 841–887). Reuse the same decoder setup — do not
  hand-roll a bare loader.
- The `Viewer` class ([src/viewer.js](../../src/viewer.js)) loads avatars and exposes an
  `AnimationManager`. A loaded `gltf` gives `gltf.scene` and `gltf.animations` (`AnimationClip[]`).
- **Avatar gallery picker (ready to use):** [src/avatar-gallery-picker.js](../../src/avatar-gallery-picker.js)
  — `new AvatarGalleryPicker({ source: 'mine'|'public'|'both', onSelect: (avatar)=>{}, ... })`,
  `.openModal()` / `.mountInline(el)`. `onSelect` receives an avatar with `id`, `name`,
  `model_url`, `thumbnail_url`, `tags`.
- **Avatar list API:** `GET /api/avatars` (session auth, `credentials: 'include'`) returns
  `{ avatars: [{ id, slug, name, model_url, thumbnail_url, tags, ... }], next_cursor }`.
  Public variant: `GET /api/avatars/public`. Avatar decoration shape is in
  [api/_lib/avatars.js](../../api/_lib/avatars.js) (`model_url` is the resolved/presigned GLB URL).
- **Demo avatars** (for `?avatar=` testing without auth): [api/_lib/demo-avatars.js](../../api/_lib/demo-avatars.js)
  — ids like `avatar_demo_disk_cz`, `avatar_demo_disk_saga` (robot, animated), etc. Note: the
  `?avatar=` param is currently **not read** by the pose studio — wiring it is Task 1.

### Bone naming (critical for cross-platform playback)
- Canonical skeleton = **Avaturn / Mixamo-retargeted** names: `Hips`, `Spine`, `Spine1`,
  `Spine2`, `Neck`, `Head`, `LeftArm`/`LeftForeArm`/`LeftHand`, `RightArm`/`RightForeArm`/`RightHand`,
  `LeftUpLeg`/`LeftLeg`/`LeftFoot`/`LeftToeBase`, `RightUpLeg`/`RightLeg`/`RightFoot`/`RightToeBase`,
  plus finger bones.
- A robust bone-name normalizer already exists: `normalizeBoneName()` in
  [src/avatar-export.js](../../src/avatar-export.js) (strips `mixamorig:`, `CC_Base_`, `Armature|`,
  `rig:`, `Bip01`, separators). Reuse it; do not write a new one.
- Reference rig used by the build pipeline: `public/avatars/cz.glb`.

### Animation clip format (the format that "works on three.ws")
- Stored clips are `THREE.AnimationClip.toJSON()` output:
  ```json
  {
    "name": "wave",
    "duration": 1.0,
    "tracks": [
      { "name": "Hips.position",   "type": "vector",     "times": [...], "values": [x,y,z, ...] },
      { "name": "Hips.quaternion", "type": "quaternion", "times": [...], "values": [x,y,z,w, ...] },
      { "name": "Head.quaternion", "type": "quaternion", "times": [...], "values": [...] }
    ]
  }
  ```
  Track name = `BoneName.property`. Parse with `AnimationClip.parse(json)`.
- Manifest of built-in clips: [public/animations/manifest.json](../../public/animations/manifest.json)
  — entries `{ name, url, label, icon, loop }`. Clips live in `public/animations/clips/*.json`.
- Build pipeline (reference only — we author in-browser, not via FBX): [scripts/build-animations.mjs](../../scripts/build-animations.mjs).
- **Playback engine:** [src/animation-manager.js](../../src/animation-manager.js) — `AnimationManager`
  with `setAnimationDefs(defs)`, `attach(model)`, `loadAll()`, `ensureLoaded(name)`, `play(name)`,
  `crossfadeTo(name, dur)`, `update(dt)`. It wraps a `THREE.AnimationMixer`. This is what your
  exported/saved clips must be compatible with.
- **Export with animations:** [src/avatar-export.js](../../src/avatar-export.js) uses
  `GLTFExporter` and already passes `animations: gltf.animations` — i.e., exporting a GLB with
  embedded animation tracks is a solved path; reuse it.

### Posing aids available (already in node_modules — no install)
- `three/examples/jsm/animation/CCDIKSolver.js` — inverse kinematics.
- `three/examples/jsm/controls/TransformControls.js` — rotation/translation gizmos.
- three.js version: **0.176.0**. Import addons via `three/addons/...` or
  `three/examples/jsm/...` consistent with existing imports in the file you're editing.

### Backend patterns (DB, auth, x402)
- **DB client:** [api/_lib/db.js](../../api/_lib/db.js) — `import { sql } from '../_lib/db.js'`,
  Neon serverless, tagged-template queries (`await sql\`select ... ${val}\``).
- **Auth:** [api/_lib/auth.js](../../api/_lib/auth.js) — `getSessionUser(req)` (session cookie),
  `authenticateBearer(extractBearer(req))` (API key / OAuth), `hasScope()`. The mocap endpoints
  use a `resolveAuth(req, scope)` helper that tries session then bearer — mirror it.
- **Migrations:** `api/_lib/migrations/<YYYY-MM-DD>-<slug>.sql`, applied via
  `npm run db:migrate` (runner: [scripts/apply-migrations.mjs](../../scripts/apply-migrations.mjs);
  SHA-tracked in `schema_migrations` — never edit an applied file, roll forward). Also mirror the
  table into [api/_lib/schema.sql](../../api/_lib/schema.sql) for clean deploys.
- **Closest precedent for user-owned clips:** the `mocap_clips` table + endpoints —
  [api/mocap/clips.js](../../api/mocap/clips.js), [api/mocap/[id].js](../../api/mocap/[id].js),
  migration [api/_lib/migrations/2026-05-24-mocap-clips.sql](../../api/_lib/migrations/2026-05-24-mocap-clips.sql).
  It already has `owner_id`, `avatar_id`, `slug`, `visibility (private|unlisted|public)`,
  `price_amount`, `price_currency`, `frames jsonb`, `storage_key` (R2 for large), soft-delete.
  Zod validation, slug uniqueness per owner, avatar-ownership check — copy these patterns.
- **Monetization (the key reuse):** the platform already sells downloadable assets for USDC:
  - `paid_assets` table + [api/x402/asset-download.js](../../api/x402/asset-download.js) —
    "pay once → presigned R2 download", with per-creator payout overrides
    (`creator_payto_base` / `creator_payto_solana` / `creator_payto_bsc`) and SIWX re-download.
  - Paid-endpoint helper: [api/_lib/x402-paid-endpoint.js](../../api/_lib/x402-paid-endpoint.js)
    (`paidEndpoint()`), spec/bazaar schema in [api/_lib/x402-spec.js](../../api/_lib/x402-spec.js)
    (`buildBazaarSchema()`, `bazaarExtension()`). Prices are USDC atomics (6 decimals:
    `1_000_000` = $1.00).
  - Hosted checkout SKUs: [api/x402-skus.js](../../api/x402-skus.js) → `/pay/c/<slug>`.
  - Marketplace page + bazaar UI: search the repo for `pages/marketplace*.html` /
    `public/bazaar.js` and their data APIs.

### Navigation
- Nav is injected client-side: a page includes `<div id="nav-container"></div>` +
  `<script src="/nav.js"></script>`; [public/nav.js](../../public/nav.js) fetches
  [public/nav.html](../../public/nav.html) and wires handlers. `/pose` currently sits in the
  **Labs** submenu of `nav.html` (~line 270). Promoting it is Task 7.

---

## Rules for every task (do not skip)

- **Follow [CLAUDE.md](../../CLAUDE.md).** No mocks, no fake data, no stubs, no TODOs, no
  commented-out code, no `setTimeout` fake loading. Real APIs, real wiring, every state designed
  (loading/empty/error/populated), accessibility, hover/active/focus states.
- **Read before you write.** Open the referenced files and match existing patterns, naming, and
  CSS variables/tokens already in the page.
- **Wire 100%.** Every button works, every link goes somewhere, every state is reachable. No dead
  paths. Trace the full data flow before writing UI.
- **Verify in a real browser.** `npm run dev` (port 3000), exercise the feature, confirm no
  console errors and real network calls succeed. State explicitly what you verified.
- **Keep the repo root clean.** No throwaway scripts in root (use `scripts/`), no committed
  scratch files/screenshots.
- **Run the `completionist` subagent** over your changed files before declaring done; fix
  everything it flags.
- **Do not push** unless the user explicitly approves. When they do, push to **both** remotes
  (`git push threeD main` and `git push threews main`) as per CLAUDE.md. Never pull/fetch from
  `threeD`.
- **Tests:** keep `npm test` green; add tests where the existing suite has a matching pattern
  (e.g. contract tests under `tests/`).
- At the end of your task, write a short note of what changed and what the **next** task in the
  sequence should build on, so the next chat has continuity.
