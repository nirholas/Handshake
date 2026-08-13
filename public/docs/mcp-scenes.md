# Scenes MCP — speak a 3D world into being

Turn one sentence into a placed 3D diorama plan, then forge and browse saved worlds — from inside any MCP client. Scenes is the "world" that goes with an agent's character: a lighthouse on a cliff, a neon alley, a desert outpost, composed object-by-object and rendered in an orbitable viewer.

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

## Configuration

| Env | Purpose | Default |
|-----|---------|---------|
| `THREE_WS_BASE` | Base URL of the three.ws API serving `/api/diorama`. Override only when self-hosting or targeting a preview deployment. | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | Per-request timeout in ms. `compose_scene` runs an LLM chain, so the default is generous. | `45000` |

## Notes

- **No auth, no key, no payment.** `compose_scene` runs live inference server-side; `get_scene` and `list_scenes` are read-only.
- Errors are normalized with a `.code` of `timeout`, `network_error`, or `upstream_error` (the last carries `.status` and `.body`), so a client can react instead of parsing prose.

## Source & publishing

Manifest: [`packages/scene-mcp/server.json`](https://github.com/nirholas/three.ws/blob/main/packages/scene-mcp/server.json). Published to npm and the MCP registry with `npm run publish:mcp`.

See the [MCP overview](/docs/mcp) for the full catalog of three.ws MCP servers.
