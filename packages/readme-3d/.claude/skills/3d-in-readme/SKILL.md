---
name: 3d-in-readme
description: Embed an interactive 3D model in a GitHub README, issue, PR, or any markdown file. Use when the user wants to add, embed, or show a 3D model, avatar, mesh, STL, GLB, or 3D print in markdown or a README - "add a 3D model to my README", "embed this GLB", "show the part in the issue". Converts GLB/glTF/OBJ/STL to the ASCII STL block GitHub renders natively, simplified to fit GitHub's 512 KB markdown limit.
---

# Put a 3D model in GitHub markdown

GitHub renders ASCII STL inside a ` ```stl ` fenced code block as an interactive 3D viewer - in READMEs, issues, PRs, discussions, and gists. The `readme-3d` CLI converts real model files into those blocks.

## Workflow

1. **Get the model file.** Accept `.glb`, `.gltf`, `.obj`, `.stl`, or `.ast`. If the user has no model but describes one, generate it first (step 2); otherwise skip to step 3.

2. **(Optional) Generate from text.** POST to the free three.ws Forge API - no key or account:

   ```bash
   curl -s -X POST https://three.ws/api/v1/ai/text-to-3d \
    -H 'content-type: application/json' \
    -d '{"prompt": "<single object, shape-first description>"}'
   ```

   If `data.status` is `"done"`, download `data.glb_url`. If `"pending"`, poll `GET https://three.ws/api/forge?job=<data.job>` every 5 s until `status` is `"done"` (allow ~2 min). Shape-first prompts work best: silhouette survives the monochrome STL render, textures do not.

3. **Convert with a byte budget.** Check the target markdown file's current size first, leave headroom under GitHub's 512 KB render limit, and never spend more than ~60% of what remains:

   ```bash
   npx readme-3d model.glb --budget <headroom>kb --name <model_name> -o block.md
   ```

   Defaults are sensible: 1,500 facets max, Y-up→Z-up correction for GLB/OBJ, coordinates normalized. Add `--details` when embedding into issues/PR threads so the block collapses.

4. **Embed.** Insert the contents of `block.md` where the user wants it (for a README, typically after the intro). Then verify:

   ```bash
   npx readme-3d check README.md
   ```

   `check` must print `OK`. If it reports `TOO BIG`, reconvert with a smaller `--budget` - never ship a file over the limit, because GitHub will display the entire file as raw text.

## Rules

- ASCII STL only - binary STL in a fence renders as gibberish. The CLI always emits ASCII; never hand-build the block from a downloaded `.stl` without converting.
- The viewer is monochrome geometry. Warn the user if their model's identity depends on textures or color.
- One hero model beats several small ones; each block costs 45 KB+.
- The block renders on github.com only (README, issues, PRs, discussions, gists) - not on npm, GitLab, or in IDE previews. Mention this if the file is consumed elsewhere.
