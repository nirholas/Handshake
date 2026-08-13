# Marketplace MCP — browse the agent marketplace & skills catalog

Search and page the public three.ws agent marketplace and the skills catalog from inside any MCP client: filter agents by category and free-text, open one agent's full detail, list categories with counts, and browse reusable, monetizable skills. Read-only discovery — the front door to everything the community has published.

Registered in the [official MCP registry](https://registry.modelcontextprotocol.io/?q=io.github.nirholas) as **`io.github.nirholas/marketplace-mcp`**.

- **Install:** `npx -y @three-ws/marketplace-mcp`
- **npm:** [`@three-ws/marketplace-mcp`](https://www.npmjs.com/package/@three-ws/marketplace-mcp), published from `packages/marketplace-mcp`
- **Transport:** stdio — no account, no key, no payment

## Add it

```bash
claude mcp add marketplace -- npx -y @three-ws/marketplace-mcp
```

```json
{
  "mcpServers": {
    "marketplace": { "command": "npx", "args": ["-y", "@three-ws/marketplace-mcp"] }
  }
}
```

## Tools

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `browse_agents` | `category` *(string)*, `q` *(string)*, `sort` *(`recommended`\|`recent`\|`popular`\|`top_rated`, default `recommended`)*, `limit` *(1–48, default 24)*, `cursor` *(string)* | Search and page the agent marketplace. Returns agent cards (id, name, description, category, tags, ratings, view/fork counts, thumbnail + GLB avatar URLs) and a `next_cursor`. |
| `agent_detail` | `id` *(string, required)* | Fetch one published agent's full detail: description, category, tags, system prompt, greeting, capabilities, author, ratings, skill prices, subscription tiers, and avatar URLs. |
| `agent_categories` | *(none)* | List marketplace categories with the count of published agents in each, plus the overall total. Use the slugs to filter `browse_agents`. |
| `browse_skills` | `q` *(string)*, `category` *(string)*, `sort` *(`popular`\|`new`\|`az`, default `popular`)*, `limit` *(1–50, default 20)*, `cursor` *(string)* | Search and page the skills catalog — reusable capabilities agents can install. Returns skills (id, name, slug, description, category, tags, install count, rating, per-call price, author, content preview) and a `next_cursor`. |
| `skill_categories` | *(none)* | List skills-catalog categories that have at least one public skill, each with a slug, label, and count. |

## Examples

Popular programming agents:

```json
{ "category": "programming", "sort": "popular", "limit": 10 }
```

Open one agent (ids come from a `browse_agents` response):

```json
{ "id": "0f81b359-3ba3-40d6-9cbf-ebd551e4f862" }
```

Newest skills matching a query:

```json
{ "q": "summarize", "sort": "new", "limit": 20 }
```

## Configuration

| Env | Purpose | Default |
|-----|---------|---------|
| `THREE_WS_BASE` | Base URL of the three.ws API serving `/api/marketplace` and `/api/skills`. | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | Per-request timeout in ms. These are fast public read endpoints. | `20000` |

## Notes

- **Read-only and free** — no auth, no key, no payment.
- Pagination is cursor-based: pass a response's `next_cursor` back as `cursor` for the next page. Errors are normalized with `.code` (`timeout`, `network_error`, `upstream_error`, `not_found`).

## Source & publishing

Manifest: [`packages/marketplace-mcp/server.json`](https://github.com/nirholas/three.ws/blob/main/packages/marketplace-mcp/server.json). Published with `npm run publish:mcp`. Full catalog: [MCP overview](/docs/mcp).
