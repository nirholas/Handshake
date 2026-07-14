# 11 · MCP agent session — blocked on siblings

**Status: not built.** This example is supposed to be a scripted MCP client
driving `hood-mcp` tools (quote, portfolio, launches, swap exposed as MCP tool
calls for an LLM agent). `hood-mcp` doesn't exist yet in the `robinhood/`
workspace — see the root README's SDK feedback for the full picture.

## What's missing

**`hood-mcp`** — an MCP server wrapping `hoodchain` (prompt 06 in
`prompts/robinhood-chain/`), exposing tools like `get_stock_quote`,
`get_portfolio`, `get_recent_launches`, `quote_swap` to any MCP-speaking
agent host (Claude Code, Claude Desktop, etc.) — the same pattern three.ws's
own `3d-agent-local` MCP server uses for its tools.

## What this example will do once it exists

A minimal Node script using `@modelcontextprotocol/sdk`'s client to connect to
a locally-spawned `hood-mcp` server over stdio, list its tools, and call
`get_stock_quote` for a symbol — printing the same kind of output as
[example 02](../02-stock-price-sdk), but routed through MCP instead of a
direct SDK import.

## Owner action

Build `hood-mcp` (prompt 06), then this example becomes a ~30-line MCP client
script — no further action needed from this repo until then.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
