<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/marketplace-mcp</h1>

<p align="center"><strong>Browse the three.ws agent marketplace and skills catalog from any AI agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/marketplace-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/marketplace-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/marketplace-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/marketplace-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI assistant **browse and discovery** of the three.ws marketplace over stdio. Search and page the published agents, drill into one by id, and explore the reusable skills catalog — all from the public three.ws API.

No API key, no signer, no payment — every call hits the public `/api/marketplace` and `/api/skills` endpoints. Creating or publishing agents and skills is the *authenticated write path* on the HTTP API; this server exposes browse/discovery only.

## Install

```bash
npm install @three-ws/marketplace-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/marketplace-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add marketplace -- npx -y @three-ws/marketplace-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"marketplace": {
			"command": "npx",
			"args": ["-y", "@three-ws/marketplace-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/marketplace-mcp
```

## Tools

| Tool                | Type      | What it does                                                                                          |
| ------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `browse_agents`     | read-only | Search & page the agent marketplace — filter by category and query, sort, paginate by cursor.         |
| `agent_detail`      | read-only | Fetch one published agent by id (system prompt, capabilities, author, ratings, skill prices, avatar). |
| `agent_categories`  | read-only | List agent categories with the count of published agents in each, plus the overall total.             |
| `browse_skills`     | read-only | Search & page the skills catalog — filter by query and category, sort, paginate by cursor.            |
| `skill_categories`  | read-only | List skill categories that have at least one public skill, each with a slug, label, and count.        |

### Input parameters

**`browse_agents`** — `category` (optional slug), `q` (optional free text), `sort` (`recommended` | `recent` | `popular` | `top_rated`, default `recommended`), `limit` (1–48, default 24), `cursor` (optional pagination cursor).

**`agent_detail`** — `id` (required: the agent's UUID, from a `browse_agents` card).

**`agent_categories`** — no parameters.

**`browse_skills`** — `q` (optional free text), `category` (optional slug), `sort` (`popular` | `new` | `az`, default `popular`), `limit` (1–50, default 20), `cursor` (optional pagination cursor).

**`skill_categories`** — no parameters.

## Example

```jsonc
// browse_agents
> { "q": "code review", "sort": "top_rated", "limit": 3 }
{
  "ok": true,
  "items": [
    {
      "id": "a1b2c3d4-…",
      "name": "Code Reviewer",
      "description": "Reviews diffs for bugs and style.",
      "category": "programming",
      "tags": ["code", "review"],
      "rating_avg": 4.8,
      "rating_count": 22,
      "views_count": 1340,
      "forks_count": 41,
      "thumbnail_url": "https://…",
      "avatar_glb_url": "https://…"
    }
  ],
  "next_cursor": "3"
}
```

Pass `next_cursor` back as `cursor` to fetch the following page.

## Examples

Runnable examples live in [`examples/`](./examples):

```bash
node examples/list-tools.mjs            # every tool with its full input schema
node examples/browse-marketplace.mjs    # categories + agents + detail + skills, live
```

Both spawn this server over stdio and read the live public catalog. Every tool
here is read-only, so nothing can be published or purchased. See
[`examples/README.md`](./examples/README.md) for expected output.

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable              | Required | Default            |
| --------------------- | -------- | ------------------ |
| `THREE_WS_BASE`       | no       | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | no       | `20000`            |

## Links

- Homepage: https://three.ws
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
