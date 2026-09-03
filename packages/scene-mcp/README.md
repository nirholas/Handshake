<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/scene-mcp</h1>

<p align="center"><strong>Speak 3D worlds into being: turn one sentence into a placed diorama from any AI agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/scene-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/scene-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/scene-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/scene-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI assistant the three.ws **diorama** pipeline over stdio. Describe a world in a sentence and `compose_scene` returns a placed plan (mood, palette, ground, and a set of single-object forge prompts), ready to build into an orbitable 3D scene. `build_world` collapses the whole pipeline (compose → forge every object → merge) into one call for agents with no browser to drive it. `export_scene` merges an already-forged diorama into one glTF 2.0 binary (every object a named, selectable node, plus ground and mood-tuned lighting), ready to open in Scene Studio. Browse saved worlds with `get_scene` and `list_scenes`.

This is the companion to the three.ws avatar one-liner: avatars give you a *character*; scenes give you a *world*. No API key, no signer, no payment: every call hits the public `/api/diorama` endpoint.

## Install

```bash
npm install @three-ws/scene-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/scene-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add scene -- npx -y @three-ws/scene-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"scene": {
			"command": "npx",
			"args": ["-y", "@three-ws/scene-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/scene-mcp
```

## Tools

| Tool            | Type        | What it does                                                                                                       |
| --------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `compose_scene` | generative  | One sentence → a diorama plan: title, mood, palette, ground, and 2-8 placed single-object forge prompts.           |
| `build_world`   | generative  | One sentence → a fully forged, exported 3D world in one call: compose → forge every object (free lane) → merge into one GLB. No browser needed; can take a couple of minutes. |
| `export_scene`  | generative  | Merge an already-forged diorama (objects with real `glbUrl`s) into one glTF 2.0 binary (named, selectable nodes plus ground and mood-tuned lighting), ready for Scene Studio. |
| `get_scene`     | read-only   | Fetch a saved world by id (with GLB URLs) and its orbitable viewer URL.                                            |
| `list_scenes`   | read-only   | Browse the recent or featured diorama gallery.                                                                     |

`compose_scene` returns only the *plan*: no meshes are forged and nothing is saved. Forge each object via `/api/forge`, then either call `export_scene` yourself or `POST /api/diorama {action:"save"}` to mint a shareable permalink at `https://three.ws/diorama?id=…`. `build_world` does the compose-forge-export sequence for you in a single tool call. Both `build_world` and `export_scene` degrade gracefully on partial failure: objects that never forge are skipped and named in the response's `skipped` array; the rest of the world still exports.

### Input parameters

**`compose_scene`**: `prompt` (required, 3-1024 chars: one sentence describing the world).

**`build_world`**: `prompt` (required, 3-1024 chars: one sentence describing the world).

**`export_scene`**: `diorama` (required: the diorama object returned by `compose_scene`/`get_scene`, with each object to include carrying `status:"ready"` and a real `glbUrl`).

**`get_scene`**: `id` (required: the diorama id returned at save time).

**`list_scenes`**: `list` (`recent` | `featured`, default `recent`), `limit` (1-50, default 24).

## Example

```jsonc
// compose_scene
> { "prompt": "a lonely lighthouse on a stormy cliff at dusk" }
{
  "ok": true,
  "diorama": {
    "title": "Beacon at Dusk",
    "mood": "dusk",
    "ground": "stone",
    "island": "craggy",
    "palette": { "sky": ["#2b2350", "#c76b4a"], "ground": "#5b5560", "fog": "#3a3550", "accent": "#ffb27a" },
    "objects": [
      { "id": "obj-0", "label": "lighthouse", "prompt": "white-and-red striped stone lighthouse", "position": [0, 0, 0], "scale": 2.2, "rotationY": 0, "status": "pending", "glbUrl": null }
    ]
  },
  "object_count": 1,
  "viewer_base": "https://three.ws/diorama"
}
```

```jsonc
// build_world: the whole pipeline in one call
> { "prompt": "a neon alley with a food cart and two streetlights" }
{
  "ok": true,
  "diorama": { "title": "Neon Alley", "mood": "night", /* ...forged objects with real glbUrl values... */ },
  "object_count": 4,
  "ready_count": 4,
  "glb_url": "https://storage.googleapis.com/.../scene-neon-alley.glb",
  "scene_studio_url": "https://three.ws/scene?model=https%3A%2F%2Fstorage.googleapis.com%2F...%2Fscene-neon-alley.glb",
  "exported_count": 4,
  "skipped": []
}
```

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable              | Required | Default            |
| --------------------- | -------- | ------------------ |
| `THREE_WS_BASE`       | no       | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | no       | `45000`            |

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite: 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
