# Scenes MCP — speak a 3D world into being

Turn one sentence into a placed 3D diorama plan, forge and export it as a single GLB, and browse saved worlds, all from inside any MCP client. Scenes is the "world" that goes with an agent's character: a lighthouse on a cliff, a neon alley, a desert outpost, composed object-by-object and rendered in an orbitable viewer.

Registered in the [official MCP registry](https://registry.modelcontextprotocol.io/?q=io.github.nirholas) as **`io.github.nirholas/scene-mcp`**.

- **Install:** `npx -y @three-ws/scene-mcp`
- **npm:** [`@three-ws/scene-mcp`](https://www.npmjs.com/package/@three-ws/scene-mcp) (the package page carries the current version; `npx -y` always fetches it)
- **Transport:** stdio, no account, no key, no payment
- **Backend:** `/api/diorama` on three.ws

## Add it

Claude Code, one line:

```bash
claude mcp add scene-mcp -- npx -y @three-ws/scene-mcp
```

Or in `.mcp.json` (Claude Code / Cursor / any stdio client):

```json
{
  "mcpServers": {
    "scene-mcp": { "command": "npx", "args": ["-y", "@three-ws/scene-mcp"] }
  }
}
```

## Tools

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `compose_scene` | `prompt` *(string, 3–1024 chars, required)* | Compose a diorama **plan** from one sentence: an evocative title, a mood (`dawn`/`day`/`dusk`/`night`), ground + island type, a color palette, and 2–8 placed objects — each with its own single-object forge prompt and a position, scale, and rotation. Runs a server-side LLM chain. No meshes are generated and nothing is saved yet. |
| `get_scene` | `id` *(string, required)* | Fetch one saved, fully-forged diorama by id — its title, mood, palette, ground, and placed objects with their GLB URLs, plus the orbitable viewer URL. Read-only. |
| `list_scenes` | `list` *(`recent`\|`featured`, default `recent`)*, `limit` *(1–50, default 24)* | Browse the public gallery — the newest saved worlds or the curated featured set. Returns cards (id, title, mood, preview, view count) and each world's viewer URL. Read-only. |
| `export_scene` | `diorama` *(object, required)* | Merge an already-forged diorama (the object `compose_scene` or `get_scene` returns, with each object carrying `status:"ready"` and a real `glbUrl`) into ONE glTF 2.0 binary: every object a named, selectable node, plus a real ground disc and mood-tuned lighting. Returns `glb_url` and a ready-to-open Scene Studio link. Objects that never forged are reported in `skipped` rather than failing the export, so a partial world still exports. |
| `build_world` | `prompt` *(string, 3-1024 chars, required)* | The whole pipeline in one call, entirely server-side: compose the plan, forge every object on the free text-to-3D lane, then merge and export. Returns the populated diorama, `glb_url`, and the Scene Studio link. This is the progressive `/diorama` browser flow collapsed into one call for clients with no browser to drive it, so it can take a couple of minutes for a full object set. |

## Examples

Compose a world from a sentence:

```json
{ "prompt": "a lonely lighthouse on a stormy cliff" }
```

`compose_scene` returns a plan — the title, mood, palette, and the placed objects with per-object forge prompts. Forging the meshes and saving the world is a follow-up step on the three.ws app; once saved, the world has an id you can re-open:

```json
{ "id": "5f1c9e2a-…" }
```

Browse the curated gallery:

```json
{ "list": "featured", "limit": 10 }
```

Go from a sentence straight to a finished, openable world without touching a browser:

```json
{ "prompt": "a neon alley with a food cart and two streetlights" }
```

`build_world` returns `glb_url` plus `scene_studio_url`, and names anything that
did not forge in `skipped`. If you already have a forged diorama in hand (your
own forging after `compose_scene`, or one fetched with `get_scene`), skip
straight to the merge:

```json
{ "diorama": { "title": "Neon Alley", "mood": "night", "objects": [{ "status": "ready", "glbUrl": "https://…/cart.glb" }] } }
```

## Configuration

| Env | Purpose | Default |
|-----|---------|---------|
| `THREE_WS_BASE` | Base URL of the three.ws API serving `/api/diorama`. Override only when self-hosting or targeting a preview deployment. | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | Per-request timeout in ms for calls that do not set their own. `compose_scene` runs an LLM chain, so the default is generous. `export_scene` (60s) and `build_world` (300s) pin their own budgets, because they re-fetch every object GLB and, for `build_world`, forge the whole set first. | `45000` |

## Notes

- **No auth, no key, no payment.** `compose_scene` and `build_world` run live inference and forging server-side, `export_scene` merges real GLBs server-side, and `get_scene` and `list_scenes` are read-only.
- `export_scene` and `build_world` need the target deployment to have object storage configured. three.ws does, so the default `THREE_WS_BASE` works as-is.
- Errors are normalized with a `.code` of `timeout`, `network_error`, or `upstream_error` (the last carries `.status` and `.body`), so a client can react instead of parsing prose.

## Source & publishing

Manifest: [`packages/scene-mcp/server.json`](https://github.com/nirholas/three.ws/blob/main/packages/scene-mcp/server.json). Published to npm and the MCP registry with `npm run publish:mcp`.

See the [MCP overview](/docs/mcp) for the full catalog of three.ws MCP servers.
