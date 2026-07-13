---
title: "3D beyond the README: issues, PRs, discussions, and gists"
description: "Every place GitHub renders interactive STL markdown blocks, and the workflows that make 3D-in-markdown genuinely useful."
---

# 3D beyond the README

The ` ```stl ` fence renders everywhere GitHub renders markdown. That makes it a communication tool, not just a README decoration.

## Where it works

| Surface | Renders? | Notes |
| --- | --- | --- |
| Any `.md` file in a repo | ✅ | READMEs, docs, wikis |
| Issues + issue comments | ✅ | paste into the editor, check Preview |
| Pull request descriptions + review comments | ✅ | |
| Discussions | ✅ | |
| Gists | ✅ | shareable single-model pages |
| Raw `.stl` files in a repo | ✅ | GitHub's file viewer renders both ASCII and binary STL, plus a **3D diff** between revisions |
| npm / GitLab / VS Code preview | ❌ | shows the raw text block |

## Workflows this unlocks

**Bug reports with geometry.** Filing an issue about a broken mesh, a bad export, a z-fighting artifact? Embed the offending geometry itself instead of six screenshots from different angles:

```bash
npx readme-3d broken-part.stl --budget 80kb --details | gh issue create --body-file -
```

(`--details` collapses the viewer so long threads stay scannable.)

**3D-printing projects.** Ship each printable part as a rendered block in the parts list - visitors inspect every bracket before downloading. This is the pattern that popularized the technique.

**PR reviews for asset changes.** A PR that modifies a model can show before/after blocks in the description. For files committed as `.stl`, GitHub's file viewer adds a native **revision slider diff** on top.

**Docs and specs.** Coordinate conventions, bounding volumes, collision shapes - render the actual shape next to the prose describing it.

## Committing `.stl` files vs embedding blocks

Embedding (this tool's output) renders inline where readers already are. Committing the `.stl` file gets you the richer file viewer (surface angle/wireframe modes, revision diffs) at the cost of a click. For anything you expect people to *print or reuse*, do both: embed a simplified block, commit the full-resolution binary STL next to it.

## Limits worth knowing

- Markdown files over **512 KB** stop rendering entirely ([budget math](04-size-budgets.md)).
- The viewer is **monochrome** - no colors, materials, or textures.
- Very high facet counts scroll-lag on low-end devices even when they render; staying under ~3,000 facets per block keeps it smooth.

## Next

- Back to [the CLI workflow →](02-convert-a-glb.md)
- [Generate models from text →](03-text-to-3d-avatar.md)
