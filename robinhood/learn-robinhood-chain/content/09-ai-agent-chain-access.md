An AI coding assistant is only as useful as the tools it can call. This tutorial builds a **Model Context Protocol (MCP)** server that exposes Robinhood Chain reads — quotes, portfolios, the registry — as tools any MCP-compatible assistant can invoke, then wires it into Claude Code, Claude Desktop, and Cursor. Everything below was run against a real MCP client, not described secondhand.

## What MCP actually is

[MCP](https://modelcontextprotocol.io) is a JSON-RPC-based protocol that lets an AI assistant discover and call *tools* exposed by a separate process — your server. The assistant doesn't need special Robinhood Chain knowledge baked in; it needs your server to expose well-described tools, and it reasons about when to call them. This is the same shape as the paid MCP tools you may have already used from three.ws (`forge_free`, `crypto_news`, and friends) — except here, you're the one writing the server.

## The server

Three tools: a live quote, a portfolio valuation, and a registry listing — the exact operations from Tutorials 4 and 5, now callable by an LLM instead of a terminal script.

```bash
npm install @modelcontextprotocol/sdk zod hoodchain viem
```

```ts
// server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createHoodClient, getQuote, getPortfolio, listPricedStockTokens } from 'hoodchain'

const hood = createHoodClient()
const server = new McpServer({ name: 'robinhood-chain-mcp', version: '0.1.0' })

server.registerTool(
  'get_stock_quote',
  {
    title: 'Get Stock Token quote',
    description: 'Live, multiplier-adjusted Chainlink price for a Robinhood Chain Stock Token, by ticker (e.g. AAPL, TSLA).',
    inputSchema: { symbol: z.string().describe('Ticker symbol, case-insensitive') },
  },
  async ({ symbol }) => {
    const q = await getQuote(hood, symbol, { maxAgeSeconds: 7 * 24 * 60 * 60 })
    return {
      content: [{ type: 'text', text: JSON.stringify({
        symbol: q.symbol, priceUsd: q.priceUsd, updatedAt: new Date(q.updatedAt * 1000).toISOString(),
      }) }],
    }
  },
)

server.registerTool(
  'get_portfolio',
  {
    title: 'Get Stock Token portfolio',
    description: 'Multiplier-correct Stock Token holdings and USD valuation for any address on Robinhood Chain.',
    inputSchema: { address: z.string().describe('0x-prefixed wallet address') },
  },
  async ({ address }) => {
    const p = await getPortfolio(hood, address, { maxAgeSeconds: 7 * 24 * 60 * 60 })
    return { content: [{ type: 'text', text: JSON.stringify({ totalUsd: p.totalUsd, positions: p.positions.length }) }] }
  },
)

server.registerTool(
  'list_priced_stock_tokens',
  { title: 'List priced Stock Tokens', description: 'All Robinhood Chain Stock Tokens with a live Chainlink feed.', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: JSON.stringify(listPricedStockTokens().map((t) => t.symbol)) }] }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
```

Notice what this server does *not* do: no wallet, no write tools, no private key. Read-only MCP tools need none of that — exactly the same "reads are free and keyless" property from Tutorial 2. A write-capable version (place a swap, transfer USDG) is a natural extension, but it should prompt for confirmation before every transaction — treat an LLM's tool call exactly like a user action, not an autonomous decision, for anything that spends.

## A real transcript

Rather than describe what connecting an assistant *would* show, here's an actual MCP client — built with the same `@modelcontextprotocol/sdk` package — connecting over stdio, listing the server's tools, and calling two of them against live mainnet:

```ts
// client-test.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({ command: 'node', args: ['server.mjs'] })
const client = new Client({ name: 'test-client', version: '0.1.0' })
await client.connect(transport)

const tools = await client.listTools()
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '))

const quote = await client.callTool({ name: 'get_stock_quote', arguments: { symbol: 'TSLA' } })
console.log('get_stock_quote(TSLA) ->', quote.content[0].text)

const list = await client.callTool({ name: 'list_priced_stock_tokens', arguments: {} })
console.log('list_priced_stock_tokens() -> count', JSON.parse(list.content[0].text).length)
```

```bash
$ node client-test.mjs
```

```text
TOOLS: get_stock_quote, get_portfolio, list_priced_stock_tokens
get_stock_quote(TSLA) -> {"symbol":"TSLA","priceUsd":407.825,"updatedAt":"2026-07-10T19:53:35.000Z"}
list_priced_stock_tokens() -> count 34
```

This is the exact protocol exchange an assistant like Claude performs when it decides to call `get_stock_quote` — a real handshake, a real tool list, a real live price. The `34` matches the priced-token count from Tutorial 3; if that number drifts as Chainlink adds feeds, your server will report it correctly without any code change, because it reads the SDK's registry live rather than hardcoding a count.

## Connecting to Claude Code

Claude Code discovers MCP servers from a project or user config. Add this server with the CLI:

```bash
claude mcp add robinhood-chain -- node /absolute/path/to/server.mjs
```

Or add it directly to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "robinhood-chain": {
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"]
    }
  }
}
```

Restart Claude Code (or run `/mcp` to reconnect) and ask something like *"What's the live price of TSLA on Robinhood Chain?"* — Claude will call `get_stock_quote` and answer from the real response, not from training data (which has no idea Robinhood Chain exists, or that it launched in July 2026).

## Connecting to Claude Desktop

Claude Desktop reads its MCP config from `claude_desktop_config.json` (**Settings → Developer → Edit Config** opens the file directly):

```json
{
  "mcpServers": {
    "robinhood-chain": {
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"]
    }
  }
}
```

Fully restart the app after editing (not just close the window) for the new server to be picked up.

## Connecting to Cursor

Cursor uses the same MCP config shape, in `.cursor/mcp.json` at your project root or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "robinhood-chain": {
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"]
    }
  }
}
```

Open **Cursor Settings → MCP** to confirm the server shows as connected with its three tools listed.

## Troubleshooting

**Server doesn't show up / "0 tools"** — double-check the `args` path is absolute, not relative; MCP host apps don't inherit your shell's working directory. Run `node /absolute/path/to/server.mjs` by hand first — if it hangs waiting on stdin with no error, that's actually correct (stdio transport blocks reading for the next message); Ctrl-C to confirm it started without throwing.

**Tool call errors with `UnknownSymbolError` surfaced as a generic failure** — MCP wraps thrown errors into an error-content response by default; add a `try/catch` per tool if you want to return a structured, LLM-readable error message instead of a stack trace.

**Assistant answers from stale training knowledge instead of calling the tool** — make your tool `description` field more specific about *when* to use it ("always use this for current Robinhood Chain prices — do not answer from memory, this chain launched after most training cutoffs"). Description quality is the entire interface between your server and the model's judgment.

## What you built

A real MCP server, verified against a real MCP client with a live mainnet call captured in this page, plus the exact configuration to wire it into the three major MCP-compatible coding assistants. Next: turning read access into an agent that actually acts — an autonomous trader.
