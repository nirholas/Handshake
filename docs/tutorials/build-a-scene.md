# Build a 3D scene in Scene Studio

By the end of this tutorial you'll have composed a complete 3D scene in the browser — imported GLB models, arranged them with transform gizmos, edited their materials, lit the scene, and exported the whole thing as a single GLB you can drop anywhere. No install, no build step; everything runs client-side at [/scene](/scene).

Along the way you'll learn how the editor's panels fit together, why the scene autosaves to your browser, and when to reach for the lighter [Scene Composer](/compose) instead.

**Prerequisites:** a desktop browser (the editor is keyboard- and gizmo-driven). At least one GLB or glTF model to import — generate one for free from text at [/forge](/forge), or use any GLB file you already have. No account required.

---

## What you're building

A scene is a collection of objects — meshes, lights, cameras — arranged in 3D space, with materials and a background, exported as one file:

```
Import GLB(s)  →  arrange with Move / Rotate / Scale  →  edit materials
       ↓                                                       ↓
   add lights  ───────────────►  set background  ───────►  Export GLB → scene.glb
```

The result is a self-contained `scene.glb` (or `.gltf`) that carries every object, material, and embedded texture. You can re-import it later, hand it to another tool, or view it in AR.

[Scene Studio](/scene) is a full editor — the vendored [mrdoob/three.js](https://github.com/mrdoob/three.js) editor (`r184`, MIT — see [src/scene-studio/vendor/README.md](../../src/scene-studio/vendor/README.md)) mounted under the three.ws nav. It is dark-locked: the editor chrome only ships a dark theme.

---

## How the editor is laid out (two minutes of orientation)

[/scene](/scene) is a single full-screen workspace. Five regions do all the work:

| Region | Where | What it's for |
|---|---|---|
| **Menubar** | top | File, Edit, Add, View, Help, Render — every command |
| **Toolbar** | top-left, over the viewport | Move / Rotate / Scale gizmo modes |
| **Viewport** | center | the live 3D scene; orbit, select, drag gizmos |
| **Sidebar** | right | three tabs — **Scene**, **Project**, **Settings** |
| **Animation** | bottom (resizable) | keyframe timeline for animated objects |

The **Sidebar → Scene** tab is where you'll spend most of your time. It shows the **outliner** (the scene graph as a tree) at the top, and below it a **properties** area that changes depending on what's selected — Object, Geometry, and Material sub-panels for a mesh; light controls for a light.

One thing to know up front: **the editor autosaves.** Every change (add, move, material edit, delete) is written to your browser's local storage about a second later, and restored when you return to [/scene](/scene). Your scene persists across reloads on the same browser — but it is *local*, not synced to an account. To keep a scene permanently or move it elsewhere, you **export** it (Step 7) or save the project JSON (`File → Save`).

---

## Step 1: Open Scene Studio

Go to [/scene](/scene). You'll see an empty viewport with a default grid and lighting.

If you arrived from another surface — for example clicking **Open in Scene Studio** after a [Forge](/forge) generation, or a hand-off from the [Animation Studio](/pose) — the model is already loaded into the scene and selected for you. In that case skip to Step 3.

Orbit the empty scene to get oriented:

- **Orbit** — left-drag in the viewport
- **Pan** — right-drag
- **Zoom** — scroll wheel

---

## Step 2: Import a GLB

There are two ways to bring a model in, and they behave slightly differently.

**Drag and drop (fastest):** drag a `.glb` or `.gltf` file from your file manager straight onto the viewport. The editor loads it, adds it to the scene, and lists it in the outliner. Dropping a folder works too — it imports every model inside.

**File → Import:** open the **File** menu, click **Import**, and pick one or more files. This is the same path as drag-and-drop and supports the same formats.

Scene Studio imports far more than GLB. The vendored loader (see [src/scene-studio/vendor/js/Loader.js](../../src/scene-studio/vendor/js/Loader.js)) accepts `glb`, `gltf`, `fbx`, `obj`, `dae` (Collada), `usdz`, `ply`, `stl`, `3mf`, `amf`, `drc`, `vox`, `wrl`, `svg`, and several more — but **GLB is the recommended format**: it bundles mesh, materials, and textures into one binary file, and it's what every other three.ws surface produces.

> **Deep-link import.** You can also load a model by URL: `/scene?model=<glb_url>&name=<label>`. The editor fetches the GLB, adds it through the normal undo-able import path, then strips the query from the address bar so a reload doesn't import a duplicate. This is exactly how the **Open in Scene Studio** hand-off works. The URL must be `https://` or a same-origin path.

After import, the model appears in the outliner. Click its row to select it — a transform gizmo snaps onto it in the viewport.

---

## Step 3: Arrange objects with the transform gizmo

Select an object (click it in the viewport or its outliner row), then choose a transform mode. The three modes live in the Toolbar and on the keyboard:

| Mode | Toolbar | Key |
|---|---|---|
| **Move** (translate) | the move icon | `W` |
| **Rotate** | the rotate icon | `E` |
| **Scale** | the scale icon | `R` |

Drag the colored gizmo handles in the viewport to transform along an axis. Useful companions while you arrange:

- **`F`** — focus the camera on the selected object (frames it in view).
- **Snapping** — hold while dragging, or set a snap distance, to move in fixed increments.
- **World / Local space** — the gizmo can operate in world axes or the object's own axes.

For precision, type exact values instead of dragging: with the object selected, open **Sidebar → Scene** and use the **Object** sub-panel's **Position**, **Rotation**, and **Scale** number fields. Every edit here goes through the editor's command system, so it's fully undoable.

**Multiple copies?** With an object selected, **Edit → Clone** (or the duplicate shortcut) makes an independent copy you can reposition. **Edit → Center** moves the object so its bounding box is centered on its own origin — handy when an imported model arrives off-center.

Everything you do is undoable: **Edit → Undo** (`Ctrl+Z`) and **Edit → Redo** (`Ctrl+Shift+Z`). The full edit history is also browsable under **Sidebar → Settings → History**.

---

## Step 4: Organize the scene graph

As the scene grows, keep the outliner tidy.

- **Rename** — select an object and edit the **Name** field in the **Object** sub-panel. Clear names make a complex scene navigable.
- **Group** — **Add → Group** creates an empty container. Drag objects onto the group's row in the outliner to nest them. Transforming the group moves everything inside it as a unit — ideal for, say, a table and everything on it.
- **Delete** — select and press `Del`, or **Edit → Delete**.

A well-organized outliner pays off at export time: groups and names survive into the exported GLB.

---

## Step 5: Edit materials

Select a mesh, then open **Sidebar → Scene**. Below the Object and Geometry sub-panels is the **Material** sub-panel — this is the live material editor.

The exact controls depend on the material type (imported GLB models typically use a physically-based `MeshStandardMaterial`). Common properties you can edit:

- **Color** — the base color swatch. Click it to open a color picker.
- **Roughness** and **Metalness** — the PBR sliders that define whether a surface looks matte or glossy, dielectric or metallic.
- **Emissive** — a color the material gives off regardless of lighting (good for glowing elements).
- **Maps** — texture slots (color/albedo, normal, roughness, metalness, emissive, and more). Click a map slot to assign an image.
- **Opacity / Transparent** — make a material see-through.
- **Side** — render the front, back, or both faces.

Every change renders in the viewport immediately and is captured in undo history. If a primitive you added looks unlit and flat, it's usually because the scene has no light yet — that's the next step.

> **Add primitives directly.** You don't have to import everything. **Add → Mesh** drops in a Box, Sphere, Plane, Cylinder, Torus, Capsule, Text, and more — each with a fresh editable material. Great for floors, platforms, and blockout geometry.

---

## Step 6: Light the scene

A scene with no lights renders dark (unlit materials show flat color; PBR materials show nearly black). Add lights from the **Add → Light** submenu:

| Light | Use it for |
|---|---|
| **Ambient** | a flat base fill so nothing is pure black |
| **Directional** | a sun — parallel rays, casts a consistent shadow direction |
| **Hemisphere** | sky/ground gradient fill, good for outdoor scenes |
| **Point** | a bulb — radiates in all directions from a position |
| **Spot** | a cone — a focused beam with an angle and falloff |

Each light appears in the outliner like any other object. Select it to:

- **Position** it with the Move gizmo (`W`) — point and spot lights have a position; directional and spot lights also have a target.
- **Edit its properties** in the Sidebar: **Color** and **Intensity** for every light; **Distance**, **Angle**, and **Penumbra** for the lights that have them.

A solid starting rig: one **Directional** light for key/shadow direction plus a low-intensity **Ambient** or **Hemisphere** light to lift the shadows. Adjust intensities until the scene reads the way you want.

**Set the background and environment** while you're here. In **Sidebar → Scene**, the **Background** control switches between a solid **Color**, a **Texture**, or an **Equirectangular** HDR/image (which doubles as image-based lighting). You can also add **Fog** for depth. These settings export with the scene.

---

## Step 7: Export the scene

When the scene looks right, open **File → Export** and choose a format. For a complete, portable scene, pick **GLB**:

- **GLB** — exports the **entire scene** (all objects, materials, embedded textures, and any optimized animations) as one binary `scene.glb`. This is the recommended output.
- **GLTF** — same content as GLB but as human-readable JSON (`scene.gltf`), with assets referenced/embedded per the glTF spec.

The Export submenu also offers single-object/whole-scene formats for specific pipelines: **OBJ** and **DRC** (these export the *selected* object — select a mesh first), and **PLY**, **STL** (ASCII and binary variants), and **USDZ** for the whole scene. Reach for these only when a downstream tool requires them; for everything on three.ws, **GLB** is the right choice.

The file downloads through your browser. That's your finished scene — re-import it anywhere, [view it in AR](/docs/tutorials/view-in-ar), or hand it to another agent.

> **Save the editable project too.** Export bakes the scene into a delivery format. To keep working on it later with full editor state, use **File → Save**, which writes a `project.json` you can reopen with **File → Open**. The autosaved browser copy persists between visits, but `project.json` is your portable, backup-able source of truth.

---

## When to use Scene Composer instead

[Scene Composer](/compose) is a distinct, lighter surface — not the full editor. Where Scene Studio is a general-purpose 3D editor, Composer is purpose-built for **forging items from text and dressing an avatar**:

- **Forge from text, in place.** Describe an item ("a glowing katana with blue neon energy"), pick a type (accessory, item, scene, creature, vehicle), and it's generated and dropped straight into the scene — no separate trip to [/forge](/forge).
- **Attach to avatar bones.** Load an avatar (paste a GLB URL or browse your avatars), then attach items to specific skeleton bones — a hat to the head, a sword to the hand. The item rides the bone.
- **Familiar arranging.** The same `W` / `E` / `R` Move/Rotate/Scale gizmos, `F` to focus, `Del` to remove, undo/redo, and camera presets — with a streamlined inspector.
- **Two outputs.** **Export GLB** downloads the composition, and **Save Outfit** persists the assembled set to your account.

Rule of thumb: reach for **[/compose](/compose)** when you're generating items and equipping an avatar; reach for **[/scene](/scene)** when you need the full editor — many models, fine material control, primitives, multiple lights, and the broad set of import/export formats.

---

## Troubleshooting

- **My scene is black / models look unlit.** The scene has no light. Add a light from **Add → Light** (start with Directional + a low Ambient). PBR materials render near-black without lighting.
- **An imported model is huge, tiny, or far off-screen.** Models export at wildly different scales. Select it, press `F` to focus, then use **Scale** (`R`) or the Object sub-panel's Scale fields. If it's off-center, **Edit → Center**.
- **The deep-link import failed.** `/scene?model=…` only accepts `https://` or same-origin URLs, and the host must allow the fetch (CORS). The editor will tell you to drag the GLB in instead — that path always works.
- **I lost my scene after closing the tab.** The autosave is per-browser and per-origin: a different browser, profile, or private window won't have it. For anything you care about, **File → Save** the `project.json` or **File → Export** a GLB.
- **The editor loaded in light mode / looks wrong.** Scene Studio is dark-locked; the chrome only ships a dark theme. If styling looks broken, hard-reload to clear a stale cache.
- **OBJ / DRC export did nothing.** Those formats export the *selected* object, not the whole scene. Select a mesh first. For the full scene, use **GLB** or **GLTF**.
- **Drag-and-drop won't import.** Drop onto the viewport, not the sidebar, and use a supported extension (`.glb`/`.gltf` recommended). For a stubborn file, try **File → Import**.

---

## Recap

You composed and exported a complete 3D scene in the browser:

- **Imported** GLBs by drag-and-drop, **File → Import**, or the `/scene?model=` deep link — GLB recommended, but many formats accepted.
- **Arranged** objects with the Move / Rotate / Scale gizmos (`W` / `E` / `R`), `F` to focus, plus precise numeric transforms and **Clone** / **Center** — all undoable.
- **Organized** the scene graph with names and **Add → Group**.
- **Edited materials** (color, roughness, metalness, emissive, maps) in the live Material sub-panel, and added primitives via **Add → Mesh**.
- **Lit the scene** with Directional / Ambient / Point / Spot / Hemisphere lights and set a Color / Texture / Equirectangular background.
- **Exported** the whole scene as a self-contained **GLB** (and learned to **File → Save** the editable `project.json`).

The leverage of [Scene Studio](/scene) is that it's a *real* editor producing a *portable* file: a single GLB that flows into AR, other tools, and the rest of three.ws. When your task is forging items and dressing an avatar instead, the lighter [Scene Composer](/compose) is the faster path.

## See also

- [Generate a 3D model from text](/docs/tutorials/text-to-3d) — make GLBs to import here.
- [Image to 3D](/docs/tutorials/image-to-3d) — turn a photo into a model.
- [Upload a custom GLB](/docs/tutorials/upload-custom-glb) — bring your own assets in.
- [View in AR](/docs/tutorials/view-in-ar) — open your exported scene on a phone.
- [Swap an avatar in the studio](/docs/tutorials/swap-avatar-in-studio) — work with avatars across the editors.
