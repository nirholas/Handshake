# 06 — MCP servers: `hood-mcp` (chain data + trading for AI agents)

Read `prompts/robinhood-chain/_shared.md` first. Requires Wave 1 core SDK
(`file:../robinhood-chain-sdk`).

## Mission
Build `robinhood/hood-mcp/` — production MCP servers for Robinhood Chain. Robinhood's own MCP
covers only their US brokerage; the chain itself has just two 0-star read-only hobby MCPs.
Ours is the productized one: full data surface + a guarded trading surface. npm `hood-mcp`
(fallbacks: `hoodchain-mcp`, `robinhood-chain-mcp-server`).

## Deliverables — two servers, one package

1. **`hood-mcp` (data server, zero-config, read-only)** — stdio + streamable-HTTP transports,
   built on `@modelcontextprotocol/sdk` (use the current SDK — check npm for the latest major):
   - `list_stock_tokens`, `get_stock_quote` (Chainlink + DEX price + premium),
     `get_portfolio` (multiplier-correct), `get_coin` / `list_trending_coins`,
     `get_recent_launches`, `watch_launches` (streamable), `get_chain_stats`,
     `search_token` (symbol/name/address via registry + Blockscout).
   - Every tool: precise JSON schema, one-line description an LLM can route on, real error
     messages. No API key required — public RPC default, `ALCHEMY_KEY` env optional.
2. **`hood-mcp/trading` (wallet server, explicitly opt-in)** — separate entry point, requires
   `ROBINHOOD_CHAIN_PRIVATE_KEY` + `HOOD_MCP_ENABLE_TRADING=1`:
   - `get_swap_quote`, `execute_swap` (memecoins; Stock Token buys additionally require
     `HOOD_MCP_ACKNOWLEDGE_ELIGIBILITY=1` per `_shared.md`), `transfer_usdg`, `get_my_portfolio`.
   - Hard spend caps via `HOOD_MCP_MAX_SPEND_USDG` (per-call and per-session), every mutating
     tool returns the simulation result and requires a `confirm: true` argument round-trip.
3. **Registry listings** — prepare (don't submit) the metadata for the MCP registries the
   ecosystem actually uses (modelcontextprotocol registry `server.json`, Smithery config), plus
   Claude Desktop / Claude Code / Cursor install snippets in the README — exact, tested JSON.
4. **Optional x402 monetization seam** — if `robinhood/hood402` exists when you run, add a
   config flag that paywalls the expensive data tools (history, firehose) using its middleware
   on the HTTP transport; otherwise leave a documented seam. Free tools stay free either way.

## Requirements
- Vitest: tool-schema validation tests + a scripted MCP client (SDK's client) exercising every
  tool for real: data tools against mainnet, trading tools against testnet 46630 with faucet
  funds — a REAL `execute_swap` round-trip (simulate → confirm → receipt) with tx hash pasted.
- `docs/` static site per `_shared.md`: landing shows a real Claude Code session transcript
  (run it yourself with the local server via `claude mcp add`) doing "what's AAPL trading at
  on-chain and what's the premium?" — the answer with live numbers is the screenshot. Install
  matrix (Claude Code / Desktop / Cursor / any stdio client), tool reference, safety model page.
- README: 60-second install per client, both servers, env table, safety model.

## Done checklist
- [ ] Every tool exercised by the scripted client with real outputs in the report.
- [ ] Real testnet swap through the trading server (hash in report). Spend-cap + confirm-gate tests green.
- [ ] Claude Code session actually run against the local build; transcript captured for docs.
- [ ] `npm pack` clean; registry metadata validates; report lists owner actions (registry submissions).
