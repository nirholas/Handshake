# Changelog

## 0.1.0

First release.

- **3D viewer for `.glb` and `.gltf`.** Opens as the default editor for model
  files: orbit, animation playback with a clip picker and scrub bar, wireframe,
  skeleton overlay, ground grid, auto-orbit, and a PNG snapshot saved next to the
  model. Draco, KTX2, and meshopt assets decode locally, so a compressed three.ws
  avatar renders with no network round trip.
- **Model report.** Triangles, vertices, meshes, materials, textures and their
  weight, animations, rig size, extensions, and optimization notes, produced by
  the same inspector behind the three.ws `/validation` page. The file never
  leaves the machine.
- **Generate from a prompt.** `3D: Generate a Model from Text` and
  `3D: Generate an Avatar from Text` call the free three.ws studio lane, save the
  GLB into the workspace, and open it in the viewer.
- **Rig for animation.** Sends a static model to the three.ws auto-rigger and
  saves the rigged result next to it.
- **Insert an `<agent-3d>` embed.** Resolves the current library release and its
  SRI hash from the live manifest, then writes the snippet at the cursor.
- **Forge gallery.** Recent public creations from three.ws, previewable in the
  viewer and importable into the workspace in one click.
