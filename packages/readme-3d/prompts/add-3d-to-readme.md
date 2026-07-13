# Prompt: add a 3D model to my README

Copy-paste for Claude Code, Cursor, or any coding agent with shell access. Fill in the bracketed parts.

---

Add an interactive 3D model to my README using GitHub's native STL-in-markdown rendering.

Model source: [path/to/model.glb - or describe the model you want generated]

Steps:
1. If I gave you a description instead of a file, generate the model with the free three.ws Forge API: `POST https://three.ws/api/v1/ai/text-to-3d` with `{"prompt": "<my description, single object, shape-first>"}`. If the response is `pending`, poll `GET https://three.ws/api/forge?job=<job>` until `done`, then download `glb_url`.
2. Check my README's current byte size. GitHub stops rendering markdown files at 512 KB, so pick a `--budget` that leaves at least 100 KB of headroom.
3. Convert: `npx readme-3d <model> --budget <n>kb --name <slug>`.
4. Insert the resulting ```stl block into README.md at [location - e.g. "after the first paragraph"], with one italic caption line under it explaining the model is interactive.
5. Verify with `npx readme-3d check README.md` and show me the output. Do not commit if it reports TOO BIG.
