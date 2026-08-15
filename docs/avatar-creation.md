# Avatar Creation

Your agent's 3D avatar is what makes it feel real. It is the face people see, the presence they interact with, and the body that expresses emotions, gestures, and personality. This guide covers every way to create one.

---

## Choosing a path

| Path | Time | Skill required | Best for |
|------|------|----------------|----------|
| Photo → AI avatar | 3–5 min | None | A realistic avatar that looks like you |
| Avatar builder | 10–20 min | None | A stylized avatar with full creative control |
| Upload your own GLB | 1 min | 3D modeling | An existing model from Blender, Mixamo, or any 3D tool |

Pick one and follow its section below. All three paths produce a GLB file that gets saved to your account.

---

## Path 1: Photo-to-avatar

The fastest way to get a personalized 3D avatar is to take a set of photos and let the three.ws AI generate a realistic model from them.

### What you need

At minimum, one clear photo of your face:
- **Frontal** (required): face the camera straight on, neutral expression
- **Left / Right** (optional): turn your head about 45° each way; extra angles improve the likeness

Good lighting and a plain background give the best results. Photos can be JPEG or PNG. The reconstruction is a face pipeline, so a headshot works far better than a full-body shot.

### Steps

1. Go to **https://three.ws/create** and pick the selfie path (or open **https://three.ws/create/selfie** directly)
2. Choose **Camera** (to take live photos in-browser) or **Upload** (to pick files from your device)
3. Fill the frontal slot; add left/right photos if you have them
4. Select your preferred **body type** (male / female) and **avatar style** (v1 = Photoreal, v2 = Stylized)
5. Click **Submit**

The photos are downscaled in the browser and sent to the native avatar reconstruction backend. A build view shows progress while the rigged GLB renders (typically a minute or two); when the job finishes, the avatar is saved to your three.ws account automatically and opens for review.

### What if camera access doesn't work?

If your browser or device doesn't support `getUserMedia`, the Camera option is disabled automatically and a message is shown. Use the Upload option instead — it accepts any JPEG or PNG file.

### Technical flow

For developers who want to understand what happens under the hood:

1. [selfie-capture.js](../src/selfie-capture.js) manages the two-step UI: method choice (camera vs upload) and the photo slots (frontal required, sides optional). On submit it dispatches a `selfie:submit` CustomEvent with `{ files, bodyType, avatarType }`.
2. [selfie-pipeline.js](../src/selfie-pipeline.js) handles that event: it runs an on-device photo check and refinement pass ([selfie-refine.js](../src/selfie-refine.js)), downscales each photo to a max of 1024px as JPEG, then POSTs to `/api/avatars/reconstruct` with the photos and body/style preferences.
3. The endpoint returns a `jobId`. The pipeline dispatches `selfie:building` and polls `/api/avatars/regenerate-status?jobId=...` every 3 seconds, dispatching `selfie:progress` ticks the build view renders.
4. On `{ status: 'done', resultAvatarId }` it dispatches `selfie:done { avatarId }`. The avatar record and its GLB in R2 storage were created server-side, so nothing else needs to be uploaded. Failures dispatch `selfie:build-error` with a message and, when detectable, the photo slot that caused it.

A separate photo-avatar SDK path (`AvatarCreator` in [src/avatar-creator.js](../src/avatar-creator.js) with a session from `/api/onboarding/avaturn-session`) still exists for the third-party editor integration; the selfie flow above is the default one on /create.

---

## Path 2: Avatar builder

The three.ws avatar builder is a browser-based tool for full creative control, no photo required.

### Access

Open **https://three.ws/avatar-studio**, or start from **https://three.ws/create** (the builder opens in a modal inside the main app). It is a separate React application embedded via iframe. Note: `/studio` is Widget Studio, the embed-snippet builder, a different tool.

### What you can customize

- Body type and proportions
- Skin tone
- Hair style and color
- Eyes
- Clothing (shirts, jackets, pants, and more)
- Accessories (glasses, hats, and more)

Changes appear in the real-time 3D preview immediately. When you are satisfied, click **Export** to send the GLB back to the main app.

### Technical notes

Avatar Studio communicates with the parent app via `postMessage`. The message shape is:

```js
{ source: 'characterstudio', type: 'export', glb: ArrayBuffer }
```

[avatar-creator.js](../src/avatar-creator.js) listens for this, wraps the `ArrayBuffer` in a `Blob`, and passes it to `saveRemoteGlbToAccount()`.

The avatar builder is served **same-origin** from `/avatar-studio/index.html`: the Vite dev middleware serves the character-studio build under that path in development, and the same build ships there in production, so the iframe resolves correctly on every deployment. The index file is named explicitly because the bare `/avatar-studio` path is routed to the native sculpting page. Set the `VITE_CHARACTER_STUDIO_URL` environment variable to point the iframe at a standalone studio dev server (e.g. `http://localhost:5173/avatar-studio/`) instead.

---

## Path 3: Upload your own GLB

If you already have a 3D model — from Blender, Maya, Mixamo, or anywhere else — you can upload it directly.

### Steps

1. Open **https://three.ws/app**
2. Drag and drop your `.glb` file onto the viewer, or use the file picker in the editor
3. The model loads and validates automatically
4. Save to your account via the editor toolbar

The three.ws viewer accepts any valid glTF 2.0 binary (`.glb`) file. If your model has features like facial blend shapes and a humanoid skeleton, the full emotion and gesture system activates. If it doesn't, the viewer degrades gracefully — no crash, just no facial animation.

### Converting from other formats

| Source format | How to convert |
|---------------|----------------|
| FBX | Blender: File → Import → FBX, then File → Export → glTF 2.0 (.glb) |
| OBJ | Blender: File → Import → Wavefront, rig if needed, export as glTF |
| VRM | VRM files are glTF 2.0 under the hood — rename `.vrm` to `.glb` and it loads |
| Other avatar platforms | Most humanoid avatar tools (Mixamo, VRoid Hub, etc.) export GLB and are compatible out of the box |
| FBX via script | `/scripts/convert-fbx-to-glb.py` is available for batch conversion |

---

## Avatar requirements for full feature compatibility

The viewer works with any GLB. The table below shows what each feature needs:

| Feature | Requirement |
|---------|-------------|
| 3D display | Any valid GLB |
| Facial expressions | Morph targets (blend shapes) — see names below |
| Head tilt and lean | `Head` or `Neck` bone in the skeleton |
| Gesture animations | Named animation clips embedded in the GLB |
| Emotion blending | Morph targets AND Head/Neck bone together |
| AR view | Any GLB — converted automatically |

### Morph target names

three.ws follows the **ARKit-52** facial blendshape standard ([Apple ARKit reference](https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation)). Conformant avatars work end-to-end with the Empathy Layer, lip-sync, and any future face-tracking driver. The full canonical name list and runtime resolver live in [src/runtime/arkit52.js](../src/runtime/arkit52.js).

**The Empathy Layer drives this subset:**

| Morph target | Driven by |
|---|---|
| `mouthSmileLeft` / `mouthSmileRight` | Celebration (happiness) |
| `jawOpen` | Celebration + talking |
| `mouthFrownLeft` / `mouthFrownRight` | Concern |
| `mouthPressLeft` / `mouthPressRight` | Uncertain / hedged |
| `browInnerUp` | Concern + empathy |
| `browOuterUpLeft` / `browOuterUpRight` | Curiosity |
| `eyeSquintLeft` / `eyeSquintRight` | Empathy |
| `eyeBlinkLeft` / `eyeBlinkRight` | Patience (subtle) |
| `cheekPuff` | Celebration |
| `noseSneerLeft` / `noseSneerRight` | Concern |

Visemes (`viseme_aa`, `viseme_E`, `viseme_O`, `viseme_PP` …) drive lip-sync — see [src/runtime/lipsync.js](../src/runtime/lipsync.js).

**Alias resolution.** The runtime accepts these common alternatives and maps them to the canonical name automatically — no need to rename morphs in your DCC:

- `snake_case`: `mouth_smile_left`, `brow_inner_up`, `jaw_open` …
- `_L` / `_R` suffixes: `mouthSmile_L`, `eyeBlink_R`, `browOuterUp_L` …
- Combined shapes: a single `mouthSmile` morph fans out to both `mouthSmileLeft` and `mouthSmileRight` slots when the canonical pair is absent.
- Older shorthand: `mouthOpen` → `jawOpen`, `eyesClosed` → `eyeBlinkLeft` (mirrored).

All influences are lerped smoothly every frame (speed ~4.0). Missing targets are silently skipped — you don't need all 52 to ship an avatar, but the more you implement the richer the expression. Use `conformanceReport()` in [src/runtime/arkit52.js](../src/runtime/arkit52.js) to audit a model.

### Skeleton naming

The system recognises common humanoid naming conventions. Any of these will work for the head bone:

- `Head`
- `mixamorigHead`
- `Armature:Head` / `rig_Head`
- `CC_Base_Head`

The same stripping logic applies to the Neck bone. If both exist, `Head` is preferred.

### Animation clip names

Gesture clips are triggered by name. The system does a case-insensitive partial match, so a clip named `WaveLeft` will be found by a `wave` trigger. Recommended clip names for built-in gesture slots:

- `idle` — continuous background animation
- `talk` — mouth movement while speaking
- `nod` — brief affirmation
- `wave` — greeting gesture
- `think` — contemplative pose
- `celebrate` — celebration animation
- `concern` — worried or cautious pose

---

## Regenerating an avatar

After saving an avatar you can trigger a regeneration — a new pass over the mesh, textures, rig, or appearance — without starting from scratch.

Open the editor for your avatar and click the **Regenerate** button. The regeneration panel ([src/editor/regenerate-panel.js](../src/editor/regenerate-panel.js)) offers four modes:

| Mode | What it does |
|------|-------------|
| Re-mesh | Regenerates the topology (polygon structure) |
| Re-texture | Regenerates materials and textures |
| Re-rig | Regenerates the skeleton binding |
| Re-style | Applies a new appearance from a text description |

Each mode accepts optional parameters as a JSON object. The job runs asynchronously and the panel polls for completion every 3 seconds.

**Note:** Re-mesh, re-texture, and re-rig need a platform ML backend. If the panel shows a "Mesh regeneration needs a backend" banner, the deployment has no regeneration provider configured: set `AVATAR_REGEN_PROVIDER` to `replicate`, `huggingface`, or `gcp` (plus the matching API token) in the server environment.

---

## Accessories

Accessories are layered on top of an avatar without modifying the underlying GLB. They are managed by `AccessoryManager` ([src/agent-accessories.js](../src/agent-accessories.js)).

### How accessories work

Each accessory is either:
- A **separate GLB** attached to a named skeleton bone at runtime, or
- A **morph binding** — a name-to-weight map applied to the avatar's existing blend shapes

Accessory state lives in `agent_identities.meta.appearance` and is restored automatically when the agent loads.

### Slots and conflict rules

| Kind | Limit | Notes |
|------|-------|-------|
| Outfit | One at a time | Replaces the previous outfit |
| Hat | One at a time | Replaces the previous hat |
| Glasses | One at a time | Replaces the previous glasses |
| Earrings | Stackable | Multiple earring accessories can coexist |

The accessory library is served from `/accessories/presets.json`.

---

## Naming your agent

After the avatar is created, set the agent's name. The name appears on the identity card, embed headers, and Open Graph metadata when the agent is shared.

The naming UI ([src/agent-naming.js](../src/agent-naming.js)) validates your input as you type:

- **3–32 characters**
- Letters, numbers, underscores (`_`), and hyphens (`-`) only
- Names are checked for availability against the server in real-time
- Reserved words (admin, root, system, etc.) are blocked

You can also add an optional description (up to 280 characters) which is shown in the agent's public profile.

---

## Saving and publishing

Once your avatar and name are set:

### 1. Save to account (always)

Saving stores the GLB in R2 storage and creates an avatar record in your account. This is free and required before publishing. The avatar is private by default.

### 2. Publish (optional)

Publishing makes the agent publicly accessible and discoverable. The publish flow ([src/editor/publish-modal.js](../src/editor/publish-modal.js)) walks through four steps:

| Step | What happens |
|------|-------------|
| Export | Packages the current editor state |
| Upload | Pushes assets to storage |
| Register | Creates the public agent record |
| Widget | Generates embed snippets |

On success, you receive:
- A **share link** to the agent's public page
- An **iframe snippet** to embed in any website
- A **web component snippet** for use in supported frameworks

### 3. Register on-chain (optional)

For permanent, verifiable identity, you can register the agent on-chain under ERC-8004. This creates a blockchain record linked to a wallet address. Gas fees apply. See the [ERC-8004 documentation](erc8004.md) for details.

---

## Developer spec: targeting the avatar format

If you are building a tool that generates avatars for three.ws (a pipeline, a custom studio, a converter), target this specification:

| Property | Target |
|----------|--------|
| Format | GLB (binary glTF 2.0) |
| Skeleton | Humanoid rig — Mixamo or VRM-compatible bone naming |
| Animations | Named clips embedded at the root level of the GLB |
| Blend shapes | See morph target table above |
| Textures | PNG (with alpha if needed) or JPEG; KTX2 recommended for production |
| Polygon count | Under 100k triangles for smooth mobile performance |
| File size | Under 20 MB for fast loading; under 5 MB with Draco compression |
| Coordinate system | Y-up, right-handed (glTF default) |

### Communicating with the app

If your tool runs inside an iframe under the `AvatarCreator` modal, send a postMessage when the user exports:

```js
// From inside your iframe
window.parent.postMessage({
  source: 'characterstudio',
  type: 'export',
  glb: arrayBuffer  // ArrayBuffer of the GLB bytes
}, parentOrigin);
```

If your tool uses the photo avatar SDK path, fire the `export` event with `{ url, urlType }` via the photo pipeline postMessage protocol.

---

## Troubleshooting

**My avatar loads but has no facial expressions**
The model is missing morph targets. Export from Blender with "Shape Keys" enabled, or use the three.ws avatar builder or photo pipeline — both include blend shapes by default.

**Head movement doesn't work**
The skeleton doesn't have a bone named `Head` or `Neck` (or a supported variant). Rename the bone in Blender or your DCC, or check for prefix issues (`mixamorigHead` is fine; `armature_root_Head` is not matched).

**The avatar is too large / loads slowly**
Apply Draco compression in Blender (File → Export glTF → Compression) or with `gltf-pipeline -i model.glb -o model-draco.glb --draco.compressMeshes`. Target under 5 MB for embedded use.

**The Camera option is greyed out on the selfie page**
Your browser or device doesn't support `getUserMedia`. This is common on HTTP (non-HTTPS) connections and some desktop browsers. Use the Upload option instead.

**The regeneration panel says mesh regeneration needs a backend**
No regeneration provider is configured on this deployment. Set `AVATAR_REGEN_PROVIDER` (`replicate`, `huggingface`, or `gcp`) and the matching API token in the server environment.

---

## Related

- [Avatar pipeline](/docs/avatar-pipeline): the end-to-end generate / rig / retarget map
- [Selfie to avatar reconstruction](/docs/avatar-reconstruction): how the photo pipeline works inside
- [Animations](/docs/animations): the clip library your avatar drives once rigged
- [ERC-8004 identity](/docs/erc8004): registering the finished agent on-chain
