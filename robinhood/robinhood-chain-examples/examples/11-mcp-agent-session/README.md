# 11 · MCP agent session

Every other example here imports `hoodchain` and calls it directly. An LLM
agent cannot do that: it only reaches the world through tools its host has
been given. [`hood-mcp`](https://www.npmjs.com/package/hood-mcp) is the bridge:
a Model Context Protocol server that exposes Robinhood Chain reads as protocol
tools, so Claude Code, Claude Desktop, Cursor, or any MCP host can answer
"what is AAPL worth on Robinhood Chain?" without a line of chain code.

This example is the client half of that conversation, written longhand: it
spawns the real `hood-mcp` data server over stdio, completes the MCP
initialize handshake, lists the tools the server advertises, then calls three
of them. It is exactly what an agent host does internally, with the protocol
traffic made visible.

**What it proves:** the SDK, the MCP server, and an agent host are three
layers over one chain. Tool annotations (`readOnlyHint`) let a host know which
calls are safe before it makes them, and the read-only data server is a
separate binary from the trading server, so an agent cannot spend by accident.

## Prerequisites

- Node ≥ 20. No wallet, key, or funds: all nine tools here are read-only.

## Run

```bash
npm install
npm start                  # handshake + tool list + three real calls
node index.js --symbol TSLA   # price a different Stock Token
node index.js --list-only     # stop after the tool inventory
```

## Expected output

```
1 · Spawning the MCP server over stdio
  server   …/node_modules/hood-mcp/dist/data-server.js
  network  mainnet
  connected to hood-mcp v0.1.0
  capabilities tools

2 · Tools the server advertises
  get_chain_stats      read-only  (no inputs)
  list_stock_tokens    read-only  (pricedOnly, limit, offset)
  get_stock_quote      read-only  (symbol, maxAgeSeconds)
  get_portfolio        read-only  (address)
  get_coin             read-only  (address)
  list_trending_coins  read-only  (limit)
  get_recent_launches  read-only  (lookbackBlocks, launchpad, limit)
  watch_launches       read-only  (waitSeconds, launchpad, limit, includeRecentIfEmpty)
  search_token         read-only  (query, limit)
  9 tools total.

3 · get_chain_stats, the tool with no arguments
  chain      mainnet (id 4663)
  block      23563878
  gas price  0.02 gwei
  TVL        $355,018,487.24

4 · get_stock_quote, the same call an agent makes for "what is AAPL worth?"
  AAPL  Apple • Robinhood Token
  oracle     $333.01
  DEX mid    $333.10
  premium    0.026%
  underlying $333.01 per share (ERC-8056 multiplier 1000000000000000000)

5 · list_trending_coins, a list-shaped result
  YODA / WETH         $0.00000927   -95.7% 24h  vol $264,059.93
  ASTEROID / WETH     $0.00192937  +132.9% 24h  vol $973,870.39
  HOODRAT / WETH      $0.00563021  +170.0% 24h  vol $7,800,285.23
```

Captured live against mainnet at block 23,563,878. Your numbers will differ:
the oracle price moves with the market, and the trending list is whatever is
hot when you run it. The `premium` line is the DEX mid against the Chainlink
oracle, so a fraction of a percent is normal and a wide gap is the signal.

## Wire it into a real agent

The point of the server is that you do not write this client at all. Register
it once and the nine tools become things your agent can simply ask for:

```bash
claude mcp add hood-mcp -- npx -y hood-mcp
```

For Claude Desktop or Cursor, add the same command to the host's MCP config:

```json
{
  "mcpServers": {
    "hood-mcp": { "command": "npx", "args": ["-y", "hood-mcp"] }
  }
}
```

Then ask in plain language: *"What's the premium on TSLA on Robinhood Chain?"*
or *"Show me coins that launched in the last hour."* The host picks the tool.

## Trading tools are opt-in, deliberately

`hood-mcp` ships a second binary, `hood-mcp-trading`, that is not started
here. It requires an explicit private key plus a spend cap, and every
state-changing tool is annotated `readOnlyHint: false` with a confirmation
gate. Read-only and spending capabilities never share a process, so pointing
an agent at the data server cannot move funds.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
