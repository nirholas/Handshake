# hood-mcp

**Model Context Protocol servers for [Robinhood Chain](https://docs.robinhood.com/chain/) (chain ID 4663).**

Two servers, one package: a **zero-config data server** any MCP client can add in one line, and
an **explicitly opt-in trading server** for wallets that want to act. Built on
[`hoodchain`](https://nirholas.github.io/robinhood-chain-sdk/), the TypeScript SDK for the chain.

Docs: **https://nirholas.github.io/hood-mcp/**

## Why

Robinhood Chain has two other MCP servers today, both zero-star, days-old, read-only hobby
projects. This is the productized one: a full data surface (Stock Tokens, memecoins, launches,
chain stats) plus a guarded trading surface with hard spend caps and a confirm gate — built to
the standard three.ws holds its agent tooling to.

## 60-second install

### Claude Code

```bash
claude mcp add hood-mcp -- npx -y hood-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hood-mcp": {
      "command": "npx",
      "args": ["-y", "hood-mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "hood-mcp": {
      "command": "npx",
      "args": ["-y", "hood-mcp"]
    }
  }
}
```

### Any stdio MCP client

```bash
npx -y hood-mcp
```

No API key, no wallet, no config. It talks to the public Robinhood Chain RPC and starts
answering tool calls immediately.

## Two servers

### 1. `hood-mcp` — data server (zero-config, read-only)

stdio by default; pass `--http` (or `HOOD_MCP_TRANSPORT=http`) for Streamable HTTP on
`HOOD_MCP_PORT` (default `8730`), serving `POST /mcp` and `GET /health`.

| Tool | What it does |
|---|---|
| `get_chain_stats` | Latest block, gas price, TVL, network totals. |
| `list_stock_tokens` | The 95-token Stock Token registry (ticker, name, contract, feed). |
| `get_stock_quote` | Chainlink price + Uniswap DEX price + premium/discount + share price for a ticker. |
| `get_portfolio` | Multiplier-correct Stock Token portfolio + USDG balance for any address. |
| `get_coin` | Price/volume/liquidity/holders for any token by address (memecoin or Stock Token). |
| `list_trending_coins` | The chain's trending pools right now. |
| `get_recent_launches` | Recent NOXA + The Odyssey launches, scanned from on-chain logs. |
| `watch_launches` | Watch live for new launches for up to 120s. |
| `search_token` | Find a token by ticker, name, or address. |

```bash
HOOD_MCP_NETWORK=mainnet   # or testnet — default mainnet
ALCHEMY_KEY=                # optional: private RPC instead of public
```

### 2. `hood-mcp-trading` — wallet server (explicitly opt-in)

Separate binary, stdio only, refuses to start unless **both** are set:

```bash
HOOD_MCP_ENABLE_TRADING=1
ROBINHOOD_CHAIN_PRIVATE_KEY=0x...
```

```json
{
  "mcpServers": {
    "hood-mcp-trading": {
      "command": "npx",
      "args": ["-y", "hood-mcp-trading"],
      "env": {
        "HOOD_MCP_ENABLE_TRADING": "1",
        "ROBINHOOD_CHAIN_PRIVATE_KEY": "0xYOUR_KEY"
      }
    }
  }
}
```

| Tool | What it does |
|---|---|
| `get_my_portfolio` | This wallet's ETH, USDG, and Stock Token positions. Read-only. |
| `get_swap_quote` | Quote a Uniswap swap without signing. Read-only. |
| `execute_swap` | **Guarded.** Preview → `confirm: true` → broadcast. Spend-capped. |
| `transfer_usdg` | **Guarded.** Preview → `confirm: true` → broadcast. Spend-capped. |

See [**Safety model**](docs/safety.html) for the full guard design. Summary:

1. **Kill switch** — the server process itself refuses to start without `HOOD_MCP_ENABLE_TRADING=1`.
2. **Eligibility gate** — buying a tokenized Stock Token requires `HOOD_MCP_ACKNOWLEDGE_ELIGIBILITY=1`
   (Stock Tokens are barred to US/Canada/UK/Switzerland persons — see below).
3. **Spend caps** — every mutating call is valued in USD and checked against
   `HOOD_MCP_MAX_SPEND_USDG` (per-call) and `HOOD_MCP_MAX_SESSION_USDG` (per-session,
   in-memory, resets on restart) *before* anything is signed.
4. **Confirm gate** — the first call to `execute_swap` / `transfer_usdg` always returns a
   simulation (recipient, amount, token, min-received) and signs nothing. Only a second call
   with `confirm: true` and identical arguments broadcasts.

```bash
HOOD_MCP_MAX_SPEND_USDG=25        # default 25 — per single call
HOOD_MCP_MAX_SESSION_USDG=100     # default 100 — cumulative for the process lifetime
HOOD_MCP_ACKNOWLEDGE_ELIGIBILITY=0  # set to 1 ONLY if eligible to hold Stock Tokens
```

**Stock Tokens are tokenized debt securities** (issuer: Robinhood Assets (Jersey) Ltd) and may
not be offered, sold, or delivered to US persons (additional limits: Canada, UK, Switzerland).
The restriction is legal/front-end enforced, not contract-level — `execute_swap` throws unless
the operator has explicitly acknowledged eligibility. Memecoins are unrestricted.

## Environment reference

See [`.env.example`](.env.example) for the full annotated list. Nothing is required for the
data server; the trading server requires the two kill-switch variables above.

## x402 monetization (seam, not active)

The HTTP transport has a documented seam (`src/x402-seam.ts`) to paywall future metered tools
(deep history, firehose) via the sibling [`hood402`](../hood402) USDG-on-Robinhood-Chain x402
rail once it exists. Every tool this package ships today stays free regardless.

## Development

```bash
npm install
npm run build        # tsup → dist/
npm run dev:data      # tsx src/data-server.ts (stdio)
npm run dev:trading   # tsx src/trading-server.ts (stdio, needs env)
npm test              # hermetic: schema + guard tests (real network reads, no wallet funds)
npm run test:live      # live: every data tool against real mainnet 4663 data
npm run test:swap       # live, gated: a REAL testnet swap through execute_swap (needs a
                        # faucet-funded ROBINHOOD_CHAIN_PRIVATE_KEY — see the test file)
```

Depends on `hoodchain` from npm; for local development against an unpublished SDK checkout:
`npm i ../robinhood-chain-sdk`.

## Registry submissions (owner action)

Metadata is prepared, not submitted — publishing to a registry is a one-way, attributed action
the owner should take:

- **modelcontextprotocol registry** — `server.json` in this repo validates against the
  [official schema](https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json).
  Submit with the [`mcp-publisher`](https://github.com/modelcontextprotocol/registry) CLI once
  `hood-mcp` is live on npm.
- **Smithery** — their current flow publishes a *running* server URL or an `.mcpb` bundle
  (`smithery mcp publish <url> -n <org/server>`), not a static config file. Deploy the HTTP
  transport (`hood-mcp --http`) somewhere public, then run
  `smithery mcp publish https://your-deployment/mcp -n nirholas/hood-mcp`.

## License

MIT © 2026 nirholas

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
