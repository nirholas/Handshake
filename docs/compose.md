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
- **Scene tooling.** Click-to-select raycasting, a hierarchy panel with per-object visibility and rename (double-click), camera presets (front/back/left/right/top/isometric, plus Blender-style numpad keys), F to frame the selection, Ctrl+D to duplicate, a live triangle-and-object counter, screenshot export, and toast notifications for every action. Geometry, materials, and textures are disposed on removal, so long sessions do not leak memory.
- **Bring your own avatar.** Load an avatar by URL, browse your gallery through `/api/explore`, or arrive with `?avatar=<id>` (resolved via `/api/avatars/<id>`) or `?glb=<url>`. If the avatar ships animations, its first clip (typically idle) plays automatically through an `AnimationMixer`.

### Export vs. save outfit

There are two ways out. **Export GLB** bakes every visible, non-bone-attached object into one downloadable `scene-compose.glb`. **Save outfit** takes a different path: for a three.ws avatar loaded from `/avatars/<id>`, it PATCHes the bone-attached items (bone name, GLB URL, name) onto that avatar's record as `accessories`, so the outfit becomes part of the avatar everywhere it appears. Save outfit needs at least one item attached to a bone and a resolvable avatar id; otherwise it points you to Export GLB.

## Walkthrough

1. Open [/compose](https://three.ws/compose). Load an avatar: paste a model URL, click "Browse" to pick from your gallery, or skip and compose props only.
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

Saving attached items as an avatar outfit:

```bash
curl -X PATCH 'https://three.ws/api/avatars/<avatarId>' \
  -H 'content-type: application/json' \
  -H 'x-forge-client: <your-client-key>' \
  -d '{"accessories":[{"bone":"mixamorig:Head","glbUrl":"https://.../crown.glb","name":"Horned crown"}]}'
```

## States & limits

- **Bone attachment needs a rigged avatar.** The "Attach to Bone" control only appears when an avatar with bones is loaded. A non-humanoid or unrigged model can still be arranged and exported, just not bone-parented.
- **Save outfit is for three.ws avatars.** It only works when the loaded avatar came from `/avatars/<id>` (so it has a record to PATCH). For any other model, use Export GLB.
- **Bone-attached items are excluded from Export GLB.** Export bakes visible, world-space objects; items parented to a bone belong to the avatar and are saved through Save outfit instead.
- **Generation can take minutes.** Full-quality bakes legitimately run past ten minutes; the studio's ceiling sits above the slowest real generation, and a queued job restarts the wait window. A genuinely failed or timed-out job surfaces an actionable error.
- **Undo is 50 deep.** Transforms, adds, and removes are undoable (Ctrl+Z / Ctrl+Y); a full scene wipe is not a single undo step.
- **Ownership is client-keyed.** Forge creations and the gallery are scoped to a per-browser client key stored in local storage, so your generations follow the browser without an account.

## Related

- [Avatar Studio](./avatar-studio.md): build the avatar you dress here.
- [Animation Studio](./animation-studio.md): pose and animate the dressed avatar.
- [Scene Studio](./scene-studio.md): the full three.js editor for heavier scene authoring.
- [Restyle Studio](./restyle.md): re-skin the forged props before attaching them.
- [/forge](https://three.ws/forge): the text-to-3D generator behind the prompt box.
