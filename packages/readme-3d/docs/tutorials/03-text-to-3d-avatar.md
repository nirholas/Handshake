---
title: "Text → 3D → README: generate an avatar with AI and embed it"
description: "Generate a 3D model from a one-line text prompt with the free three.ws Forge API, then embed it in your GitHub README."
---

# Text → 3D → README in five minutes

You don't need a model, Blender skills, or a 3D artist. [three.ws Forge](https://three.ws/forge) turns a text prompt into a textured GLB on a free tier - no API key, no account - and `readme-3d` puts the result in your README.

## 1. Generate a model from text

```bash
curl -s -X POST https://three.ws/api/v1/ai/text-to-3d \
 -H 'content-type: application/json' \
 -d '{"prompt": "a friendly humanoid robot mascot standing upright, rounded smooth body panels, big head, full body"}'
```

Generation takes up to a minute or two. When it completes inside the request window you get the model directly:

```json
{ "data": { "status": "done", "glb_url": "https://cdn.three.ws/forge/anon/<id>.glb", "viewer_url": "..." } }
```

If it returns `"status": "pending"` instead, poll the included `poll_url` (`GET https://three.ws/api/forge?job=<job>`) every few seconds until `status` is `"done"`. Then download:

```bash
curl -sL -o mascot.glb "<glb_url from the response>"
```

Prompt tips for models that survive the monochrome STL treatment:

- **Lead with the subject** and keep it to one object: "a chess knight piece", "a low-poly fox".
- **Shape over surface.** Colors and materials are lost in STL - silhouettes are everything. "big head", "standing upright", "full body" all pay off.
- Prefer **standing/grounded poses**; the viewer orbits around the model's base.

## 2. Convert and embed

```bash
npx readme-3d mascot.glb --budget 150kb --name mascot >> README.md
npx readme-3d check README.md
```

Commit and push. Your README now has an interactive, draggable 3D mascot that GitHub renders natively.

## 3. The same flow from Claude / an AI agent

This repo ships a [Claude Code skill](https://github.com/nirholas/readme-3d/blob/main/skills/3d-in-readme/SKILL.md) that automates the whole pipeline. With the skill installed:

> "Generate a 3D wizard mascot and add it to my README"

does generate → download → convert → budget-check → embed in one go. three.ws also exposes the generator as an MCP tool (`forge_free`) for any MCP-capable agent - see [three.ws/mcp](https://three.ws/mcp).

## Real-world example

The [three.ws README](https://github.com/nirholas/three.ws#meet-the-avatar-a-live-3d-model-right-here-in-markdown) embeds its own platform mascot exactly this way: one-line prompt → Forge → 1,200 facets → 172 KB block.

## Next

- [Size budgets: how far 512 KB goes →](04-size-budgets.md)
- [3D in issues, PRs, and discussions →](05-issues-prs-discussions.md)
