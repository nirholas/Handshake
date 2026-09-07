# Blender MCP

`@three-ws/blender-mcp` hands an AI assistant the Blender installed on your own machine. It speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio, and it drives Blender in background mode: no GUI session has to be open, no add-on has to be installed into Blender first, and nothing stays resident between calls.

That makes it the piece that sits under the three.ws pipeline rather than beside it. Forge generates a model; this reads it, converts it, previews it, and edits it, using the most complete format bridge that exists offline.

---

## What it is for

| You want to | Tool |
|---|---|
| Know what is actually inside a file a client sent you | `blender_scene_info` |
| Turn an FBX or a USD into a web-ready GLB (or the reverse) | `blender_convert` |
| See a model without opening anything | `blender_render` |
| Do something no single tool covers: decimate, join, rename bones, bake | `blender_run_python` |
| Generate an asset from a sentence and open it | `blender_forge_import` |
| Find out why one of the above failed | `blender_info` |

---

## Requirements

- **Node.js 20+**
- **Blender 3.0 or newer**, installed locally: [blender.org/download](https://www.blender.org/download/), or your package manager.

If Blender is not on `PATH`, set `BLENDER_PATH` to the executable. On macOS that is `/Applications/Blender.app/Contents/MacOS/Blender`.

Some Linux distribution packages ship Blender without the Python modules its glTF add-on needs. `blender_info` tells you what the local build can really do, which turns that class of problem into one clear answer instead of a confusing failure inside an unrelated call.

---

## Install

### Claude Code

```bash
claude mcp add blender -- npx -y @three-ws/blender-mcp
```

In this repository the server is already declared in [`.mcp.json`](../.mcp.json) and runs straight from the working tree:

```json
{
	"mcpServers": {
		"blender": {
			"command": "node",
			"args": ["packages/blender-mcp/src/index.js"]
		}
	}
}
```

### Claude Desktop / Cursor

```json
{
	"mcpServers": {
		"blender": {
			"command": "npx",
			"args": ["-y", "@three-ws/blender-mcp"],
			"env": { "BLENDER_PATH": "/Applications/Blender.app/Contents/MacOS/Blender" }
		}
	}
}
```

---

## Tools

### `blender_info`

No arguments. Reports the executable path, Blender version, bundled Python version, the render engines that are genuinely usable on this build, and the import/export extensions it supports. Read-only.

Call it first whenever anything else fails: it separates "Blender is missing" from "this build cannot do that" from "the file is wrong".

### `blender_scene_info`

| Argument | Type | Notes |
|---|---|---|
| `input` | string, required | Path to the file. Absolute, or relative to the server's working directory. |
| `include_objects` | boolean | Include the per-object breakdown. Set `false` on huge scenes for totals only. Default `true`. |

Opens a `.blend`, or imports any supported format into an empty scene, and describes it: objects with type, parent, dimensions, modifiers, materials and UV layers; **evaluated** triangle and vertex counts, so a subdivision modifier is counted as what it renders, not what it stores; armature bone names; animation actions with frame ranges; and world-space bounds. The file is never modified.

```
blender_scene_info { "input": "~/assets/character.fbx" }
```

### `blender_convert`

| Argument | Type | Notes |
|---|---|---|
| `input` | string, required | Source file. |
| `output` | string | Destination. Its extension picks the format. Defaults to a `.glb` in the workdir. |
| `apply_modifiers` | boolean | Bake modifiers into the exported geometry. Default `true`. |
| `scale` | number | Uniform scale baked into the export, e.g. `0.01` for centimetres to metres. |

Both sides accept `.glb`, `.gltf`, `.fbx`, `.obj`, `.stl`, `.ply`, `.dae`, `.abc`, `.usd`, `.usda`, `.usdc`, `.usdz`, `.x3d`, and `.blend`, as far as the local build supports them: several Linux distribution packages ship Blender without USD, Collada, or Alembic. `blender_info` lists what yours really has, and asking for one it lacks fails immediately with `format_unsupported` rather than part way through an export.

```
blender_convert { "input": "character.fbx", "output": "character.glb", "scale": 0.01 }
```

### `blender_render`

| Argument | Type | Notes |
|---|---|---|
| `input` | string, required | File to render. |
| `output` | string | Destination PNG. Defaults into the workdir. |
| `engine` | enum | `auto` (default), `CYCLES`, `BLENDER_EEVEE`, `BLENDER_WORKBENCH`. |
| `samples` | integer | Default `32`, enough for a preview. |
| `resolution` | `[width, height]` | Default `[960, 960]`. |
| `transparent` | boolean | Transparent background instead of the world. Default `false`. |

An asset file usually carries no camera and no lights, which is why rendering one straight out of a converter normally produces a black square. This tool fills both in: it creates a camera and frames it to the geometry's bounding sphere, and adds a key light and a lit world. A scene that already has its own camera and lighting is rendered exactly as authored, and the response says which of the two happened (`camera_created`, `lights_created`).

`auto` picks Cycles, which renders on CPU and therefore works in a container. EEVEE is far faster but needs a real GPU context.

### `blender_run_python`

| Argument | Type | Notes |
|---|---|---|
| `code` | string, required | Python to execute. `bpy`, `math` and `Vector` are already imported. |
| `input` | string | File to open first. Omit to start from an empty scene. |
| `output` | string | Export the result here afterwards; the extension picks the format. |
| `apply_modifiers` | boolean | Apply modifiers on that export. Default `true`. |

Anything printed comes back as `stdout`. Assigning a JSON-serializable value to a variable named `result` returns it as structured data alongside the post-run scene counts.

```
blender_run_python {
  "input": "character.glb",
  "output": "character-lod1.glb",
  "code": "import bpy\nfor obj in bpy.data.objects:\n    if obj.type == 'MESH':\n        obj.modifiers.new('Decimate', 'DECIMATE').ratio = 0.5\nresult = {'meshes': len([o for o in bpy.data.objects if o.type == 'MESH'])}"
}
```

This tool runs caller-supplied code with the server's own permissions. See [Security](#security).

### `blender_forge_import`

| Argument | Type | Notes |
|---|---|---|
| `prompt` | string, required | One subject, e.g. `a weathered brass diving helmet`. |
| `output` | string | Destination. `.glb` keeps the generated bytes untouched; any other extension converts on the way in. |
| `tier` | enum | `draft`, `standard` (default), `high`. |
| `lane` | enum | `image` (default, free), `geometry` (Meshy/Tripo, needs a key), `sketch`. |
| `backend` | string | Pin a backend. Omit to let the deployment choose for the tier. |
| `aspect_ratio` | enum | Reference image ratio. Default `1:1`. |

Runs the public [`/api/forge`](./3d-api.md) pipeline: the default image lane (FLUX to TRELLIS) is free and needs no key, wallet, or account. When the output asks for a non-GLB format, the untouched GLB is kept beside it as `<name>.source.glb`, because conversion is lossy for some targets and the original is what the rest of the three.ws pipeline consumes.

Generation runs on a shared GPU lane and typically takes tens of seconds to a couple of minutes.

```
blender_forge_import { "prompt": "a weathered brass diving helmet", "output": "helmet.blend" }
```

---

## How a call works

Every tool call spawns one process:

```
blender -b --factory-startup -noaudio --python src/py/runner.py -- <job.json> <result.json>
```

Three design decisions are worth knowing, because they are what makes the tools predictable:

1. **`--factory-startup`** keeps your saved preferences and third-party add-ons out of the result, so the same conversion produces the same file on any machine.
2. **The runner writes its payload to a file, never to stdout.** Blender prints progress, add-on chatter and render statistics on stdout; picking a payload out of that stream is guesswork. A missing result file is therefore an unambiguous "Blender died", and the error carries the log tail that says why.
3. **One process per call.** A crashed job cannot corrupt the next one, and no state leaks between calls.

Every operator is resolved by name with fallbacks and every keyword is filtered against the operator's own RNA before the call, so the importer and exporter renames between Blender 3.x and 4.x do not break a tool.

## Errors

Failures come back as structured tool errors, each naming a fix:

| Code | Meaning |
|---|---|
| `blender_not_found` | No Blender on `PATH` or at the standard locations. Install it, or set `BLENDER_PATH`. |
| `blender_too_old` | Found a Blender older than 3.0. |
| `input_not_found` | The path does not exist or is unreadable. |
| `format_unsupported` | This build has no importer or exporter for that extension. The message lists the ones it does have. |
| `engine_unavailable` | The requested render engine is not in this build. |
| `timeout` | The job passed `BLENDER_MCP_TIMEOUT_MS` and was killed. |
| `blender_crashed` | Blender exited without writing a result. The error carries its log tail. |

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BLENDER_PATH` | discovered | Absolute path to the Blender executable. |
| `BLENDER_MCP_TIMEOUT_MS` | `300000` | Ceiling for one Blender job. |
| `BLENDER_MCP_WORKDIR` | `<tmpdir>/three-ws-blender-mcp` | Where outputs land with no explicit output path. |
| `BLENDER_MCP_ALLOW_PYTHON` | `1` | `0` withdraws `blender_run_python` from the tool list entirely. |
| `THREE_WS_BASE` | `https://three.ws` | Deployment backing `blender_forge_import`. |
| `THREE_WS_FORGE_TIMEOUT_MS` | `600000` | Ceiling for one generation. |
| `THREE_WS_FORGE_PROVIDER_KEY` | unset | Meshy/Tripo key for the bring-your-own-key geometry lane. |

## Security

`blender_run_python` executes caller-supplied Python inside Blender with this server's permissions, including filesystem access. That is what the tool is for, and it is annotated `destructiveHint: true` so a client prompts before running it. For unattended or shared deployments set `BLENDER_MCP_ALLOW_PYTHON=0`: the tool is then never advertised, and the other five keep working.

Only `blender_forge_import` reaches the network, and only the deployment named by `THREE_WS_BASE`. Everything else stays on the machine. The broader model is in [MCP safety](./mcp-safety.md).

---

## Related

- [`integrations/blender/`](https://github.com/nirholas/three.ws/tree/main/integrations/blender) is the artist-facing counterpart: a Blender add-on with a sidebar panel that generates three.ws models from inside the GUI. This server is the agent-facing one; they can be installed side by side.
- [MCP integration](./mcp.md) lists every three.ws MCP server.
- [3D API](./3d-api.md) documents the Forge endpoints behind `blender_forge_import`.
- [Scenes MCP](https://www.npmjs.com/package/@three-ws/scene-mcp) composes whole 3D worlds from one sentence.
