# How the Forge works, in plain language

You type "a weathered brass diving helmet" at [three.ws/forge](https://three.ws/forge), and about half a minute later you are orbiting a real, textured 3D model you can download, view in AR, or drop into a scene. No account, no key, no cost. This page explains what actually happens in between, without the engineering detail. (If you want that, read the [architecture deep dive](./forge-pipeline.md).)

## The five steps every generation takes

**1. Your words become a picture.** For a text prompt, an image model first paints your description as a clean reference photo of the object, the way a concept artist would sketch it before a sculptor starts. If you uploaded photos instead, this step is skipped: your photos are the reference.

**2. The picture becomes a shape.** A 3D reconstruction model looks at the reference and infers the full object: the sides it can see and the sides it has to imagine. Out comes real geometry, a mesh with color and texture baked on.

**3. The best available engine does the work.** three.ws does not run one 3D model; it runs a grid of them. Microsoft's TRELLIS on NVIDIA's cloud, Tencent's Hunyuan3D and TRELLIS on our own GPUs, community models on Hugging Face, and premium engines like Meshy and Tripo if you bring your own key. Before your job starts, the Forge checks which engines are healthy right now and picks the best free one for your kind of prompt. Machines and vehicles route to the engine that is best at hard surfaces; people and creatures route to the one that is best at organic shapes.

**4. If an engine stumbles, your job quietly moves.** GPU services go down, queues fill, clouds have bad days. When that happens mid-generation, the Forge re-submits your job to the next engine in line automatically. You keep watching the same progress bar; you never find out. Only if every lane fails do you see an error, and even then it comes with one-click retry options.

**5. The model is saved somewhere permanent.** The raw output lands on temporary cloud storage that expires within an hour, so the Forge immediately copies your model to a permanent CDN. That is the link you share, and it keeps working. The generation is also recorded in your gallery, so closing the tab mid-job loses nothing: the platform finishes it in the background and it is waiting for you when you come back.

## What the quality tiers mean

- **Draft ($0.05, free on the default lane)**: about 12,000 polygons, fast, no textures on some lanes. For trying ideas.
- **Standard (the default)**: about 30,000 polygons with 2K textures, reference views fused from multiple angles.
- **High**: up to 200,000 polygons with full PBR materials and HD textures, the deepest quality settings every engine offers. High is where holding $THREE matters: holders generate at High as a perk, everyone else pays per generation.

Here is the honest part: draft and standard usually cost us nothing to produce, because they run on free lanes and our own GPUs. We charge for the top tier because it is genuinely better, not to pass a vendor bill along.

## After the model exists

A finished model is a starting point, not a dead end:

- **Make it move.** One click adds a full skeleton (52 bones, face blendshapes) so a humanoid model can walk, wave, and talk. This powers every animated avatar on the platform.
- **Change its look.** Say "make it chrome" or "wooden" and the material changes without regenerating the shape.
- **Refine it by talking.** "Bigger helmet." "More rust." Each refinement is a new version in a history you can rewind or branch.
- **Make it game-ready.** Retopology to a clean polygon budget that drops straight into Unity or Unreal.
- **Share and remix.** Publish it, let others remix it, and earn royalties on-chain when they do.

## Agents use the exact same machinery

Everything above is also a tool call. AI agents (Claude, ChatGPT, or your own) generate models through our [free MCP server](./mcp-studio.md) or plain HTTP, and other agents pay per call with USDC over [x402](./x402.md), no account needed. The page you use and the API an agent uses are the same pipeline underneath.

## Try it

- Type a prompt: [three.ws/forge](https://three.ws/forge)
- Turn photos into a model: [three.ws/image-to-3d](https://three.ws/image-to-3d)
- The full technical breakdown: [the Forge pipeline deep dive](./forge-pipeline.md)
