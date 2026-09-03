<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/loom-mcp</h1>

<p align="center"><strong>Loom — the three.ws community 3D-creation gallery, from any AI agent. Browse the public feed of community-forged GLB creations, fetch one with its viewer URL, and submit your own.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/loom-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/loom-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/loom-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/loom-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes **Loom**, the three.ws community 3D-creation gallery, over stdio. Browse what others have forged, pull any creation with a ready-to-embed viewer URL, and contribute your own GLB to the public feed.

Loom closes the loop with the rest of the three.ws 3D suite: forge a model with [`@three-ws/avatar-agent`](https://www.npmjs.com/package/@three-ws/avatar-agent) or compose a world with [`@three-ws/scene-mcp`](https://www.npmjs.com/package/@three-ws/scene-mcp), then **publish it here** for the whole platform to see. Every read is live and public; submitting needs no key or account — it is gated server-side only by an IP rate limit.

## Install

```bash
npm install @three-ws/loom-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/loom-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add loom -- npx -y @three-ws/loom-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"loom": {
			"command": "npx",
			"args": ["-y", "@three-ws/loom-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/loom-mcp
```

## Tools

| Tool              | Type      | What it does                                                                                                       |
| ----------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `get_loom_feed`   | read-only | Browse the public gallery of community-forged 3D creations, newest-first, paginated via a `nextBefore` cursor.     |
| `get_creation`    | read-only | Fetch one creation by id, with its full metadata and an inline-previewable viewer URL + iframe.                    |
| `submit_creation` | write     | Contribute a forged GLB to the public gallery. No key required; rate-limited (~20/hour per IP).                    |

Each read returns the creation's `glbUrl` plus a `viewer_url` (the `/forge/embed` orbit + AR viewer), an `og_image_url` (social card), and a paste-ready `iframe_snippet`, so any MCP client can preview the model inline.

### Input parameters

**`get_loom_feed`** — `limit` (1–120, default 60), `before` (ms-epoch cursor; pass the prior page's `nextBefore` to page backwards).

**`get_creation`** — `id` (required — the creation UUID).

**`submit_creation`** — `prompt` (required, ≤1000 chars), `glbUrl` (required — see allowed hosts below), `author` (optional attribution, ≤40 chars, defaults to `anon`), `previewImageUrl`, `tier`, `backend` (all optional).

## Submitting a creation

`submit_creation` posts to the **public, world-readable** gallery — only submit models you intend to share. There is **no account, key, or signer**: the endpoint is open and gated server-side by an IP rate limit (~20 submissions/hour) plus strict input sanitization. `author` is **free-text attribution, not an authenticated identity**.

The `glbUrl` must be an **https** URL hosted on one of these domains (enforced both client-side here and server-side):

`three.ws` · `r2.dev` · `cloudflarestorage.com` · `replicate.delivery` · `githubusercontent.com`

Re-submitting the exact same `glbUrl` returns the existing creation instead of duplicating it. The dedupe is best-effort by design: it scans only the newest few entries, which is where an accidental re-POST lands. Re-submitting a GLB that has since scrolled down the feed creates a second record.

`get_creation` answers an id that no longer exists with a typed **`not_found`** error rather than an empty creation, so a stale id in a saved reference is unambiguous.

## Example

```jsonc
// submit_creation
> {
    "prompt": "a cowboy hat, low-poly",
    "glbUrl": "https://three.ws/accessories/hat-cowboy.glb",
    "author": "nova",
    "backend": "hunyuan"
  }
{
  "ok": true,
  "creation": {
    "id": "f295398e-2d25-410d-a82f-c8725295a1b3",
    "prompt": "a cowboy hat, low-poly",
    "glbUrl": "https://three.ws/accessories/hat-cowboy.glb",
    "author": "nova",
    "createdAt": 1750000000000,
    "viewer_url": "https://three.ws/forge/embed?src=https%3A%2F%2Fthree.ws%2Faccessories%2Fhat-cowboy.glb&title=a+cowboy+hat%2C+low-poly",
    "og_image_url": "https://three.ws/api/avatar-og?src=https%3A%2F%2Fthree.ws%2Faccessories%2Fhat-cowboy.glb",
    "iframe_snippet": "<iframe src=\"https://three.ws/forge/embed?src=…\" width=\"640\" height=\"360\" …></iframe>"
  }
}
```

```jsonc
// get_loom_feed
> { "limit": 2 }
{ "ok": true, "count": 2, "nextBefore": 1749999000000, "has_more": true,
  "creations": [ { "id": "…", "prompt": "…", "glbUrl": "…", "viewer_url": "…", "iframe_snippet": "…" } ] }
```

Drop a creation's `iframe_snippet` onto any web page, or open its `viewer_url` to orbit the model (with AR on supported devices).

## Examples

Runnable examples live in [`examples/`](./examples):

```bash
node examples/list-tools.mjs     # all 3 tools with their full input schemas
node examples/browse-loom.mjs    # a page of the gallery + one creation's embed, live
```

Both spawn this server over stdio and read the live public gallery. They are
deliberately read-only: `submit_creation` posts to a world-readable feed, so no
example writes on your behalf. See [`examples/README.md`](./examples/README.md)
for expected output.

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable              | Required | Default            |
| --------------------- | -------- | ------------------ |
| `THREE_WS_BASE`       | no       | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | no       | `20000`            |

No API key, signer, or account is needed for any tool.

## Links

- Homepage: https://three.ws
- Forge gallery: https://three.ws/forge
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
