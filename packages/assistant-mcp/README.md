<p align="center">
  <a href="https://three.ws/assistant"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/assistant-mcp</h1>

<p align="center"><strong>Generate a paste-ready three.ws assistant widget, a floating 3D avatar chatbot for any website, from any AI agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/assistant-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/assistant-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/assistant-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/assistant-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that lets any AI assistant build a paste-ready embed for the three.ws **assistant widget** over stdio. Describe how you want the assistant to look and behave and `build_assistant_widget` returns a ready-to-paste `<script>` tag, a standalone frame URL for `<iframe>` embedding, and an equivalent `ThreeAssistant.init({...})` JavaScript-API snippet, a floating 3D avatar chatbot that lives in the corner of any site. `list_assistant_options` enumerates every built-in avatar, background preset, interaction mode, chat lane, and `data-*` attribute you can set.

Both tools are **pure and offline**: building an embed is deterministic string logic over local validators. Every field is validated and clamped, so a bad or hostile value falls back to a safe default and the generated HTML is always well-formed. No API key, no signer, no payment, no network call. Point `THREE_WS_BASE` at a deployment (or leave the default) and go.

## Install

```bash
npm install @three-ws/assistant-mcp
```

Or run with `npx` (no install):

```bash
npx -y @three-ws/assistant-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add assistant -- npx -y @three-ws/assistant-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"assistant": {
			"command": "npx",
			"args": ["-y", "@three-ws/assistant-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/assistant-mcp
```

## Tools

| Tool                     | Type      | What it does                                                                                                          |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `build_assistant_widget` | read-only | A config → a paste-ready `<script>` embed (non-default settings as `data-*`), a frame URL, a `ThreeAssistant.init()` snippet, and the normalized config. |
| `list_assistant_options` | read-only | Enumerate every built-in avatar, background preset and grammar, interaction mode, chat lane, and the full `data-*` attribute reference. |

`build_assistant_widget` is a pure function: the same config always yields the same embed, and it never touches the network. The generated `<script>` tag carries **only** the settings that differ from their defaults, so a minimal config yields a minimal tag. The `frame_url` carries every resolved value (including defaults) so the standalone frame renders deterministically when dropped into an `<iframe>`.

### Input parameters

**`build_assistant_widget`**, all optional:

| Field        | Type / values                                                                              | Default       |
| ------------ | ------------------------------------------------------------------------------------------ | ------------- |
| `avatar`     | avatar id, `/avatars/*.glb` path, or GLB URL                                                | mannequin     |
| `agent`      | a three.ws agent id (alternative to `avatar`)                                               | (none)        |
| `background` | `transparent` \| `#hex` \| `ember`/`ocean`/`violet`/`forest`/`dusk`/`slate` \| `gradient:#a,#b[,angle]` | `transparent` |
| `mode`       | `chat` \| `speak` \| `both`                                                                 | `both`        |
| `name`       | string (≤ 60)                                                                               | (none)        |
| `greeting`   | string (≤ 200)                                                                              | (none)        |
| `context`    | string (≤ 500), what the assistant should know about the site                             | (none)        |
| `accent`     | `#hex`                                                                                      | `#f97316`     |
| `position`   | `right` \| `left`                                                                           | `right`       |
| `voice`      | boolean, start with voice on/off                                                           | on            |
| `badge`      | boolean, show the three.ws attribution badge                                               | on            |

Any value that fails validation (a bad hex, an unknown background, an over-long string) falls back to its default rather than being rejected, so you always get a working embed.

**`list_assistant_options`**, `filter` (optional: `avatars` \| `backgrounds` \| `modes` \| `chat_lanes` \| `attributes`). Omit to get everything.

## Example

```jsonc
// build_assistant_widget
> {
    "avatar": "/avatars/selfie-girl.glb",
    "background": "ocean",
    "mode": "both",
    "name": "Aria",
    "greeting": "Hi! Ask me anything about the site.",
    "accent": "#00c2ff",
    "position": "left"
  }
{
  "ok": true,
  "snippet": "<script src=\"https://three.ws/assistant/v1.js\" async data-avatar=\"/avatars/selfie-girl.glb\" data-bg=\"ocean\" data-name=\"Aria\" data-greeting=\"Hi! Ask me anything about the site.\" data-accent=\"#00c2ff\" data-position=\"left\"></script>",
  "frame_url": "https://three.ws/assistant-frame?avatar=%2Favatars%2Fselfie-girl.glb&bg=ocean&mode=both&name=Aria&greeting=Hi%21+Ask+me+anything+about+the+site.&accent=%2300c2ff",
  "js_api": "ThreeAssistant.init({\n  \"bg\": \"ocean\",\n  \"mode\": \"both\",\n  \"accent\": \"#00c2ff\",\n  \"position\": \"left\",\n  \"avatar\": \"/avatars/selfie-girl.glb\",\n  \"name\": \"Aria\",\n  \"greeting\": \"Hi! Ask me anything about the site.\"\n});",
  "builder_url": "https://three.ws/assistant",
  "config": { "bg": "ocean", "mode": "both", "accent": "#00c2ff", "position": "left", "avatar": "/avatars/selfie-girl.glb", "name": "Aria", "greeting": "Hi! Ask me anything about the site." },
  "notes": "Chat runs on the free three.ws LLM chain by default (no key). Visitors can paste their own Groq or OpenRouter key in the widget settings for a private lane; that key stays in their browser."
}
```

Paste the `snippet` before `</body>` on any page, or drop the `frame_url` into an `<iframe>`. Design it visually first at [three.ws/assistant](https://three.ws/assistant).

## Requirements

- **Node.js >= 20.**
- No network access needed. `THREE_WS_BASE` only sets the origin baked into the generated URLs.

### Environment variables

| Variable        | Required | Default            |
| --------------- | -------- | ------------------ |
| `THREE_WS_BASE` | no       | `https://three.ws` |

## Programmatic use

The package entry point exports **`TOOLS`** (every tool definition: `name`, `title`,
`description`, `inputSchema`, `annotations`, `handler`) and **`buildServer()`**, which returns a
fully-registered `McpServer` with no transport attached. Both tools are pure and offline, so you
can call them directly as a widget-builder library with no MCP client involved.

```js
// run from a checkout: node this-file.mjs
import { TOOLS, buildServer } from '@three-ws/assistant-mcp';

const build = TOOLS.find((t) => t.name === 'build_assistant_widget');
const { snippet } = await build.handler({ avatar: '/avatars/michelle.glb', background: 'dusk' });
console.log(snippet);

// Or hand the whole registered server to your own MCP transport.
buildServer();
```

```html
<script src="https://three.ws/assistant/v1.js" async data-avatar="/avatars/michelle.glb" data-bg="dusk"></script>
```

## Links

- Builder: https://three.ws/assistant
- Docs: https://three.ws/docs/assistant-widget
- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite, 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
