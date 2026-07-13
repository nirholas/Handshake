---
title: "Convert a GLB to a GitHub-renderable 3D block"
description: "Take any GLB/glTF, OBJ, or binary STL and turn it into an interactive 3D model in your README with one command."
---

# Convert a GLB

You have a model - a GLB from a game asset pack, a Blender export, a 3D scan, an AI generation. This tutorial turns it into an interactive block in your README.

## 1. Convert

```bash
npx readme-3d model.glb
```

The markdown block prints to stdout, and a summary goes to stderr:

```text
model.glb: 48210 → 1500 facets, 214.8 KB
```

Pipe it straight into your README, or write a standalone file:

```bash
npx readme-3d model.glb >> README.md
npx readme-3d model.glb -o model.md --stl model-ascii.stl
```

## 2. Fit your budget

GitHub renders markdown files up to 512 KB. If your README already has content, give the model an explicit byte budget instead of a facet count:

```bash
npx readme-3d model.glb --budget 150kb >> README.md
npx readme-3d check README.md
```

`check` reports the file's total size, every embedded STL block, and your remaining headroom - and exits non-zero if GitHub would refuse to render it, so you can use it in a pre-commit hook.

## 3. Tune the result

| Problem | Fix |
| --- | --- |
| Model lies on its face | source was already Z-up: pass `--up z` (or `--up y` to force rotation) |
| Too chunky after simplification | raise `--facets`, or lower `--precision` to 1 to spend bytes on triangles instead of decimals |
| Huge README diff | write to a separate file: `-o model.md`, then link to it |
| Model dwarfed by whitespace | `--no-normalize` keeps your original coordinates |
| Big block dominates the page | `--details` wraps it in a collapsed `<details>` section |

## 4. What the converter actually does

1. **Parses** GLB/glTF (including Draco- and meshopt-compressed), OBJ, or binary/ASCII STL into a triangle soup, baking every node transform.
2. **Welds** duplicate vertices and **simplifies** with [meshoptimizer](https://github.com/zeux/meshoptimizer)'s quadric simplifier, progressively loosening the error tolerance until it hits your target - this is what tames disconnected AI-generated meshes.
3. **Rotates** Y-up sources to STL's Z-up convention, **normalizes** to a compact 100-unit scale, grounds the model at z=0, and centers it.
4. **Serializes** ASCII STL with fixed 2-decimal precision and recomputed facet normals.

Textures and colors are gone - STL is geometry only, and GitHub renders it monochrome. Models with a strong silhouette survive; flat logos and texture-dependent details don't.

## Next

- [No model? Generate one from text →](03-text-to-3d-avatar.md)
- [The size-budget math →](04-size-budgets.md)
