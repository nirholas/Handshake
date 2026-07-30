# Examples: @three-ws/marketplace-mcp

Two runnable examples. Both spawn this package's own MCP server over stdio (the
same `node src/index.js` entry point the README documents), speak real MCP
JSON-RPC to it, and read the live public marketplace.

| File | What it does | Run |
|---|---|---|
| [`list-tools.mjs`](list-tools.mjs) | Prints all 5 tools with titles, annotation hints, and full input schemas. | `node examples/list-tools.mjs` |
| [`browse-marketplace.mjs`](browse-marketplace.mjs) | Categories, then a page of popular agents, then one agent's full record, then the skills catalog. | `node examples/browse-marketplace.mjs` |

Run them from the package directory:

```bash
cd packages/marketplace-mcp
node examples/list-tools.mjs
node examples/browse-marketplace.mjs
```

Nothing to install and nothing to configure: every tool on this server is
read-only and keyless. The server prints a one-line banner to stderr on connect
(`[marketplace-mcp@x.y.z] connected over stdio with 5 tools`), which is normal.

## list-tools.mjs

Runs the MCP `initialize` handshake, then `tools/list`, and formats every tool.
Expected output (abridged):

```
server:       marketplace-mcp v0.1.1 (stdio)
capabilities: tools
tools:        5

1. browse_agents
   title: Browse the agent marketplace
   hints: read-only, open-world
   params:
     - category (optional; string)
     - q (optional; string)
     - sort (optional; string, one of recommended | recent | popular | top_rated, default "recommended")
     - limit (optional; integer, min 1, max 48)
     - cursor (optional; string)

2. agent_detail
   params:
     - id (required; string, minLength 1)

3. agent_categories
   params: none

4. browse_skills
   params:
     - q, category, sort (popular | new | az), limit (1 to 50), cursor

5. skill_categories
   params: none
```

Every tool reports `read-only, open-world`. There is no write tool on this
server to accidentally reach for.

## browse-marketplace.mjs

Four live calls chained the way an agent would actually chain them: discover the
categories, page the biggest one, expand a card into its full record, then look
at the skills side of the catalog.

```
agent_categories: 14 categories, 2779 published agents
    794  general
     56  design
     56  programming
     33  marketing
     31  education

browse_agents: category=general q=none sort=popular limit=5
  5 card(s), next_cursor=5
  - Event Scanner 8  [general]  791 views, unrated
      Scans mempool for sandwich opportunities and MEV patterns.
  ...

agent_detail: 3a485095-9c48-4847-a8a2-837c1b4387d8
  name:     Event Scanner 8
  category: general
  tags:     token-price, wallet-scan
  skills:   token-price, wallet-scan
  avatar:   https://pub-....r2.dev/u/.../mq02t7ea.glb

browse_skills: sort=popular limit=5
  - whale-wallet-tracking  [analysis]  10 installs, free
  - Wallet Balance  [crypto]  6 installs, $0.005/call
  ...

All four calls were read-only. Nothing was published, purchased, or modified.
```

The catalog is live, so counts, names, and ids all move between runs. What stays
stable is the shape: `browse_agents` returns cards plus a `next_cursor`, and
feeding that cursor back as `cursor` walks the next page.

### Arguments

```bash
node examples/browse-marketplace.mjs "<category slug>" "<free-text query>"
```

Both optional. With no category the example picks the one with the most agents.
A filter that matches nothing is a normal outcome, and the example says so
instead of failing:

```
browse_agents: category=programming q=code sort=popular limit=5
  0 card(s), next_cursor=null

agent_detail: skipped, that filter returned no cards
```

### Environment

Optional, forwarded to the server if set: `THREE_WS_BASE` (default
`https://three.ws`) and `THREE_WS_TIMEOUT_MS`. Point `THREE_WS_BASE` at your own
deployment to browse its catalog instead.
