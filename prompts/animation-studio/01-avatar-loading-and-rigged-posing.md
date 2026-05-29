# Task 1 — Load rigged avatars into /pose and pose real skeletons (gizmos + IK)

> Read `prompts/animation-studio/00-README.md` first — it has the shared architecture, file
> references, data shapes, and the non-negotiable rules. Follow `CLAUDE.md`. No mocks, no stubs,
> wire 100%, design every state, verify in a real browser.

You are extending the existing Pose Studio at `/pose` so it can pose **real rigged 3D avatars**,
not just the built-in primitive mannequin. This is the foundation the keyframe timeline (Task 2)
builds on, so the posing API you expose must be clean and skeleton-agnostic.

## Outcome

A user opening `/pose` can:
1. Keep using the built-in primitive **mannequin** (current behavior) — this stays the default
   when no avatar is requested.
2. Load a **rigged GLB avatar** via the `?avatar=<id>` URL param (works for demo avatar ids like
   `avatar_demo_disk_saga` and for real avatar ids), and via a **"Load avatar"** button that opens
   the existing avatar gallery picker (their own avatars when signed in, public/demo otherwise).
3. **Pose the loaded rig**: select a bone, rotate it with on-screen **gizmos** (TransformControls)
   and fine sliders, and use **inverse kinematics** — drag a hand or foot and the limb chain solves.
4. Reset pose, switch back to the mannequin, and read clear status/empty/error states throughout.

## What to build

### 1. Read the existing code first
- [src/pose-studio.js](../../src/pose-studio.js), [src/pose-mannequin.js](../../src/pose-mannequin.js),
  [pages/pose.html](../../pages/pose.html). Understand `setupScene()`, the render loop, the
  raycaster/drag posing, the control panel, and the pose JSON shape.
- [src/viewer.js](../../src/viewer.js) (~841–887) for the **GLTFLoader + Draco/KTX2/Meshopt decoder
  setup** — reuse this exact decoder configuration. Do not create a bare loader.
- [src/avatar-gallery-picker.js](../../src/avatar-gallery-picker.js) — the picker you'll mount.
- [src/avatar-export.js](../../src/avatar-export.js) for `normalizeBoneName()` — reuse it.
- [api/_lib/demo-avatars.js](../../api/_lib/demo-avatars.js) for demo ids to test with.

### 2. A skeleton-agnostic "rig" abstraction
Introduce a small module (e.g. `src/pose-rig.js`) that presents a **uniform posing interface**
over either the primitive `Mannequin` or a loaded skinned GLB:

- `getBones()` → ordered list of posable bones with a canonical key (use `normalizeBoneName()`),
  a display label, and the underlying `THREE.Bone`/joint.
- `getBoneQuaternion(key)` / `setBoneQuaternion(key, quat)` and Euler convenience getters/setters.
- `getRootPosition()` / `setRootPosition(vec)` (Hips/pelvis translation).
- `getPose()` / `applyPose(pose)` / `resetPose()` returning a **canonical pose object** keyed by
  normalized bone names with quaternions (so Task 2 can keyframe any rig uniformly). For the
  primitive mannequin, map its 16 joints onto the canonical names (pelvis→Hips, head→Head,
  shoulderL→LeftArm, etc.) so both paths produce the same pose shape.
- A `bindToTarget` for IK chains (see below).

The point: Task 2's timeline records `getPose()` snapshots and never needs to know whether it's a
mannequin or a real avatar.

### 3. Avatar loading
- On boot, read `?avatar=<id>` from the URL. If present, fetch the avatar's GLB URL and load it:
  - For ids starting with `avatar_demo_`, resolve via the demo-avatars source / the public avatar
    API. For real ids, use `GET /api/avatars/public` (and `GET /api/avatars` with
    `credentials: 'include'` when signed in). Resolve to `model_url`.
  - Load with the reused GLTFLoader+decoders. On success, frame the camera to the model, swap the
    rig abstraction to the GLB skeleton, and remove/hide the primitive mannequin.
- **"Load avatar" button** in the toolbar → `new AvatarGalleryPicker({ source: <'mine' if signed
  in else 'public'>, onSelect })`. On select, load that `model_url` and update the URL (`?avatar=`)
  without a full reload (history pushState) so the state is shareable.
- A **"Mannequin"** option to return to the default primitive rig.
- Handle every state: loading (skeleton/spinner with real progress from GLTFLoader `onProgress`),
  error (failed fetch / non-rigged GLB → actionable message), empty (signed-out user opening the
  picker sees public/demo avatars with a sign-in hint).

### 4. Posing UX (the craftsmanship)
- **Gizmos:** integrate `three/examples/jsm/controls/TransformControls.js` in rotate mode on the
  selected bone. Disable `OrbitControls` while dragging the gizmo (`dragging-changed` event).
- **IK:** integrate `three/examples/jsm/animation/CCDIKSolver.js`. Define IK chains for the four
  limbs (shoulder→forearm→hand with a hand target; upper-leg→leg→foot with a foot target). Add
  draggable IK target handles so the user can pull a hand/foot and the chain solves. Provide a
  toggle between **FK** (rotate individual bones) and **IK** (drag end-effectors) posing modes.
  For the primitive mannequin, map IK chains onto its joints too (best-effort) or cleanly disable
  IK with an explanatory tooltip if a chain can't be built — never leave a dead toggle.
- **Bone selection:** keep raycast click-to-select; also add a searchable bone list in the panel
  for rigs with many bones. Highlight the selected bone.
- **Sliders:** keep per-axis fine rotation for the selected bone, driven by the rig abstraction.
- **Presets:** keep the existing presets working for the mannequin; for real rigs, apply presets
  by mapping canonical bone names (skip bones the rig lacks).
- Preserve PNG export.

### 5. UI/UX + accessibility
- Match the page's existing dark design tokens / CSS variables. Add hover/active/focus states and
  ARIA labels to every new control. Keyboard: `F`/`I` to toggle FK/IK, `R` to reset selected bone,
  `Esc` to deselect — show these in a small shortcuts hint.
- Mobile-considerate layout (panels collapse at narrow widths).

## Definition of done
- `?avatar=avatar_demo_disk_saga` loads a real rigged avatar into `/pose`; "Load avatar" picker
  works; "Mannequin" returns to default — all verified in the browser with no console errors.
- A user can select a bone, rotate it via gizmo + sliders, and drag a hand/foot with IK to repose
  the limb. FK/IK toggle works; no dead controls.
- `getPose()` returns a canonical, normalized pose object for **both** mannequin and GLB rigs
  (verify by logging two snapshots). This is the contract Task 2 consumes.
- Loading/empty/error states all designed and reachable. Network tab shows real avatar fetches.
- `npm test` still green. Run the `completionist` subagent on changed files; fix all findings.
- Leave a short handoff note: the rig API surface (method names) Task 2 should call.

Do **not** build the timeline, saving, or monetization here — those are Tasks 2, 4, 6.
Do not push unless the user explicitly approves (then push to both remotes per CLAUDE.md).
