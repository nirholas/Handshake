# three.ws x402 Bazaar — MCP server

Discover paid agent services across the **live x402 facilitator network** —
search, browse, and price any service from inside Claude, Cursor, or any MCP
client. Registered with the MCP Registry as
**`io.github.nirholas/three-ws-x402-bazaar`**.

- **Endpoint:** `https://three.ws/api/mcp-bazaar`
- **Transport:** Streamable HTTP (MCP `2025-06-18`)
- **Auth:** OAuth 2.1 (same three.ws authorization server as `/api/mcp`) or x402
- **Data:** live `/discovery/resources` from the configured x402 facilitators — no cached or synthetic listings

## Tools

| Tool | What it does |
|------|--------------|
| `search_services(query, type?, network?, max_price_usdc?, limit?)` | Ranked search over the merged facilitator catalog. |
| `browse_services(type?, network?, max_price_usdc?, limit?)` | List services without a query — "what can I pay for?". |
| `get_service(resource_url, tool_name?)` | Full payment requirements (price, asset, network, recipient), input/output schema, and a ready pay link. |

`type` is `http` (paid HTTP APIs) or `mcp` (paid MCP tools). `network` is a
CAIP-2 id, e.g. `eip155:8453` (Base) or `solana:*`. `max_price_usdc` filters to
services at or below a dollar ceiling.

## Use on claude.ai

Add the connector with URL `https://three.ws/api/mcp-bazaar` and complete OAuth.
Then:

> "Find me a cheap weather API I can pay for, on Base."

Claude calls `search_services`, then `get_service` for the top hit, and shows
the price, the network, and a one-click pay link.

## Paying

The bazaar is a **discovery** surface. `get_service` returns the exact x402
payment requirements plus a `pay_link` to the three.ws hosted payer
(`/pay`), which settles the payment with your three.ws agent wallet and returns
the service response.

Autonomous in-MCP `pay_and_call` (the server pays and calls on your behalf) is a
deliberate, wallet-gated extension — it spends real funds, so it ships only
behind explicit per-user wallet authorization rather than being enabled for any
connected client by default.

## Configuration

Facilitators come from the platform default set (`defaultFacilitators()` in
`api/_lib/x402/bazaar-client.js`); no extra env is required to read the bazaar.
Discovery is rate-limited to 60 calls/min per principal to bound facilitator
egress.

## Publishing to the MCP Registry

Manifest: [`server-bazaar.json`](../server-bazaar.json).

```bash
mcp-publisher login github
mcp-publisher publish --file server-bazaar.json
```

## Local development

```bash
npm run dev
npx @modelcontextprotocol/inspector http://localhost:5173/api/mcp-bazaar
```
