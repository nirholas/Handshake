# Restyle Studio: re-skin any GLB without regenerating its mesh

Restyle Studio changes what a 3D model is made of, not what it is. Load any GLB, and you can flip it to chrome, gold, glass, or wood with one click, describe a look in plain language and let an AI propose the physically based material for it, fan a preset out into a strip of reproducible colorway variants, or fine-tune metalness, roughness, color, and emissive live. The mesh, its geometry, and its UVs are never touched. Only the material factors change, so a restyle is fast, cheap, and never distorts the model. Every AI restyle and every saved checkpoint mints a real, validated, durably stored GLB in a parent-to-child version lineage, so nothing you make here is a throwaway browser preview.

Page: [/restyle](https://three.ws/restyle) · API: `/api/material-studio`

## Why it exists

Generating a 3D model is the expensive step. Once you have a good mesh, wanting it in a different finish should not mean paying to regenerate the whole thing and risking a worse shape. Restyle Studio separates the two. Skin is cheap and reversible; geometry is precious and left alone. That makes iterating on look-and-feel a tight loop: try chrome, try worn copper, try glass, save the two you like as durable versions, export the winner. It also gives the rest of the platform one shared material vocabulary. Restyle Studio consumes the same PBR preset library (`@three-ws/viewer-presets`) and the same GLB optimize-and-validate path that [Avatar Studio](./avatar-studio.md) uses, instead of inventing a parallel one.

## How it works

The page is a Three.js scene with `RoomEnvironment` image-based lighting, so metals and glass reflect something real rather than reading as flat grey. Four capabilities sit on top of the loaded model:

- **Preset library (18 looks).** One click applies a physically based material across every standard material in the model. The presets are `chrome`, `gold`, `copper`, `brushedSteel`, `gunmetal`, `matte` (plastic), `glossy` (plastic), `rubber`, `ceramic`, `glass`, `realGlass` (transmissive), `wood`, `stone`, `fabric`, `skin`, `carPaint`, `neon`, and `holographic`. Each carries tuned color, metalness, roughness, environment-map intensity, and where the look calls for it (neon, holographic) emissive values or (brushed steel, car paint) anisotropy and clearcoat. The page renders whatever `@three-ws/viewer-presets` exports, and `GET /api/material-studio` lists the same set, so the two can never drift.
- **AI restyle from an instruction.** Type something like "make it chrome", "worn copper", or "cyberpunk neon" and the server asks IBM Granite (watsonx.ai) to propose a glTF 2.0 PBR material (base color, metallic, roughness, emissive factors). The factors come back, get applied to the in-browser preview instantly, and are also applied server-side to the source GLB and re-exported as a durable, validated model. If you leave the "also generate a texture" option on, the studio additionally asks the platform text-to-image lane (`/api/v1/ai/image`, the same NVIDIA NIM FLUX / Vertex stack Forge uses) for a seamless tileable material swatch and applies it as the base-color map. The flat PBR restyle always lands even if texture generation is skipped or hits its free daily quota.
- **Seeded colorway variants.** Pick a base preset, a seed, and a count (1 to 12), and the studio fans it into a strip of variants using a `mulberry32` seeded PRNG. The same base plus the same seed always produces the byte-identical set, so a colorway you liked is reproducible forever. Clicking a swatch applies it live. "Save all as versions" turns those variants into real, separately addressable GLBs, each branching off the same parent version.
- **Live manual controls.** Sliders for metalness, roughness, and emissive intensity, plus base-color and emissive-color pickers, set the same property across every standard material at once. A Reset button restores every material to its captured original values.

### Version lineage

Two kinds of history live side by side. The in-browser breadcrumb records every preset and slider tweak and never leaves the tab. The durable version lineage is the real one: every AI restyle and every "Save version" checkpoint uploads a `gltf-validator`-checked GLB and records it with the same immutable parent-to-child shape the `refine_model` MCP tool uses. Clicking any version in the Versions strip reloads that exact GLB. A restyle or a variant set can extend one thread or branch off an earlier version, so the lineage is a tree, not just a line.

### One core, two transports

The endpoint is free and hosted (no wallet, no account, no x402), bounded by server-side rate limits rather than payment, the same doctrine `forge_free` and the free 3D Studio use. The `restyle_material` MCP tool is a thin paid stdio client (0.05 USDC) over this same endpoint, so the free web page and the paid agent tool can never drift. One implementation, two transports.

## Walkthrough

1. Open [/restyle](https://three.ws/restyle). The platform's default humanoid loads so the stage is never empty. To bring your own model, drag a `.glb`/`.gltf` onto the stage, use the file picker, or paste a public model URL into "Load URL". You can also deep-link a model with `?url=https://.../model.glb`.
2. Click a preset (start with **Chrome** or **Gold**) and watch the whole model re-skin against real reflections. Orbit to inspect it.
3. Type an instruction in the AI restyle box, for example `brushed titanium with a faint blue sheen`, and press the button. Granite proposes the material, it applies instantly, and a new durable version is minted.
4. Nudge the metalness and roughness sliders, or change the base color, to fine-tune.
5. Set a seed and a count, generate variants, and click through the swatch strip. Hit "Save all as versions" to keep the whole set as durable GLBs.
6. Click "Save version" to checkpoint the current look, or "Export" to download `restyled.glb`. The export runs through the shared optimize-and-validate path, so the note tells you the final size and whether it is valid glTF.
7. Revisit any earlier state by clicking its entry in the Versions strip.

## Examples

The API is public and rate-limited. `glb_url` must be a publicly resolvable https URL (the studio checkpoints local file drops to a URL first, behind the scenes).

```bash
# Discovery document: actions, preset names, and the lineage contract.
curl 'https://three.ws/api/material-studio'

# AI restyle: instruction in, applied + re-exported GLB out.
curl -X POST 'https://three.ws/api/material-studio?action=restyle' \
  -H 'content-type: application/json' \
  -d '{"glb_url":"https://three.ws/avatars/realistic-female.glb","instruction":"polished chrome"}'

# Seeded colorway variants of a preset (reproducible for a given seed).
curl -X POST 'https://three.ws/api/material-studio?action=variants' \
  -H 'content-type: application/json' \
  -d '{"glb_url":"https://three.ws/avatars/realistic-female.glb","preset":"gold","seed":7,"count":6}'
```

A restyle response carries the applied factors plus the version lineage:

```json
{
  "ok": true,
  "glbUrl": "https://.../material-studio/.../restyled.glb",
  "sourceGlbUrl": "https://three.ws/avatars/realistic-female.glb",
  "instruction": "polished chrome",
  "factors": {
    "baseColorFactor": [0.79, 0.81, 0.83, 1],
    "metallicFactor": 1,
    "roughnessFactor": 0.05,
    "emissiveFactor": [0, 0, 0]
  },
  "materialsEdited": 4,
  "lineage": [ { "index": 0, "glbUrl": "…" }, { "index": 1, "glbUrl": "…" } ],
  "activeIndex": 1
}
```

Pass the returned `lineage` array back as `parent_lineage` on the next call to extend the same thread, and add `parent_index` to branch off an earlier version instead of the latest.

## States & limits

- **Only standard PBR materials are edited.** A material must expose metalness, roughness, and a color to be restyled. Non-PBR or custom-shader materials are left as they are.
- **AI restyle and Save need a public model URL.** A locally dropped file is checkpointed to a URL in the background first; until that resolves, AI restyle and Save show an honest note rather than failing silently. Loading a public `.glb` via "Load URL" skips the wait.
- **Texture generation is best-effort.** Past the free daily quota the image lane returns a payment-required signal; the studio surfaces that as a note and keeps the flat PBR restyle it already applied. It never fakes a texture.
- **Bounded, not gated.** The web endpoint is free but rate-limited per IP (separate limits for uploads and restyle/variants). Instructions are capped at 300 characters and uploads at 64 MB.
- **Reset vs. revert.** Reset restores the original material values in the current tab. Reverting to an earlier durable GLB is a separate action: click its entry in the Versions strip. Reverting also re-anchors the source: the next AI restyle, Save version, or "Save all as versions" reads that version's bytes and branches from it, rather than from the newest checkpoint.
- **No mesh changes.** Geometry, UVs, and rigging are never modified, so a restyle can never break animation or distort a shape.

## Related

- [Avatar Studio](./avatar-studio.md): shares the same GLB optimize-and-validate path and material vocabulary.
- [Scene Composer](./compose.md) and [Scene Studio](./scene-studio.md): arrange and edit restyled models in a full scene.
- [MCP tools reference](./mcp-tools.md): the paid `restyle_material` agent twin of this endpoint.
- [/forge](https://three.ws/forge): generate the models you bring here.
