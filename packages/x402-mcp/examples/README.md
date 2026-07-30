# Examples: @three-ws/x402-mcp

Two runnable examples. Both spawn this package's own MCP server over stdio (the
same `node src/index.js` entry point the README documents), speak real MCP
JSON-RPC to it, and hit live data. Neither one pays for anything.

| File | What it does | Run |
|---|---|---|
| [`list-tools.mjs`](list-tools.mjs) | Prints all 4 tools with titles, annotation hints, and full input schemas. | `node examples/list-tools.mjs` |
| [`inspect-price.mjs`](inspect-price.mjs) | Searches the live x402 bazaar with `find_services`, then reads one endpoint's 402 price with `inspect_endpoint`, without paying. | `node examples/inspect-price.mjs` |

Run them from the package directory:

```bash
cd packages/x402-mcp
node examples/list-tools.mjs
node examples/inspect-price.mjs
```

Nothing to install and nothing to configure: `find_services` and
`inspect_endpoint` need no key, no signer, and no funds. The server prints a
one-line banner to stderr on connect (`[x402-mcp@x.y.z] connected over stdio
with 4 tools`), which is normal.

## list-tools.mjs

Runs the MCP `initialize` handshake, then `tools/list`, and formats every tool.
Expected output (abridged):

```
server:       x402-mcp v0.2.1 (stdio)
capabilities: tools
tools:        4

1. x402_wallet
   title: The agent's x402 spending wallet (address + balance)
   hints: read-only, open-world
   params:
     - address (optional; string, minLength 32, maxLength 64)

2. find_services
   hints: read-only, open-world
   params:
     - query (required; string, minLength 1)
     - type (optional; string, one of http | mcp, default "http")
     - network (optional; string)
     - max_price_usdc (optional; number, min 0)
     - limit (optional; integer, min 1, max 100)

3. inspect_endpoint
   hints: read-only, open-world

4. pay_and_call
   hints: destructive, open-world
```

`pay_and_call` is the only tool that carries `destructiveHint`. That is the flag
annotation-aware clients use to prompt before spending.

## inspect-price.mjs

Two live, free calls in sequence.

`find_services` merges the public facilitator discovery feeds and ranks them
against your query, so you see what an agent could actually buy:

```
find_services: searching the live bazaar for "3d model"
  5 service(s) matched
  - 0.001 USDC  https://three.ws/api/mcp
  - 0.001 USDC  https://three.ws/api/mcp-3d
  - 0.001 USDC  https://three.ws/api/x402/model-check
  - 0.25 USDC  https://three.ws/api/x402/remix-asset
  - 0.05 USDC  https://three.ws/api/x402/pipeline-rig
```

`inspect_endpoint` then probes one of those endpoints and decodes its real 402
challenge. This is the whole point of the tool: you learn the price, the asset,
and the recipient before any money moves.

```
inspect_endpoint: probing https://three.ws/api/x402/model-check?url=https://three.ws/avatars/mannequin.glb
  402 payment required, 3 way(s) to settle:
  - solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp  exact
      price:   1000 atomic (0.001 USDC)
      asset:   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
      pay to:  wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU
  - eip155:8453  exact
      price:   1000 atomic (0.001 USD Coin)
      ...

  this wallet could settle it: yes, a solana:* accept is offered

No payment was made. Nothing was signed, no key was read.
```

Prices come from the live endpoint, so the exact numbers and the set of
discovered services will differ from the transcript above.

### Arguments

```bash
node examples/inspect-price.mjs "<search query>" "<url to probe>"
```

Both are optional. Pass a `resource` printed by the `find_services` step as the
second argument to probe that service instead. Some paid routes take their input
as a query param, so include it (the default target does).

### Environment

Optional, and forwarded to the server if set: `THREE_WS_BASE` (default
`https://three.ws`), `THREE_WS_TIMEOUT_MS`, `SOLANA_RPC_URL`. Neither example
reads `SOLANA_SECRET_KEY` or calls `pay_and_call`, so no key is ever loaded and
no transaction is ever signed.
