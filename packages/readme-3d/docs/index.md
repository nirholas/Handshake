---
title: "readme-3d - interactive 3D models in your GitHub README"
description: "Convert GLB, glTF, OBJ, and STL files into the ASCII STL markdown blocks GitHub renders as an interactive 3D viewer. CLI, library, tutorials, and AI-agent skills."
---

# 3D in markdown, the easy way

GitHub renders ASCII STL inside a markdown code fence as a **live, draggable 3D viewer** - in READMEs, issues, pull requests, discussions, and gists. No JavaScript, no images, no plugins.

`readme-3d` is the toolchain around that feature: it converts real models (GLB, glTF, OBJ, binary STL) into paste-ready blocks, simplifies meshes to fit GitHub's 512 KB markdown limit, and size-checks your files so they never silently stop rendering.

```bash
npx readme-3d model.glb >> README.md
npx readme-3d check README.md
```

**[See it live in the repo README →](https://github.com/nirholas/readme-3d#readme)** (GitHub renders the 3D viewer there; this docs site shows static markdown.)

## Try it in your browser

Paste any ASCII STL into the **[playground](playground.html)** to preview exactly what GitHub will render - or generate a model from a text prompt, free, at [three.ws/forge](https://three.ws/forge).

## Tutorials

1. **[Hello, 3D markdown](tutorials/01-hello-3d-markdown.md)** - your first embedded model in five minutes, no tools required
2. **[Convert a GLB](tutorials/02-convert-a-glb.md)** - the CLI end to end: convert, budget, tune
3. **[Text → 3D → README](tutorials/03-text-to-3d-avatar.md)** - generate a model from a text prompt with the free three.ws Forge API and embed it
4. **[Size budgets](tutorials/04-size-budgets.md)** - the exact math of GitHub's 512 KB render limit
5. **[Beyond the README](tutorials/05-issues-prs-discussions.md)** - 3D in issues, PR reviews, discussions, gists, and printing projects

## For AI agents

The repo ships a [Claude Code skill](https://github.com/nirholas/readme-3d/blob/main/skills/3d-in-readme/SKILL.md) and [ready-made prompts](https://github.com/nirholas/readme-3d/tree/main/prompts) so "add a 3D model of a fox to my README" is a one-line request. Model generation is available to any MCP-capable agent through the free three.ws `forge_free` tool.

## Links

- [GitHub repository](https://github.com/nirholas/readme-3d) - source, examples, live demos
- [npm package](https://www.npmjs.com/package/readme-3d) - `npm i -g readme-3d`
- [Examples](https://github.com/nirholas/readme-3d/tree/main/examples) - cube, torus, AI-generated avatar
- [GitHub's announcement of STL-in-markdown](https://github.blog/changelog/2022-03-17-mermaid-topojson-geojson-and-ascii-stl-diagrams-are-now-supported-in-markdown-and-as-files/)
- [three.ws](https://three.ws) - the browser-native 3D AI agent platform behind this tool
