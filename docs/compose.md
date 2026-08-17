# Scene Composer: dress an avatar and stage a scene

Scene Composer is a real-time multi-object 3D editor built around one idea: bring a character in, generate props for it from text, and attach them to the right place on its body. Load one of your three.ws avatars (or any rigged GLB), type "horned crown" or "magic staff", and the item is forged and dropped into the scene. Pick it up, snap it to the avatar's head or hand bone, scale it, and it rides that bone. Then export the whole staged scene as a GLB, or save the attached items back onto the avatar as a reusable outfit.

Page: [/compose](https://three.ws/compose)

## Why it exists

Generating a character and generating a hat are easy in isolation. Making the hat sit on the head, follow it when the character moves, and persist as part of that character's look is the hard, unglamorous part, and it is exactly what turns a pile of separate models into a dressed, staged avatar. Scene Composer closes that gap. It wires the platform's text-to-3D Forge lane directly into a scene graph with bone attachment, so the loop from "I want a crown" to "the crown is on my avatar's head and saved to its wardrobe" happens in one place, with real gizmos and real undo, not a chain of exports and re-imports.

## How it works

The page is a Three.js scene with PMREM image-based lighting, soft shadows, exponential fog for depth, and a three-point key/fill/rim light rig. Everything you add becomes a tracked scene object with a role (avatar, accessory, item, scene, creature, vehicle, or other).

- **Forge from text.** The prompt box posts to `/api/forge` with an optional intent (accessory, item, scene, creature, vehicle) that becomes the model's category. The studio polls the job to completion, streaming staged progress, then loads the resulting GLB into the scene. Meshopt-compressed models are decoded on load. Generation runs on the platform's real text-to-3D lanes; a queued job restarts the timeout window so waiting for a GPU never counts against the run budget.
- **Transform gizmos.** Select any object and translate, rotate, or scale it with `TransformControls`. Toggle world/local space, turn on 0.25-unit grid snapping, and lock proportional scale. Every drag and every numeric-field edit is one undoable step in a 50-deep undo/redo stack.
- **Bone attachment.** When a rigged avatar is in the scene, any non-avatar item's inspector gains an "Attach to Bone" control. The avatar's bones are grouped into readable regions (Head, Torso, Left/Right Arm, Left/Right Leg, Fingers L/R) with the raw bone names cleaned of rig prefixes (`mixamorig:`, `CC_Base_`, `rig_`). Attaching parents the item to that bone at the origin, so it rides the bone; detaching returns it to world space.
- **Scene tooling.** Click-to-select raycasting, a hierarchy panel with per-object visibility and rename (double-click), camera presets (front/back/left/right/top/isometric, plus Blender-style numpad keys), F to frame the selection, Ctrl+D to duplicate, a live triangle-and-object counter, screenshot export, and toast notifications for every action. Geometry, materials, and textures are disposed once the step that removed them can no longer be undone (it falls off the 50-deep history), so long sessions do not leak memory and undo still restores the real object.
- **Bring your own avatar.** Load an avatar by pasting a GLB URL *or* a three.ws avatar id (both go through the same `/api/avatars/<id>` lookup), browse the public 3D avatars through `/api/explore?source=avatar&only3d=1`, or arrive with `?avatar=<id>` or `?glb=<url>`. If the avatar ships animations, its first clip (typically idle) plays automatically through an `AnimationMixer`. A model that cannot be loaded leaves a persistent inline explanation on the start panel, not a toast that vanishes before you can read it.
- **A gallery that is never empty.** The Recent Creations strip shows the models this browser has forged. A first-time visitor has none, so the strip falls back to the live community showcase (`/api/forge-gallery?scope=community`) under the heading "Fresh from the Forge": real, public models you can click straight into the scene without waiting on a generation. Both reads go out together, so the fallback costs nothing in time.
- **Works on a phone.** Below 900px the scene panel (hierarchy, inspector, bone attachment) becomes a drawer behind the ☰ button in the toolbar rather than disappearing, and the toolbar scrolls horizontally instead of pushing the canvas off screen. Every control is a real button with a focus state; the camera menu, avatar picker and shortcuts panel trap focus and return it to their trigger on Escape.

### Export vs. save outfit

There are two ways out. **Export GLB** bakes every visible, non-bone-attached object into one downloadable `scene-compose.glb`. **Save outfit** takes a different path: for an avatar loaded from your three.ws library (a `?avatar=<id>` deep link or the Browse picker), it PATCHes the bone-attached items onto that avatar's record as `appearance.attachments`, each entry a `{ bone, url, name }`, so the outfit rides the avatar everywhere its appearance is applied. Save outfit needs at least one item attached to a bone (up to 8) and an avatar that came from a record; otherwise it points you to Export GLB. The save extends the avatar's existing appearance rather than replacing it, so colors, morphs and layers set in [Avatar Studio](./avatar-studio.md) survive it.

## Walkthrough

1. Open [/compose](https://three.ws/compose). Load an avatar: paste a model URL or an avatar id, click "Browse my avatars" to pick from the public 3D avatars, or skip and compose props only.
2. Choose an intent chip (for example, Accessory), pick a suggested prompt or type your own ("neon visor"), and forge it. Watch the progress bar; the item drops into the scene when it is done.
3. Select the item. In the inspector, open "Attach to Bone", choose Head from the region-grouped list, and click Attach. The visor snaps onto the head.
4. Switch the gizmo to scale (press R) and size it to fit. Use grid snap and proportional lock as needed.
5. Add more items, attach them to hands or the torso, and arrange the composition. Frame with F, orbit, and take a screenshot to preview.
6. Click "Save outfit" to write the attached items back onto your avatar, or "Export GLB" to download the whole staged scene.

## Examples

Scene Composer is an interactive editor; its examples are its deep links and the endpoints it drives.

- **Open with a specific avatar:** `https://three.ws/compose?avatar=<avatarId>`
- **Open with a forged item preloaded:** `https://three.ws/compose?glb=https://.../item.glb`

The Forge call the studio makes for every generation:

```bash
curl -X POST 'https://three.ws/api/forge' \
  -H 'content-type: application/json' \
  -H 'x-forge-client: <your-client-key>' \
  -d '{"prompt":"horned crown","model_category":"accessory"}'
# → { "job_id": "…" }  then poll:
curl 'https://three.ws/api/forge?job=<job_id>' -H 'x-forge-client: <your-client-key>'
# → { "status": "done", "glb_url": "https://.../crown.glb" }
```

Saving attached items as an avatar outfit. This writes to your own avatar record, so unlike the Forge calls above it needs a signed-in session (or an API key with the `avatars:write` scope), not just a client key:

```bash
curl -X PATCH 'https://three.ws/api/avatars/<avatarId>' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <api-key>' \
  -d '{"appearance":{"attachments":[{"bone":"mixamorig:Head","url":"https://.../crown.glb","name":"Horned crown"}]}}'
```

`appearance` replaces the whole parameter document, so send the fields you want to keep alongside `attachments` (the studio reads the record first and merges). Attachment URLs must be https on a three.ws asset host; the full contract is in [specs/AVATAR_PARAMETERS.md](../specs/AVATAR_PARAMETERS.md).

## States & limits

- **Bone attachment needs a rigged avatar.** The "Attach to Bone" control only appears when an avatar with bones is loaded. A non-humanoid or unrigged model can still be arranged and exported, just not bone-parented.
- **Save outfit is for three.ws avatars.** It only works when the loaded avatar came from a record in your library, which is what `?avatar=<id>` and the Browse picker load (so there is something to PATCH), and it needs you signed in. A model loaded by raw URL has no record: use Export GLB. Up to 8 attached items are saved; beyond that, Export GLB.
- **Bone-attached items are excluded from Export GLB.** Export bakes visible, world-space objects; items parented to a bone belong to the avatar and are saved through Save outfit instead.
- **Generation can take minutes.** Full-quality bakes legitimately run past ten minutes; the studio's ceiling sits above the slowest real generation, and a queued job restarts the wait window. A genuinely failed or timed-out job surfaces an actionable error.
- **Undo is 50 deep.** Transforms, adds, and removes are undoable (Ctrl+Z / Ctrl+Y); a full scene wipe is not a single undo step.
- **Ownership is client-keyed.** Forge creations and the gallery are scoped to a per-browser client key stored in local storage, so your generations follow the browser without an account. Until you have forged anything, the strip shows the public community showcase instead.
- **A locally dropped GLB cannot be saved as an outfit.** A file dragged onto the drop zone lives at a `blob:` URL that dies with the tab, so Save outfit refuses it by name and points you at Export GLB (or uploading it through [/forge](https://three.ws/forge)) rather than persisting a link that breaks on reload.

## Related

- [Avatar Studio](./avatar-studio.md): build the avatar you dress here.
- [Animation Studio](./animation-studio.md): pose and animate the dressed avatar.
- [Scene Studio](./scene-studio.md): the full three.js editor for heavier scene authoring.
- [Restyle Studio](./restyle.md): re-skin the forged props before attaching them.
- [/forge](https://three.ws/forge): the text-to-3D generator behind the prompt box.
