# Prompt: generate a project mascot and embed it in 3D

Copy-paste for Claude Code, Cursor, or any coding agent with shell access.

---

Create a 3D mascot for this project and embed it in the README as an interactive model.

1. Read the README and propose a one-line mascot concept that fits the project (a single character or object, described shape-first: pose, proportions, key features - colors are lost in the final render, silhouette is everything).
2. Show me the concept line and wait for my OK.
3. Generate it free via three.ws Forge: `POST https://three.ws/api/v1/ai/text-to-3d` with `{"prompt": "<concept>"}`; poll `GET https://three.ws/api/forge?job=<job>` if pending; download the `glb_url`.
4. Convert with `npx readme-3d mascot.glb --budget 150kb --name mascot`.
5. Add a "Meet the mascot" section near the top of the README with the ```stl block and a caption noting it's draggable.
6. Run `npx readme-3d check README.md` and confirm OK.
7. Keep the original GLB in `assets/` so I can re-embed at a different budget later.
