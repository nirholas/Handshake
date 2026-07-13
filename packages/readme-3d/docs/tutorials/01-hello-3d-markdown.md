---
title: "Hello, 3D markdown - your first embedded model"
description: "Embed an interactive 3D model in a GitHub README in five minutes, with nothing but a markdown code fence."
---

# Hello, 3D markdown

GitHub renders ASCII STL placed inside a fenced code block as an **interactive 3D viewer** - in READMEs, issues, pull requests, discussions, and gists. No plugins, no JavaScript, no images. This tutorial gets your first model on screen in five minutes.

## 1. The magic fence

Paste this into any markdown file on GitHub (or into a new issue and hit Preview):

````markdown
```stl
solid pyramid
 facet normal 0.00 0.00 -1.00
  outer loop
   vertex -10.00 -10.00 0.00
   vertex 10.00 10.00 0.00
   vertex 10.00 -10.00 0.00
  endloop
 endfacet
 facet normal 0.00 0.00 -1.00
  outer loop
   vertex -10.00 -10.00 0.00
   vertex -10.00 10.00 0.00
   vertex 10.00 10.00 0.00
  endloop
 endfacet
 facet normal 0.00 -0.89 0.45
  outer loop
   vertex -10.00 -10.00 0.00
   vertex 10.00 -10.00 0.00
   vertex 0.00 0.00 20.00
  endloop
 endfacet
 facet normal 0.89 0.00 0.45
  outer loop
   vertex 10.00 -10.00 0.00
   vertex 10.00 10.00 0.00
   vertex 0.00 0.00 20.00
  endloop
 endfacet
 facet normal 0.00 0.89 0.45
  outer loop
   vertex 10.00 10.00 0.00
   vertex -10.00 10.00 0.00
   vertex 0.00 0.00 20.00
  endloop
 endfacet
 facet normal -0.89 0.00 0.45
  outer loop
   vertex -10.00 10.00 0.00
   vertex -10.00 -10.00 0.00
   vertex 0.00 0.00 20.00
  endloop
 endfacet
endsolid pyramid
```
````

And here is that exact block rendered live on this very page - drag it:

```stl
solid pyramid
 facet normal 0.00 0.00 -1.00
  outer loop
   vertex -10.00 -10.00 0.00
   vertex 10.00 10.00 0.00
   vertex 10.00 -10.00 0.00
  endloop
 endfacet
 facet normal 0.00 0.00 -1.00
  outer loop
   vertex -10.00 -10.00 0.00
   vertex -10.00 10.00 0.00
   vertex 10.00 10.00 0.00
  endloop
 endfacet
 facet normal 0.00 -0.89 0.45
  outer loop
   vertex -10.00 -10.00 0.00
   vertex 10.00 -10.00 0.00
   vertex 0.00 0.00 20.00
  endloop
 endfacet
 facet normal 0.89 0.00 0.45
  outer loop
   vertex 10.00 -10.00 0.00
   vertex 10.00 10.00 0.00
   vertex 0.00 0.00 20.00
  endloop
 endfacet
 facet normal 0.00 0.89 0.45
  outer loop
   vertex 10.00 10.00 0.00
   vertex -10.00 10.00 0.00
   vertex 0.00 0.00 20.00
  endloop
 endfacet
 facet normal -0.89 0.00 0.45
  outer loop
   vertex -10.00 10.00 0.00
   vertex -10.00 -10.00 0.00
   vertex 0.00 0.00 20.00
  endloop
 endfacet
endsolid pyramid
```

That's a complete square-based pyramid: a two-triangle base and four sides. Drag it, zoom it. You just did 3D in markdown.

## 2. The rules of the format

An ASCII STL is a list of triangles ("facets"):

```text
solid <name>
 facet normal <nx> <ny> <nz>     one unit vector per triangle
  outer loop
   vertex <x> <y> <z>            exactly three vertices
   vertex <x> <y> <z>
   vertex <x> <y> <z>
  endloop
 endfacet
 ...repeat per triangle...
endsolid <name>
```

Three things matter in practice:

- **It must be ASCII STL**, not binary. Most `.stl` files you download are binary and will not render - convert them first (step 3).
- **Z is up.** STL comes from the 3D-printing world. Models exported from glTF/three.js (Y-up) will lie on their face unless rotated.
- **Size counts against the whole file.** GitHub stops rendering any markdown file larger than 512 KB, and each vertex line costs ~30 bytes. Real models need simplification.

## 3. Use a real model

Hand-writing facets stops being fun at around triangle ten. Convert any existing model instead:

```bash
npx readme-3d model.glb >> README.md     # GLB/glTF, binary STL, OBJ all work
npx readme-3d check README.md            # confirm you're under the 512 KB limit
```

`readme-3d` converts, simplifies to a size budget, fixes the up-axis, and emits the fenced block ready to paste.

## Next

- [Convert a GLB end to end →](02-convert-a-glb.md)
- [Generate a model from text with AI →](03-text-to-3d-avatar.md)
