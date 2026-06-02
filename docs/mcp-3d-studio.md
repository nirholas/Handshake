# three.ws 3D Studio — MCP server

Turn text or an image into an interactive, textured 3D model — directly from
Claude, Cursor, or any MCP client. A focused companion to the main three.ws MCP
server, registered separately as **`io.github.nirholas/threews-3d-studio`**.

- **Endpoint:** `https://three.ws/api/mcp-3d`
- **Transport:** Streamable HTTP (MCP `2025-06-18`)
- **Auth:** OAuth 2.1 (same three.ws authorization server as `/api/mcp`) or x402
- **Backend:** Microsoft TRELLIS image→3D and FLUX text→image, on Replicate

## Tools

| Tool | What it does |
|------|--------------|
| `text_to_3d(prompt, aspect_ratio?)` | Text → reference image → reconstructed GLB. Returns a `job_id` and the intermediate preview image. |
| `image_to_3d(image_url, prompt?)` | Reconstruct a GLB from a single reference image. Returns a `job_id`. |
| `generation_status(job_id)` | Poll a job. When done, returns the GLB URL **and** an inline `<model-viewer>` artifact. |
| `preview_3d(glb_url, …)` | Render any public GLB as an interactive `<model-viewer>` artifact (orbit, AR, auto-rotate). |
| `inspect_model(url)` | Structural stats: meshes, triangles, materials, textures, extensions. |
| `optimize_model(url)` | Actionable size/perf suggestions: Draco/Meshopt, KTX2, triangle budget. |

Generation is asynchronous: `text_to_3d` / `image_to_3d` return a `job_id`
immediately, then you poll `generation_status` (reconstruction is typically
30–90s). When a job finishes, `generation_status` returns a `text/html`
resource — display it as an inline 3D artifact.

## Use on claude.ai

Add the connector with URL `https://three.ws/api/mcp-3d` and complete the OAuth
flow. Then:

> "Make a 3D model of a low-poly red fox sitting upright."

Claude calls `text_to_3d`, polls `generation_status`, and renders the result as
a live, orbitable 3D artifact in the chat.

## Configuration

The server needs a Replicate token (already used by the avatar regen pipeline):

| Env | Purpose | Default |
|-----|---------|---------|
| `REPLICATE_API_TOKEN` | Required. From replicate.com/account. | — |
| `REPLICATE_RECONSTRUCT_MODEL` | image→3D model. | `firtoz/trellis` |
| `REPLICATE_TXT2IMG_MODEL` | text→image model for `text_to_3d`. | `black-forest-labs/flux-schnell` |

Rate limits: generation is capped at 12 jobs/hour per principal (real GPU
spend); status polling at 240/min.

## Publishing to the MCP Registry

The manifest is [`server-3d.json`](../server-3d.json). Publish with the
`mcp-publisher` CLI (the GitHub-namespace ownership flow proves control of the
`io.github.nirholas/*` namespace):

```bash
mcp-publisher login github
mcp-publisher publish --file server-3d.json
```

## Local development

```bash
npm run dev
npx @modelcontextprotocol/inspector http://localhost:5173/api/mcp-3d
```
