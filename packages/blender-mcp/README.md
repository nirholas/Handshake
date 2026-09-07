<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/blender-mcp</h1>

<p align="center"><strong>Give any AI agent the Blender on your machine. Headless, no GUI, no add-on to install.</strong></p>

<p align="center">
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/blender-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/blender-mcp?color=339933&logo=node.js">
  <img alt="blender" src="https://img.shields.io/badge/Blender-3.0%2B-ea7600?logo=blender&logoColor=white">
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that hands an AI assistant a real Blender over stdio. Inspect a 3D file, convert between GLB, glTF, FBX, OBJ, STL, PLY, Collada, Alembic, USD and `.blend`, render an auto-framed and auto-lit preview PNG, run a `bpy` script against a scene, and generate a model from a text prompt on the free three.ws Forge lane.

Blender runs in background mode (`blender -b`), one process per call. That means it works on a server, in CI, and inside a container with no display, no GUI session to keep alive, and no add-on to install into Blender first. Everything is real: each tool drives the Blender installed on the machine, and `blender_forge_import` calls the live public three.ws generation pipeline.

## Requirements

- **Node.js 20+**
- **Blender 3.0 or newer**, installed locally. [Download](https://www.blender.org/download/) it, or install it from your package manager. If it is not on `PATH`, set `BLENDER_PATH` to the executable (`/Applications/Blender.app/Contents/MacOS/Blender` on macOS).

Call `blender_info` first if anything misbehaves: it reports the exact executable, version, render engines, and file formats this build supports.

## Install

```bash
npm install @three-ws/blender-mcp
```

Or run it with `npx` (no install):

```bash
npx -y @three-ws/blender-mcp
```

### Claude Code

```bash
claude mcp add blender -- npx -y @three-ws/blender-mcp
```

### Claude Desktop / Cursor

Paste this into your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
	"mcpServers": {
		"blender": {
			"command": "npx",
			"args": ["-y", "@three-ws/blender-mcp"]
		}
	}
}
```

Add `"env": { "BLENDER_PATH": "/path/to/blender" }` if Blender is not on `PATH`.

## Tools

| Tool | What it does |
|---|---|
| `blender_info` | Reports the Blender being driven: path, version, bundled Python, usable render engines, and the import/export formats this build actually supports. Read-only. |
| `blender_scene_info` | Opens a 3D file and describes it: objects with types, parents, dimensions and modifiers; evaluated triangle and vertex counts; materials; armature bone names; animation actions with frame ranges; world-space bounds. Read-only. |
| `blender_convert` | Imports one format and exports another, chosen by the file extensions. Applies modifiers by default and can bake in a uniform unit scale. The exact format list depends on the build (some Linux packages ship without USD, Collada, or Alembic), and `blender_info` reports what yours actually has. |
| `blender_render` | Renders a still PNG. If the file has no camera, one is created and framed to the model's bounding sphere; if it has no light, a key light and a lit world are added. A scene that already has its own camera and lighting renders as authored. |
| `blender_run_python` | Runs a `bpy` script against a scene, optionally opening a file first and exporting the result afterwards. The escape hatch for anything the other tools do not cover. |
| `blender_forge_import` | Generates a model from a text prompt on the public three.ws Forge pipeline and brings it into Blender, converting on the way in if the output asks for another format. The default image lane is free. |

### Examples

Describe a file before touching it:

```
> What is in ~/assets/character.fbx?

blender_scene_info { "input": "~/assets/character.fbx" }
→ 4 meshes, 41,208 triangles, 1 armature (67 bones), 3 actions, bounds 1.78m tall
```

Convert a client's FBX into a web-ready GLB, in metres:

```
blender_convert { "input": "character.fbx", "output": "character.glb", "scale": 0.01 }
```

See what you just made:

```
blender_render { "input": "character.glb", "output": "preview.png", "samples": 64 }
```

Halve the triangle count and export in one call:

```
blender_run_python {
  "input": "character.glb",
  "output": "character-lod1.glb",
  "code": "import bpy\nfor obj in bpy.data.objects:\n    if obj.type == 'MESH':\n        obj.modifiers.new('Decimate', 'DECIMATE').ratio = 0.5\nresult = {'meshes': len([o for o in bpy.data.objects if o.type == 'MESH'])}"
}
```

Generate an asset and open it as a `.blend`:

```
blender_forge_import { "prompt": "a weathered brass diving helmet", "output": "helmet.blend" }
```

## How a call works

Every tool call spawns `blender -b --factory-startup --python src/py/runner.py -- <job.json> <result.json>` and exits. Three consequences worth knowing:

- **`--factory-startup`** keeps your saved preferences and third-party add-ons out of the result, so a conversion produces the same file on any machine.
- **The runner writes its payload to a file, never to stdout.** Blender prints progress, add-on chatter, and render statistics on stdout, and picking a payload out of that stream is guesswork. A missing result file therefore means Blender died, and the error carries the log tail that says why.
- **One process per call.** A crashed job cannot corrupt the next one, and nothing stays resident between calls.

Failures come back as structured tool errors (`input_not_found`, `format_unsupported`, `engine_unavailable`, `timeout`, `blender_not_found`, `blender_crashed`), each with a message that says what to do about it.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BLENDER_PATH` | discovered on `PATH` and at the platform's standard install locations | Absolute path to the Blender executable. |
| `BLENDER_MCP_TIMEOUT_MS` | `300000` | Ceiling for one Blender job. |
| `BLENDER_MCP_WORKDIR` | `<tmpdir>/three-ws-blender-mcp` | Where outputs land when a tool is called without an explicit output path. |
| `BLENDER_MCP_ALLOW_PYTHON` | `1` | Set to `0` to withdraw `blender_run_python` from the advertised tool list entirely. |
| `THREE_WS_BASE` | `https://three.ws` | Deployment backing `blender_forge_import`. |
| `THREE_WS_FORGE_TIMEOUT_MS` | `600000` | Ceiling for one text-to-3D generation. |
| `THREE_WS_FORGE_PROVIDER_KEY` | unset | Meshy/Tripo key for the bring-your-own-key geometry lane. The default image lane is free and needs no key. |

## Security

`blender_run_python` executes caller-supplied Python inside Blender with the permissions of this server: it can read and write the local filesystem. That is the point of the tool, and it is annotated `destructiveHint: true` so a client can prompt before running it. For unattended or shared deployments, set `BLENDER_MCP_ALLOW_PYTHON=0` and the tool is never advertised.

Everything else stays local. Only `blender_forge_import` reaches the network, and only to the three.ws deployment named by `THREE_WS_BASE`.

## Development

```bash
node src/index.js                        # run the server over stdio
npm test                                 # offline invariants + real-Blender integration
npm run inspect                          # open the MCP Inspector against it
```

`test/registration.test.mjs` runs offline and passes with no Blender installed. `test/blender-session.test.mjs` drives the server through a real MCP stdio session against the local Blender, building its fixture with Blender itself; it skips cleanly when no Blender is present.

## Related

- [`integrations/blender/`](../../integrations/blender) is the artist-facing counterpart: a Blender add-on with a sidebar panel that generates three.ws models from inside the GUI. This package is the agent-facing one.
- [`@three-ws/scene-mcp`](../scene-mcp) composes whole 3D worlds from a sentence.
- [three.ws](https://three.ws) is the platform behind the Forge pipeline.

## License

Apache-2.0
