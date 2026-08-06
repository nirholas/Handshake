# 3D Editing, Viewing & Validation

UX Flow Atlas — cluster "3D Editing, Viewing & Validation". Each entry is traced from real source code (file + symbol citations). Routing was resolved by reading `vite.config.js` dev-server rewrites and each page's `<script>` imports.

Routing summary (from `vite.config.js`):

| Route | Page HTML | Entry module |
|---|---|---|
| `/scene` | `pages/scene.html` | `src/scene-studio/main.js` (vendored three.js r184 editor) |
| `/compose` | `pages/compose.html` | `src/scene-compose.js` |
| `/pose` | `pages/pose.html` | `src/pose-studio.js` |
| `/validation` | `public/validation/index.html` | `src/validation-ui.js` + `src/validation-page.js` (+ `src/validator.js`) |
| `/app` | `pages/app.html` | `src/app.js` → `src/viewer.js`, `src/editor/index.js`, `src/validator.js` |
| `/hydrate` | `public/hydrate/index.html` | inline module (no `src/` file) |
| `/artifact` | `public/artifact/index.html` | inline module (no `src/` file) |
| `/avatar-artifact` | `pages/avatar-artifact.html` | inline script (CDN three.js r128, fully procedural) |

---

### Scene Studio — `/scene`
- **Source:** `pages/scene.html`, `src/scene-studio/main.js`, vendored editor under `src/scene-studio/vendor/js/` (`Editor.js`, `Viewport.js`, `Menubar.*.js`, `Sidebar.*.js`, commands), `src/scene-studio/studio.css`, `src/shared/scene-handoff.js`.
- **Entry point:** `pages/scene.html` loads the CodeMirror/Draco vendor `<script>` chain, then `<script type="module" src="/src/scene-studio/main.js">` (scene.html:84). `main.js` constructs the vendored `Editor`, mounts Viewport/Toolbar/Script/Player/Sidebar/Menubar/Resizer/Animation panels into `#studio-app`, exposes `window.editor`/`window.THREE`, and inits IndexedDB-backed autosave/storage (`editor.storage.init`, main.js:36-144). The surface is dark-locked (`data-theme='dark'` re-pinned, main.js:11).
- **Prerequisites / gates:** None. No auth, no wallet, no $THREE gate. Works fully anonymously; an empty default scene loads immediately. State persists locally via `editor.storage` (autosave to IndexedDB, debounced ~1s, main.js:111-143).
- **Steps (N):**
  1. Arrive at `/scene`. Editor mounts; prior autosaved scene restored from IndexedDB, or `sceneEnvironmentChanged('Default')` fires for a fresh scene (main.js:89-97).
  2. (optional, deep-link) Arrive via `/scene?model=<glb_url>&name=<label>` (hand-off from Forge/Parts). `importModelFromQuery()` validates the URL is `https://` or same-origin relative, fetches the GLB, parses it with the Draco/KTX2/Meshopt-wired GLTFLoader, adds it via `AddObjectCommand`, selects it, and strips the query from the address bar (main.js:186-206).
  3. (optional, deep-link) Arrive via `/scene?handoff=1` (hand-off from Animation Studio `/pose`). `importHandoffAnimation()` reads the baked GLB from IndexedDB via `takeSceneHandoff()`, adds it, and attaches a `Play Animation` player script so the embedded clip plays live and records to video (main.js:208-251).
  4. Import a model: drag a GLB/glTF (or a folder of glTF+textures) anywhere on the page → `drop` handler routes to `editor.loader.loadItemList`/`loadFiles` (main.js:255-271); or use **File ▸ Import** file picker (`Menubar.File.js`:185-211).
  5. Add primitives/lights/cameras via the **Add** menu (`Menubar.Add.js`); add scripts via **Script** panel (CodeMirror).
  6. Select an object in the Viewport or the Outliner (Sidebar). The transform gizmo attaches.
  7. Transform with the gizmo — translate / rotate / scale (Toolbar mode buttons + Viewport `TransformControls`).
  8. Edit properties in the Sidebar: object transform, **Geometry**, **Material** (color/maps/roughness/metalness/etc.), **Scene** (background, environment, fog), per-light settings.
  9. (optional) Edit a script in the Script panel; (optional) press **Play** (`Player`) to run scene scripts/animations live.
  10. (optional) Keyframe/inspect animations in the Animation panel (timeline at bottom; `animationPanelChanged` resizes Viewport, main.js:70-85).
  11. (optional) **File ▸ New** (empty / templates) to reset; undo/redo via the command history.
  12. Export via **File ▸ Export** submenu: GLB, GLTF, OBJ, PLY (ASCII/binary), STL (ASCII/binary), USDZ, DRC/Draco (`Menubar.File.js`:212-435). A download is triggered (e.g. `scene.glb`, `scene.gltf`).
  13. (optional) **File ▸ Export Project** saves the editor scene as a `.json` project; **File ▸ Open** re-imports a `.json` project (`Menubar.File.js`:91-185).
  14. (optional) **Render** menu → render an image or video of the scene via `APP.Player` (`Menubar.Render.js`).
- **Decision points / branches:** Fresh scene vs restored autosave (main.js:89-104). Deep-link arrival (`?model=` add, `?handoff=1` animation import) vs plain manual import. `#file=<url>` hash → prompts to open a remote `.json` project, replacing the scene (main.js:286-299). Drag of a folder (`DataTransferItemList`) vs single files.
- **External calls / dependencies:** `fetch(modelUrl)` for `?model=` deep-link GLB (main.js:195); IndexedDB via `editor.storage` (autosave) and `src/shared/scene-handoff.js` (`takeSceneHandoff`, DB `three-ws-scene-handoff`); Draco decoder at `/three/draco/gltf/` (shared with the main app), KTX2 transcoder at `/scene-studio/basis/` (main.js:163-165); local CodeMirror/esprima/acorn/tern vendor libs. Imports: glTF/GLB (+ companion textures), `.json` editor projects. Exports: GLB, GLTF, OBJ, PLY, STL, USDZ, DRC, JSON project, rendered image/video. No platform API calls.
- **Success state:** Imported/transformed objects appear in the Viewport + Outliner; autosave indicator (`savingStarted`/`savingFinished`) confirms persistence; export triggers a file download.
- **Empty / error states:** Empty default scene with grid + default environment when no autosave exists. `?model=` fetch failure → `alert('Could not load the handed-off model … drag the GLB file into the editor instead.')` (main.js:204). `?handoff=1` IndexedDB unavailable → silently no-ops; load failure → `alert('Could not load the animation … Try Export GLB on /pose and drag the file in instead.')` (main.js:248-249). No-GLB-in-drop handled by the vendored loader.
- **Step count:** ~7 required (arrive → import → select → transform → edit material → edit scene → export) + ~7 optional (deep-link arrival, primitives/lights, scripts, Play, animation timeline, project save/open, render).

---

### Scene Composer — `/compose`
- **Source:** `pages/compose.html`, `src/scene-compose.js`, `src/shared/log.js`.
- **Entry point:** `<script type="module" src="/src/scene-compose.js">` (compose.html:377). Module sets up a Three.js renderer/scene/PMREM environment, OrbitControls, a `TransformControls` gizmo, undo/redo stack, then on IIFE boot reads URL params (`?glb=` / `?avatar=`) and renders the initial hierarchy (scene-compose.js:107-120, 940-964, 1343).
- **Prerequisites / gates:** None to compose/forge/export. Forge ownership is auth-free via a generated `forge_client_key` in localStorage sent as the `x-forge-client` header (scene-compose.js:88-94). **Saving an outfit** requires an avatar loaded from `/api/avatars/<id>` (a real avatar id), otherwise it falls back to "Use Export GLB" (scene-compose.js:1318-1320). No wallet / $THREE gate.
- **Steps (N):**
  1. Arrive at `/compose`. If `?glb=<url>` present → load that GLB as an item (scene-compose.js:940-942). If `?avatar=<id-or-url>` present → resolve via `/api/avatars/<id>` (or direct URL) and load as the avatar (scene-compose.js:948-960). Else show the avatar prompt / canvas hint.
  2. Choose a base avatar (optional): paste a URL and **Load** (`btn-load-url`, scene-compose.js:967-971); **Browse** opens a modal listing avatars from `/api/explore?type=avatar&limit=24` (scene-compose.js:980-999); or **Skip** to compose without an avatar (scene-compose.js:973).
  3. **Forge an item from text:** type a prompt, optionally pick an intent chip (accessory/item/scene/creature/vehicle — drives suggestion pills + `model_category`), press **Forge** (`startForge`, scene-compose.js:1071-1103). Live progress bar with staged labels; polls `/api/forge?job=<id>` every 3s until `done` (then adds the GLB to the scene) or `failed`/timeout (scene-compose.js:1105-1142).
  4. (optional) Import a local GLB/glTF via drag-drop on the drop zone or the file input (`loadFile`, scene-compose.js:1240-1260).
  5. Select an object by clicking it (or via the hierarchy list `#ol`). Inspector `#ins` shows transform + scale-lock chain.
  6. Transform: gizmo modes translate/rotate/scale (toolbar buttons), toggle world/local space (X key), grid snap (Ctrl+G), duplicate (Ctrl+D), frame/focus selected (F).
  7. (optional) Attach an item to an avatar bone: when an avatar with bones is loaded, the inspector shows a bone `<select>` grouped by region (Head/Torso/Arms/Legs); choosing a bone calls `attachToBone` which parents the item group under the bone (scene-compose.js:783-895).
  8. (optional) Rename objects (double-click in hierarchy), toggle visibility, delete (with geometry/material/texture disposal).
  9. (optional) Use camera presets (Front/Back/Left/Right/Top/Isometric) via the camera menu.
  10. (optional) **Screenshot** (Ctrl+P / button) → downloads `scene-compose.png` (scene-compose.js:1265-1279).
  11. **Export GLB** → bundles all visible, non-bone-attached objects into one group and downloads `scene-compose.glb` (scene-compose.js:1284-1305).
  12. **Save outfit** → requires a loaded avatar with bone-attached items; PATCHes `/api/avatars/<id>` with the `accessories` array (bone, glbUrl, name) (scene-compose.js:1310-1335).
- **Decision points / branches:** Boot branch on `?glb=` vs `?avatar=` vs neither (scene-compose.js:940-963). Forge synchronous `done` vs async `job_id` poll (scene-compose.js:1088-1097). Export (all objects, any state) vs Save outfit (avatar + bone-attached items only; requires a `/api/avatars/<id>`-sourced avatar id). Bone-attach UI only appears for non-avatar items when an avatar with bones exists.
- **External calls / dependencies:** `POST /api/forge` + `GET /api/forge?job=<id>` (text-to-3D, with `x-forge-client` header); `GET /api/forge-gallery?limit=24` (your forged creations, scene-compose.js:1175); `GET /api/explore?type=avatar&limit=24` (avatar browse modal); `GET /api/avatars/<id>` (resolve avatar by id); `PATCH /api/avatars/<id>` (save outfit accessories). Imports: GLB/glTF (URL or local file). Exports: GLB (`GLTFExporter`, binary), PNG screenshot.
- **Success state:** Forged/loaded items appear in scene + hierarchy with toasts ("Added: …", "Loaded: …", "Attached to <bone>"); export/save flash "Exported ✓" / "Outfit saved ✓" (`flashSave`, scene-compose.js:1337-1341).
- **Empty / error states:** Empty hierarchy → "No objects — load an avatar or forge an item." (scene-compose.js:604). Forge errors → red banner via `showForgeError` (auto-hides 6s); timeout → "Generation timed out. Try again." Avatar browse empty → "No avatars found. Forge one first." Export with nothing → toast "Nothing to export". Save outfit with no avatar → "Load an avatar first"; no attached items → "Attach at least one item to a bone first"; non-API avatar → "Use Export GLB to save this scene".
- **Step count:** ~5 required (arrive → forge or import → select → transform → export) + ~7 optional (load/browse/skip avatar, intent chips, bone attach, rename/visibility, camera presets, screenshot, save outfit).

---

### Animation Studio — `/pose`
- **Source:** `pages/pose.html`, `src/pose-studio.js` (entry), `src/pose-rig.js`, `src/pose-animation.js`, `src/pose-presets.js`, `src/pose-library.js`, `src/pose-share.js`, `src/animation-library.js`, `src/shared/scene-handoff.js`. (Note: `src/pose-mannequin.js` and `src/avatar-pose.js` exist but are **not** on the `/pose` load path — the studio's mannequin comes from `MannequinRig` in `pose-rig.js`.)
- **Entry point:** `<script type="module" src="/src/pose-studio.js">` (pose.html:2082). `boot()` runs on `DOMContentLoaded` (pose-studio.js:361, 1634): builds the Three.js scene/renderer (`preserveDrawingBuffer` for screenshots), OrbitControls, a rotate `TransformControls` gizmo, lights/grid/prop layer, then immediately mounts the built-in `MannequinRig` (pose-studio.js:406-408) and starts `tick()` (423-436).
- **Prerequisites / gates:** None to pose/keyframe/preview/export/screenshot/scene-handoff — the mannequin is mounted at boot, usable anonymously. **Save to account** and **sell** are auth-gated: `PoseLibrary.openSaveDialog` checks `getUser()` (`GET /api/auth/me`); if signed out it stashes the doc in sessionStorage and routes to `/login?next=/pose`, restoring on return (pose-library.js:85-129). The curated preset Animation Library and the AI text-to-motion generator **require a rigged GLB avatar** (mannequin shows a "Load a rigged avatar" empty state). No wallet / $THREE gate.
- **Steps (N):**
  1. Arrive at `/pose`. Mannequin mounts with a starting pose (shared pose from `#p=`/`?p=` if present, else `contrapposto`, pose-studio.js:413-419). `?avatar=<id>` loads that avatar (falls back to mannequin on failure); `?anim=<id>` opens a saved clip into the editor (pose-studio.js:1608-1631).
  2. (optional) Choose the figure: **Load avatar** opens `AvatarGalleryPicker` → `loadAvatarFromUrl()` (GLTF load with % progress, builds rig via `makeGltfRig`, frames, writes `?avatar=`, pose-studio.js:775-862); or **Mannequin** to return to the primitive rig (`switchToMannequin`, 821).
  3. (optional) Tune model/scene: mannequin body type/skin tone/constraints (GLB-disabled); background color, FOV, floor grid, key-light azimuth/elevation/intensity, floor props (chair/stool/cube/ball/plinth) (pose-studio.js:937-1019).
  4. Select a bone: click the figure (`pickBoneAt`, 471-518), click the searchable bone list (699-732), or grab an IK handle (auto-selects).
  5. Pose with FK (default mode): rotate gizmo on the selected bone + X/Y/Z rotation sliders + "Reset this bone" (`renderControlsPanel`, 640-696).
  6. (optional) Pose with IK: toggle IK (top bar or **I** key; disabled if the rig exposes no limb chains) and drag a glowing cyan hand/foot handle → `rig.solveIK` (pose-studio.js:585-630). FK and IK are mutually exclusive.
  7. (optional) Apply a preset pose from the grouped grid (Standing/Action/Sitting/Expressive, `poseFromMannequinPreset`, pose-studio.js:734-758).
  8. (optional, rigged GLB only) Apply a curated motion clip or AI-generate one: `AnimationLibrary` cards from `/animations/manifest.json` retarget+play live; text box POSTs `/api/forge-motion` and polls for the clip (animation-library.js:27, 102, 541-560).
  9. Keyframe the timeline: pose, then **Add keyframe** / **K** (`captureKeyframe`, 1262-1273); drag diamonds to retime, set per-key easing, set name/duration/FPS/loop (pose-studio.js:1275-1394).
  10. Scrub / play: drag the track or arrow keys; transport play/pause (Space), stop, jump start/end (Home/End), loop toggle. Playback slerp-interpolates poses via `sampleAtTime` (pose-animation.js:136).
  11. (optional) Import a pose JSON (`#pose-import-json`) → applies a single static pose (pose-studio.js:917-934).
  12. Completion paths: **Export JSON** clip (`serializeClip`); **Export GLB** with embedded clip (`bakeAnimatedGlb`); **Record in Scene →** (bakes GLB, stashes in IndexedDB, navigates `/scene?handoff=1`); **Save** to account (Ctrl/Cmd+S → PoseLibrary dialog, POST/PATCH `/api/animations/clips`); **Export pose JSON** (single pose) / **PNG screenshot**; **Sell** a saved clip for USDC from the "My animations" drawer (pose-studio.js:1408-1491; pose-library.js). Export buttons disabled until ≥1 keyframe (`refreshExportEnabled`, 1206-1211).
- **Decision points / branches:** Mannequin vs loaded GLB (changes bone-pick strategy, model-tuning availability, IK availability, preset/AI-library availability, and whether the saved clip links an `avatar_id`). Save vs Update vs Save-as-copy (PATCH existing clip vs POST new, pose-library.js:218-262). Four independent completion paths: Save (auth-gated) / Export / Sell (USDC) / Scene handoff. Boot branch on `?avatar=` and chained `?anim=`.
- **External calls / dependencies:** `GET /api/avatars/:id`; `GET /api/auth/me`; clip CRUD `POST/PATCH/DELETE/GET /api/animations/clips[/:id]` (mine + `include_public=true&visibility=public`); `POST /api/animations/thumbnail`; sell flow `POST /api/animations/presign` → R2 `PUT upload_url` → `POST /api/animations/sell` (USDC on Base or Solana); AI/preset clips `GET /animations/manifest.json`, `POST /api/forge-motion` + poll. Imports: pose JSON. Exports: pose JSON, clip JSON, animated GLB (`GLTFExporter` binary), PNG. Scene handoff: `putSceneHandoff({glb,name})` to IndexedDB, then navigate `/scene?handoff=1` (shared/scene-handoff.js). URL pose codec `#p=`/`?p=` (pose-share.js).
- **Success state:** HUD `#pose-status` confirmations ("Loaded …", "Keyframe added at Xs · N total", "Screenshot saved"); export buttons show busy → "Saved ✓"/"Opening ↗"; save → "Saved '…' to your account"; sell → "Listed '…' for N USDC".
- **Empty / error states:** Timeline `#tl-empty` "Pose the figure, then press K…" until a keyframe exists; mode-aware no-selection hint; bone search "No bones match"; library drawer "No animations yet" / "Sign in to see your animations"; AnimationLibrary "Load a rigged avatar"/"can't be retargeted"; boot idle "Ready. Click a body part to pose, or load an avatar." Errors (red HUD): avatar load failure, "no recognizable humanoid skeleton", import parse failure, "Add a keyframe first, then play", export "… failed"; library/API errors show inline `.pl-dialog-err` + Retry; `?avatar=` boot failure falls back to mannequin with explanation.
- **Step count:** ~6 required (arrive → select bone → FK pose → add keyframe → scrub/play → export) + ~7 optional (load/switch avatar, scene/model tuning, IK, preset pose, motion library/AI, import pose JSON, save/sell/scene-handoff/screenshot).

---

### glTF Validator — `/validation`
- **Source:** `public/validation/index.html`, `src/validation-page.js`, `src/validation-ui.js`, `src/validator.js`, `src/gltf-inspect.js`, `src/components/validator-report.jsx`, `src/components/inspect-report.jsx`, `src/erc8004/validation-recorder.js`, `src/erc8004/agent-registry.js`.
- **Entry point:** `public/validation/index.html` (module at lines 1040-1042) imports `ValidationDashboard` (validation-ui.js) and `ValidationPage` (validation-page.js); constructs the dashboard then the page (which references the dashboard for the on-chain hand-off). On construct, `ValidationPage` renders the Khronos sample chips, binds input events, and restores the active tab from the URL hash (validation-page.js:32-46).
- **Prerequisites / gates:** None to validate/inspect — runs fully client-side in the browser. The **Records / "Pin & sign on-chain"** path requires an Ethereum wallet (`ensureWallet` via ethers / `window.ethereum`, validation-ui.js:12) to sign + submit an on-chain attestation; that is the only gated sub-flow. No $THREE gate.
- **Steps (N):**
  1. Arrive at `/validation`. Three tabs: **Validate**, **Inspect**, **Records** (default `validate`, restored from `#validate|#inspect|#records`, validation-page.js:50-69).
  2. Provide a model — three input sources sharing one pipeline: drag-drop a GLB on the drop zone, pick a file via the file input, paste a URL and click the URL button (Enter also works), or click a Khronos sample chip (Box/Duck/BoomBox/DamagedHelmet/Avocado from jsdelivr) (validation-page.js:78-118).
  3. `_run(bytes, name)` fires both analyses in parallel (validation-page.js:145-189): the official Khronos validator (`Validator.validateBuffer` → `gltf-validator` `validateBytes`, validator.js:57-66) and the glTF-Transform inspector (`inspectModel` + `suggestOptimizations`).
  4. **Validate tab** renders the report (`ValidatorReport`) — error/warning/info/hint counts bucketed by severity, aggregated repeated codes, generator/asset metadata (validator.js:106-189; validation-page.js:191-198).
  5. **Inspect tab** renders glTF-Transform stats + optimization suggestions (`InspectReport`, validation-page.js:200-203).
  6. (optional) Download either report as JSON (`buildDownloadHref` data URI on each report panel).
  7. (optional) View the validation report in a standalone lightbox tab (`Validator.showLightbox`, validator.js:198-212).
  8. (optional, wallet) **Pin & sign on-chain**: `_handOffToDashboard` switches to the Records tab, opens the submit modal pre-filled with the in-memory report + its `hashReport` hash (no file re-pick), then `ValidationDashboard.submitReport` connects the wallet, pins to IPFS, and records the attestation (validation-page.js:221-242; validation-ui.js).
  9. **Records tab** (independent): enter agent id + chain id (or arrive via `?agent=&chain=`), **Load** past validation records (`getLatestValidation`), or **Submit** a new report by dropping/picking a report JSON file (validation-ui.js:33-79).
- **Decision points / branches:** Input source (file / URL / sample) — all converge on `_run`. Validate vs Inspect (run together, two tabs). In-memory hand-off to Records vs manual report-file submission. Records load (`?agent=&chain=` auto-loads) vs manual entry. On-chain submit requires wallet; validation/inspection do not.
- **External calls / dependencies:** `fetch(url)` for URL/sample inputs (validation-page.js:136); `gltf-validator` `validateBytes` (in-browser); `src/gltf-inspect.js` (glTF-Transform, in-browser). On-chain: IPFS pin (`pinFile`), `recordValidation` (validationRequest + validationResponse) / `getLatestValidation` (validation-recorder.js), `ensureWallet`/ethers + `window.ethereum`. Inputs: GLB (and glTF + external resources resolved from the dropped asset map). The Validate tab can read the GLTFLoader-cached ArrayBuffer when invoked from the viewer (validator.js:26-34). Outputs: JSON report download, on-chain attestation.
- **Success state:** Status line "Loaded <name> · <KB> · validated" (validation-page.js:184-187); rendered validate + inspect reports; **Pin & sign** button enabled once a report exists.
- **Empty / error states:** Initial — three empty tab panels with sample chips inviting input. While running — "Validating…" / "Inspecting…" loading rows. File read error → "Could not read file: …"; fetch error → "Could not fetch <name>: HTTP <status>"; validator failure → "Validator failed: …" inline; inspector failure → "Inspector failed: …" inline (validation-page.js:122-217). On-chain hand-off with no report → toast "Run a validation first" (validation-page.js:222-224).
- **Step count:** ~4 required (arrive → provide model → read Validate report → read Inspect report) + ~5 optional (download JSON, lightbox, pin & sign on-chain, browse records, submit report file).

---

### 3D Viewer / Editor (main app) — `/app`
- **Source:** `pages/app.html`, `src/app.js`, `src/viewer.js`, `src/editor/index.js`, `src/validator.js`, `src/account.js`, `src/wallet.js`, `src/erc8004/*`, widget mounts under `src/widgets/*`, `src/components/screenshot-modal.js`, `src/next-layout.js`.
- **Entry point:** `<script defer type="module" src="/src/app.js">` (app.html:57). `_bootApp()` constructs `new App(document.body, location)` and exposes `window.VIEWER.app` (app.js:2583-2596). The `App` constructor (app.js:162-401) parses hash + query into `this.options`, conditionally builds dropzone/avatar-creator/layout/nav, dispatches on route mode, then inits the agent system + widget bridge.
- **Prerequisites / gates:** No hard gate blocks the viewer — the default CZ avatar (or `?model=`/`?agent=` target) loads for everyone, anonymous included. The "gate" is presentation-only: in `main` mode `_applyViewerMode` sets `data-authed` (`pending`/`false`) and CSS (`public/style.css`:6589-6606) overlays the `.auth-gate` card and hides the agent sidebar + dat.GUI editor for anonymous/pending users (app.js:614-629); `getMe()` (`GET /api/auth/me`) reconciles to the real state (app.js:681-695). A wallet button exists (`initWalletButton`, eager `eagerConnectWallet`) but connecting is never required. **No $THREE token gate.** "Save to account" and "Save edits" redirect to `/login` when signed out. The dat.GUI editor only exists once a model has loaded (built by the viewer on content load).
- **Steps (N):**
  1. Arrive at `/app`. Constructor dispatches by mode; `_maybeResumeOrLoad(options)` runs for the default path (app.js:378, 408-458).
  2. A model auto-loads: `?resume=<token>` restores a stashed editor session (optional), else `options.model || '/avatars/cz.glb'`; the default CZ avatar crossfades into a "taunt" landing clip (app.js:451-486).
  3. Viewer renders via `view()` → WebGL check, `createViewer()`, `viewer.load(url, …)` with a progress callback, then attach avatar, notify editor, configure animations, set AR target, run validator (app.js:1783-1876).
  4. (optional) Load your own model — drag-drop a `.glb`/`.gltf` or folder anywhere on `.wrap` (`SimpleDropzone` → `load(files)`, app.js:1708-1776); or the `#file-input` picker; or `?model=<url>`/`#model=` (host-validated by `isSafeQueryModelUrl` for the deploy path, app.js:25-38); or `?agent=<uuid>`.
  5. (optional) Open the editor controls (dat.GUI / Next-layout drawer): **Display** (background, autoRotate, wireframe, skeleton, grid, point size, transparent bg, screenshot, model info, mesh labels), **Lighting** (IBL/envMap, exposure, tone mapping, punctual lights), **Light Probes**, **Animation**, **Morph Targets**, **Cameras**, **Agent** follow mode, **Performance** stats (viewer.js `addGUI`).
  6. (optional) Play animations: `_configureAnimations` fetches `/animations/manifest.json`, registers clips, honors `?anim=<name|uuid>`; Next-layout dock gives clip picker + play/pause + scrubber + loop. When an agent is loaded, its per-slot gesture overrides (`meta.edits.animations`, written by `PUT /api/agents/:id/animations` with `animationSlots`) are applied via `setAnimationMap`; the `/gestures` page documents the slot vocabulary.
  7. (optional) Edit environment / lights / camera / display via the GUI (`updateEnvironment`, `updateLights`, `setCamera`, `frameContent`, etc. in viewer.js).
  8. (optional) Edit materials / textures / scene via the `Editor` (`MaterialEditor`, `TextureInspector`, `SceneExplorer`, `MagicBrush`; rebuilt on each new model, editor/index.js:19-55).
  9. (optional) Take a screenshot → `viewer.captureScreenshot()` → `ScreenshotModal.show(blob)` (app.js:825-837).
  10. (optional) Export GLB → editor export folder → `exportEditedGLB(session)` → `downloadGLB(...)`; also a postMessage `exportGLB` bridge returns base64 GLB to a parent frame (editor/index.js:57-129; app.js:1498-1526).
  11. (optional) Save edits / save model to account — editor `_saveEdits` (R2 presign+upload+PATCH) or header "Save to account" (`_triggerSaveToAccount` → if signed out, stash + `/login?next=/app?pending=1`; if signed in, `_performSave` saves the GLB, creates/links an agent, redirects to `/agent/<id>`, app.js:839-974).
  12. (automatic) Validate — `validator.validate(...)` runs on every non-kiosk load; surfaces a `.validator-toggle` badge + lightbox (app.js:1872; validator.js).
  13. (optional) Cross-links — "Make this a widget" → `/studio?model=<url>`; "Open in Composer" → `/compose?glb=<url>`; "Deploy on Solana" → guided on-chain deploy agent `/app?agent=67bf6e67-…` (app.js:759-810).
  14. (optional) Chat with the agent — `_initNichAgent` mounts the NichAgent chat/voice UI + thought bubble (skipped in widget/kiosk/deploy/showcase, app.js:1633-1648).
- **Decision points / branches:** Route mode dispatch (app.js:288-394): kiosk/embedChat (chromeless), `/deploy` (RegisterUI wizard), `/showcase` (marketplace grid), on-chain `/a/<chain>/<id>` (anonymous-safe), legacy `#agent=` embed, chat embed `/a/<uuid>?embed=1`, `#widget=<id>` (slim shell vs full SPA, type-specific mounts), `?agent=<uuid>` authenticated agent-edit, else default `_maybeResumeOrLoad`; `?pending=1` replays a stashed post-login save. Anonymous vs signed-in (auth-gate overlay + save gating only). Classic vs Next layout (localStorage toggle). File-drop vs URL vs agent vs on-chain model source.
- **External calls / dependencies:** `GET /api/auth/me`, `POST /api/auth/logout`, `GET /api/avatars/<id>`, `GET /api/agents/<id>`, `GET /api/agents/me`, `POST /api/agents`, `PUT /api/agents/<id>`, `POST /api/avatars/thumbnail`, `POST /api/widgets/<id>/view`, `GET /animations/manifest.json` + `HEAD /animations/*.glb`; `saveRemoteGlbToAccount` (R2 presign/upload/commit); editor save (R2); on-chain dynamic imports (`erc8004/queries|abi|register-ui|showcase`) + Solana/ETH RPC; IPFS/Arweave URL resolution (`ipfs.js`). Imports: glTF/GLB (+ textures). Exports: binary GLB; PNG screenshot; AR uses USDZ (iOS) + GLB (Android). Validator: in-browser `gltf-validator`.
- **Success state:** `LOAD_END(success)` fades the poster, hides the status overlay, fires `three-ws:first-frame`, runs first-time onboarding (agent-edit), backfills a missing thumbnail (app.js:2033-2066). Model renders, orbitable; editor + agent sidebar available for signed-in users.
- **Empty / error states:** No true empty void — the CZ default always loads. Anonymous main mode shows the `.auth-gate` card ("Your agent lives here — Sign in…") with sidebar/GUI hidden; the dropzone invites upload/generate. Loading: spinner/determinate progress bar (`_showViewerLoading`/`_updateLoadProgress`) + poster thumbnail for agent-edit. Errors: `_classifyLoadError` → human message + Retry (`_showViewerError`, app.js:2090-2181); "No .gltf or .glb asset found." on bad drop; `_showWebglUnavailable` reload card; `_showWidgetError`; on-chain `_showOnChainError`/`_updateOnChainCard`.
- **Step count:** ~3 required (arrive → model auto-loads → view/orbit) + ~11 optional (load own model, GUI controls, animations, env/lights/camera, material/texture editing, screenshot, export GLB, save to account, validate review, cross-links, agent chat).

---

### Hydrate (import on-chain agents) — `/hydrate`
- **Source:** `public/hydrate/index.html` (self-contained inline module — no `src/` entry). NOTE: this is an on-chain agent **import** flow, not a 3D viewer/editor; it sits in this cluster only by route adjacency. Its product purpose is "attach a 3D body, voice, and skills to an existing on-chain agent."
- **Entry point:** Inline `<script type="module">` at hydrate/index.html:334. On load, `loadAgents()` runs: `checkAuth()` (`GET /api/auth/wallets`) then `fetchDiscoveredAgents()` (`GET /api/erc8004/hydrate`).
- **Prerequisites / gates:** **Wallet gate.** `checkAuth()` requires an authenticated session with ≥1 connected wallet; otherwise the auth prompt ("connect a wallet first" → `/dashboard/account#wallets`) is shown and no agents load (hydrate/index.html:378-417). No $THREE gate.
- **Steps (N):**
  1. Arrive at `/hydrate`. `loadAgents()` runs.
  2. Auth/wallet check — `GET /api/auth/wallets`. If unauthenticated or no wallets → show auth prompt and stop.
  3. Loading state — "Fetching your agents…" while `GET /api/erc8004/hydrate` resolves the wallets' on-chain agents (hydrate/index.html:419-422).
  4. Discovered agents render as cards (image, name, chain badge, description, agent id) (hydrate/index.html:439-465).
  5. For each agent: if already imported → "Go to agent →" link to `/dashboard/?agent=<id>`; else an **Import** button.
  6. Click **Import** → `importAgent()` → `POST /api/erc8004/import` ({chainId, agentId}); on success the button is replaced with a "Go to agent →" link and a success alert shows (hydrate/index.html:475-491).
- **Decision points / branches:** Authenticated+wallet vs not (auth prompt). API not running / non-JSON response → treated as unauthenticated (graceful, hydrate/index.html:389-393). Per-agent: already-imported (link) vs importable (button). Zero discovered agents → empty state.
- **External calls / dependencies:** `GET /api/auth/wallets` (auth + wallet list), `GET /api/erc8004/hydrate` (discover on-chain agents), `POST /api/erc8004/import` (import one). No 3D asset loading on this page. Links to `/deploy`, `/dashboard/`.
- **Success state:** Imported agent's button becomes "Go to agent →" + success alert "Successfully imported <name>!" (hydrate/index.html:487-491).
- **Empty / error states:** Not authed / no wallets → auth prompt block. Zero agents → empty state "No on-chain agents found for your wallets." + register-at-`/deploy` hint. Discovery failure → red alert "Failed to load agents: …". Import failure → error alert from the API's `error_description`.
- **Step count:** ~4 required (arrive → auth/wallet check → discover → import) + 0 optional (the "Go to agent" link is a navigation exit, not a step).

---

### Artifact Viewer (Claude artifact bundle preview) — `/artifact`
- **Source:** `public/artifact/index.html` (self-contained inline module — no `src/` entry), backend `api/artifact`. NOTE: product purpose is "Embed your agent in Claude.ai" — it previews the standalone HTML artifact bundle that `/api/artifact` generates, not a glTF model.
- **Entry point:** Inline `<script type="module">` at artifact/index.html:585. On load, `init()` reads `?agentId=` and, if present, auto-runs `generate()` (artifact/index.html:754-760).
- **Prerequisites / gates:** None on the page. Validity depends on a real agent id resolving server-side at `/api/artifact`. No auth/wallet/$THREE gate on the page itself (`fetch(..., { credentials: 'omit' })`).
- **Steps (N):**
  1. Arrive at `/artifact` (optionally with `?agentId=`).
  2. Enter an **Agent ID** (UUID or handle); optionally set theme (light), idle behavior, and a 6-hex background color (artifact/index.html:633-643).
  3. Click **Generate** (or Enter) → `buildUrl()` assembles `/api/artifact?agent=…&theme=…&idle=…&bg=…`, updates the address bar, and fetches the artifact HTML (artifact/index.html:652-687).
  4. On success: compute size, TTFP, and CSP-sandbox compliance (checks `frame-ancestors *` in the response CSP), show the stats panel (color-coded ok/warn/bad), and render the artifact via `iframe.srcdoc` (artifact/index.html:688-715).
  5. (optional) **Reload** re-fetches; **Copy URL**; **Copy raw HTML** (with byte size); **Open** in a new tab.
  6. (optional) The page fetches a reference CSP from `simonw/scrape-claude-artifacts` for the documented Claude.ai sandbox policy, with a documented fallback if unreachable (artifact/index.html:740-752).
  7. Copy the generated **Claude snippet** ("Here's my agent for this conversation:\n<url>") to paste into Claude.ai (artifact/index.html:713-714).
- **Decision points / branches:** `?agentId=` present → auto-generate vs manual entry. Fetch network error vs non-OK HTTP vs success. Size/TTFP/sandbox stats branch into ok/warn/bad styling. CSP reference fetch success vs fallback copy.
- **External calls / dependencies:** `GET /api/artifact?agent=…` (the artifact bundle, `credentials: 'omit'`); `GET` raw CSP doc from raw.githubusercontent.com (reference only). Output: the artifact HTML rendered in an iframe; copy-to-clipboard URL/HTML/snippet. No 3D file import/export.
- **Success state:** Stats panel populated (size/TTFP/sandbox), artifact rendered in `#previewFrame`, action buttons enabled, snippet shown.
- **Empty / error states:** Initial — "Enter an agent ID and press Generate" overlay; snippet placeholder "Generate to see the snippet…". No id → "Enter an agent ID first." error overlay. Network error → "Network error: <msg>". Non-OK → server `error_description`/`error`/`HTTP <status>` shown in the overlay. CSP fetch failure → documented fallback text.
- **Step count:** ~3 required (arrive → enter agent id → Generate) + ~4 optional (theme/idle/bg options, reload, copy URL/HTML/snippet, open in tab).

---

### Avatar Artifact (standalone procedural avatar) — `/avatar-artifact`
- **Source:** `pages/avatar-artifact.html` (fully self-contained; CDN Three.js r128 via cdnjs with SRI; no `src/` module, no model load, no API). NOTE: this is a "standalone Three.js viewer for avatar artifacts — embeddable and shareable without any wrapper page" (page OG meta). The geometry is procedurally built in-page (cylinders/spheres/boxes forming a stylized portrait), not loaded from a GLB.
- **Entry point:** Inline `<script>` at avatar-artifact.html:271. After the CDN three.js `<script>` loads, the script guards on `window.THREE` + WebGL, then builds scene/camera/renderer/lights/materials and the procedural avatar group, and starts the `animate()` RAF loop (avatar-artifact.html:271-303, 603).
- **Prerequisites / gates:** None. No auth, wallet, $THREE gate, model load, or API. Renders immediately on a successful runtime + WebGL context.
- **Steps (N):**
  1. Arrive at `/avatar-artifact`. Loading overlay shows while the CDN three.js runtime loads.
  2. Runtime + WebGL guard — if three.js never arrives (`onerror`) or `window.THREE` is missing, or WebGL context creation throws, the designed error state is shown (`window.__avatarArtifactFailed`, avatar-artifact.html:257-298).
  3. On success the procedural avatar renders; the loading overlay fades out on first frame (avatar-artifact.html:663-669).
  4. Interact — the avatar's gaze follows the mouse (`mousemove`), touch drag (`touchmove`), or keyboard (arrow keys / WASD nudge the gaze; canvas is `tabIndex=0`, `role="img"`, ARIA-labeled, KEY_STEP 0.25) (avatar-artifact.html:543-589).
  5. The canvas continuously animates (idle motion, blink) and stays responsive to resize/orientation change (avatar-artifact.html:685-686).
- **Decision points / branches:** Runtime available + WebGL OK (render) vs runtime/WebGL failure (error state). Coarse pointer (phones/tablets) → lighter render (lower DPR, no shadow pass, avatar-artifact.html:286-302). Pointer/touch input vs keyboard gaze control.
- **External calls / dependencies:** CDN `three.min.js` r128 from cdnjs (with SRI integrity + `crossorigin`); `/api/page-og` for OG/Twitter share images (meta only). No model import/export, no platform API, no glTF validator.
- **Success state:** Animated procedural avatar that tracks cursor/touch/keys; loading overlay faded out.
- **Empty / error states:** Loading overlay (`#loading`) during runtime load; designed error overlay (`#error`) when the CDN runtime fails or WebGL is unavailable. No empty "no model" state — the avatar is always present once the runtime loads.
- **Step count:** ~3 required (arrive → runtime/WebGL OK → avatar renders) + ~1 optional (interact via cursor/touch/keyboard).
