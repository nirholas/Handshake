# Changelog

## 0.2.0

The extension stops being a viewer with a generate button and becomes a
workbench for the whole life of a model.

- **Animate any rig from the library.** `3D: Try a Library Animation` searches
  the 2,800-clip three.ws motion library and plays the pick on the open model,
  retargeted onto its skeleton in the viewer with the platform's own retargeter
  (Mixamo, Avaturn, VRM, Unreal, Daz and simple rigs all map). **Bake clip**
  then writes the retargeted clip into a copy of the file as real glTF
  animation channels, so it plays in Unity, Unreal, Blender, or `<agent-3d>`.
- **Animate from words.** `3D: Animate this Model from a Text Prompt` samples a
  motion model on the three.ws GPU fleet ("waving confidently", "a slow tai-chi
  sweep") and retargets the result the same way.
- **Refine by describing a change.** `3D: Refine this Model` generates a new
  version anchored to the current one ("make it metallic", "bigger helmet"),
  saves it next to the original as `-v2`, `-v3`, and keeps the version lineage
  so every further refinement extends the same history.
- **Optimize for the web, locally.** `3D: Optimize a Copy for the Web` runs the
  asset pipeline's passes (dedup, prune, weld, resample, meshopt, optionally
  quantize) in the extension host and reports the savings. Nothing is uploaded.
- **Compare with git.** `3D: Compare with the Committed Version` reads the
  model at `HEAD` straight out of git, opens it beside the working copy, and
  writes a structural diff (geometry, materials, textures, skeleton,
  animations, severity) as a Markdown review. Also offered after a refinement
  or an optimization.
- **AI quality check.** `3D: Check Quality with a Vision Model` scores the
  current render for realism and completeness, names visible defects, and
  offers to feed the judge's fix hint straight into a refinement. Works for a
  file that exists only on your disk, because the render is what travels.
- **Turntable GIF.** One click writes a looping orbit of the model, with its
  animation stepped in sync, next to the file. Made for READMEs and PRs.
- **`<agent-3d>` language support.** In HTML, JSX/TSX, Vue, Svelte, Astro,
  Markdown and PHP: diagnostics for an embed with no source or no size, a
  library `<script>` on the `latest` channel, a pinned script with a missing or
  stale integrity hash (an error: the browser refuses it), unknown or misspelt
  attributes and bad enum values; quick fixes for each, including pinning to
  the current release with its hash; hovers and completions for every
  attribute; CodeLenses to preview the referenced model.
- **Status bar.** Triangles, file size, bones and clips of the active model,
  with a click to the report.

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
