<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/avatar-mcp</h1>

<p align="center"><strong>An MCP server that drops a live, rotatable 3D avatar into any chat — interactive in the conversation, embeddable anywhere. Free, no API key.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/avatar-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/avatar-mcp?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/avatar-mcp"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/avatar-mcp?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/avatar-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/avatar-mcp?color=339933&logo=node.js">
  <a href="https://modelcontextprotocol.io"><img alt="mcp" src="https://img.shields.io/badge/Model%20Context%20Protocol-✓-9945FF"></a>
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas%2Fthreews--avatar-blue"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#setup">Setup</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#requirements">Requirements</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> A thin, zero-config, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that brings three.ws 3D avatars into any MCP client — Claude Desktop, Claude Code, Cursor, or any other host. Render a live, rotatable avatar inline, get a paste-anywhere embed iframe, or fetch avatar metadata. Every tool reads live from the real three.ws endpoints — no mock data. Public and unlisted avatars need **no API key**. Registry name: `io.github.nirholas/threews-avatar`. Built by [three.ws](https://three.ws).

Need wallets, voice, generation, or pump.fun powers? See the sibling package [`@three-ws/avatar-agent`](https://www.npmjs.com/package/@three-ws/avatar-agent), a full 3D AI agent in a box.

## Install

```bash
npm install @three-ws/avatar-mcp
```

Run it directly with `npx` (no install needed) or install globally for the `avatar-mcp` CLI:

```bash
npx -y @three-ws/avatar-mcp           # MCP stdio server
npm install -g @three-ws/avatar-mcp   # exposes `avatar-mcp`
```

## Setup

**Claude Code**, one line:

```bash
claude mcp add threews-avatar -- npx -y @three-ws/avatar-mcp
```

**Claude Desktop / Cursor** (JSON config):

```json
{
	"mcpServers": {
		"threews-avatar": {
			"command": "npx",
			"args": ["-y", "@three-ws/avatar-mcp"]
		}
	}
}
```

No environment variables are required. To read avatars from a different host (e.g. a preview deployment), set `THREEWS_BASE_URL`. Restart your client after editing the config.

Inspect the tool surface in a GUI:

```bash
npx -y @modelcontextprotocol/inspector npx -y @three-ws/avatar-mcp
```

## Quick start

Once connected, ask your client in plain language:

> Render avatar bf58f7fc-64b3-4a92-8c27-dd472fc04b58 in the chat, dark background, auto-rotating.

(That UUID is a real public avatar. Any avatar's id is the last path segment of
its three.ws URL, and `GET https://three.ws/api/avatars/public` lists more. A
`@handle` works too, for any three.ws user who has published a public avatar.)

`render_avatar` returns three things so it looks great in every client:

1. a **preview image** that renders inline everywhere,
2. an **interactive `text/html` resource** — a real `<model-viewer>` you can orbit and zoom, for hosts that render HTML resources, and
3. the **embed URL + iframe** to drop the live avatar into any page.

## Tools

All three tools are free, read-only, and annotated (`readOnlyHint`, `idempotentHint`, `openWorldHint`) so hosts can run them without confirmation prompts. There is no x402 charge. Identify an avatar by **`id`** (UUID), **`handle`** (a three.ws username, with or without the `@`, that has a public avatar), or a raw **`model`** GLB URL.

| Tool                | Selectors                 | What it does                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render_avatar`     | `id` · `handle` · `model` | Renders the avatar inline. On [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)-capable hosts it shows a **live, rotatable 3D model right in the chat**; other clients get a preview image + embed URL. Params: `background` (`transparent`/`dark`/`light`), `scene` (`portrait`/`headshot`/`upper-body`/`full-body`), `auto_rotate`, `height` (160–1080). |
| `avatar_embed_code` | `id` · `handle` · `model` | Returns a ready-to-paste `<iframe>` that embeds the live avatar anywhere — as easy as a YouTube embed. Params: `background`, `width` (CSS), `height` (160–1080), `idle` (loop the idle animation), `overlay` (chrome-free mode for OBS/overlays).                                                                                                                             |
| `get_avatar`        | `id` · `handle`           | Fetches avatar metadata: `name`, GLB `model_url`, owner, visibility.                                                                                                                                                                                                                                                                                                          |

### Interactive 3D in the chat — the differentiator

`render_avatar` is an [MCP App](https://modelcontextprotocol.io/extensions/apps/overview) (SEP-1865): it declares a `ui://` resource that supporting hosts render in a sandboxed iframe — a real, orbit-and-zoom `<model-viewer>`, not a static image. The avatar is live in the conversation: rotate it, zoom it, watch it idle, without leaving the chat. Hosts without MCP Apps support still get a rendered preview image and a one-tap live embed, so the tool degrades gracefully everywhere.

### Example calls

```jsonc
// render_avatar — live, rotatable avatar in chat
{ "id": "bf58f7fc-64b3-4a92-8c27-dd472fc04b58", "background": "dark", "auto_rotate": true }

// avatar_embed_code — paste into any website
{ "id": "bf58f7fc-64b3-4a92-8c27-dd472fc04b58", "height": 560 }

// get_avatar: metadata, by @handle instead of id
{ "handle": "@your-handle" }
```

`get_avatar` on that id returns, live:

```json
{
	"id": "bf58f7fc-64b3-4a92-8c27-dd472fc04b58",
	"name": "Jade",
	"slug": "jade-fe1a51",
	"model_url": "https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/u/299bdfa7-d848-4865-bdb1-0db23fc3b431/jade-fe1a51.glb",
	"thumbnail": null,
	"visibility": "public"
}
```

Every tool also advertises an `outputSchema` describing its `structuredContent`, so typed clients can consume results without re-parsing the text blocks.

## Prompts

| Prompt            | Arguments                       | What it does                                                                                                                                              |
| ----------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `showcase-avatar` | `avatar` — id (UUID) or @handle | One-step showcase: renders the live, rotatable avatar inline **and** produces the embed iframe, ending with a copy-paste summary (name, viewer URL, embed URL, `<iframe>` snippet). |

## How it works

Each selector maps to a real three.ws endpoint. Raw `model` URLs must be `https://` (or `http://localhost` for dev); other schemes are rejected.

| Selector / asset | Endpoint                                            |
| ---------------- | --------------------------------------------------- |
| `id`             | `GET https://three.ws/api/avatars/:id`              |
| `handle`         | `GET https://three.ws/api/users/:handle/avatar`     |
| preview image    | `GET https://three.ws/api/avatar/render?avatar=:id` |
| live embed       | `https://three.ws/avatar-embed.html?...`            |
| viewer           | `https://three.ws/viewer?src=:glb`                  |

## Requirements

- **Node** `>=20`.
- **No credentials.** Public and unlisted avatars need no API key.

| Variable             | Required | Notes                                                       |
| -------------------- | -------- | ----------------------------------------------------------- |
| `THREEWS_BASE_URL`   | Optional | three.ws host to read from. Defaults to `https://three.ws`. |
| `THREEWS_TIMEOUT_MS` | Optional | Per-request network timeout. Defaults to `30000`.           |

## Links

- Homepage: https://three.ws
- Sibling package: [`@three-ws/avatar-agent`](https://www.npmjs.com/package/@three-ws/avatar-agent) — full 3D AI agent (wallet, voice, pump.fun)
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
