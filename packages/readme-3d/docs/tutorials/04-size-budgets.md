---
title: "Size budgets: fitting 3D models under GitHub's 512 KB markdown limit"
description: "The exact math of ASCII STL file size, GitHub's markdown render limit, and how to spend your byte budget for maximum visual quality."
---

# Size budgets

GitHub renders a markdown file only if it is **512 KB or smaller** - one byte over and the whole page falls back to raw text, 3D viewer included. ASCII STL is a verbose format, so budgeting is the difference between a slick README and a wall of `vertex` lines.

## The math

One facet at the default 2-decimal precision costs about **145 bytes**:

```text
 facet normal 0.12 -0.99 0.05      ~30 bytes
  outer loop                        13 bytes
   vertex 12.34 -56.78 90.12       ~30 bytes × 3
  endloop                           10 bytes
 endfacet                           10 bytes
```

So the budget table looks like this:

| Facets | Approx. block size | % of the 512 KB limit |
| ---: | ---: | ---: |
| 300 | 45 KB | 9% |
| 600 | 90 KB | 18% |
| 1,000 | 145 KB | 28% |
| 1,500 | 215 KB | 42% |
| 2,000 | 290 KB | 57% |
| 3,000 | 435 KB | 85% |

Remember the rest of your README counts too. A 200 KB README leaves ~310 KB - about 2,100 facets - for models.

## Spending it well

- **`--budget` beats `--facets`.** `npx readme-3d model.glb --budget 150kb` iterates simplification until the *bytes* fit, whatever the mesh.
- **Precision is a multiplier.** `--precision 1` cuts ~18% of bytes; combined with the default 100-unit normalization the visual loss is negligible at README scale. Going below 1 visibly quantizes.
- **Facets go where curvature is.** meshoptimizer's quadric simplifier keeps triangles on silhouette edges and spends few on flat areas - organic models survive 90%+ reduction; hard-surface models with fine bevels degrade sooner.
- **One hero beats three thumbnails.** Multiple viewers each add ~50 KB minimum and compete for attention.
- **Verify before you push:**

```bash
npx readme-3d check README.md
# README.md: 380.2 KB of 512.0 KB GitHub render limit
#   stl block 1: 1200 facets, 172.2 KB
# OK - 131.8 KB of headroom left.
```

`check` exits with code 2 when the file is over the limit, so it slots into CI or a pre-commit hook.

## When the model just won't fit

- Move it to a dedicated `MODEL.md` and link it - every markdown file gets the viewer, not just the README.
- Embed a small version inline and link the full-quality GLB for download.
- For very complex scenes, render a GIF for the README and put the interactive STL in a linked file.

## Next

- [3D beyond the README →](05-issues-prs-discussions.md)
