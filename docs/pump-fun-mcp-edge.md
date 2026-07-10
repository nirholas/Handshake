# pump-fun-mcp — Cloudflare Workers edge deployment

Mirror of the primary `/api/pump-fun-mcp` endpoint (served by the Cloud Run app in [`server/index.mjs`](../server/index.mjs)), deployable to Cloudflare Workers for sub-50 ms cold starts and region-local edge execution.

## Files

| Path | Purpose |
| :--- | :--- |
| `workers/pump-fun-mcp/worker.js` | CF Workers fetch handler implementing the MCP Streamable HTTP transport |
| `workers/pump-fun-mcp/wrangler.toml` | Wrangler config (`name`, `main`, `compatibility_date`) |
| `src/pump/mcp-tools.js` | Shared tool registry imported by both the Cloud Run and Workers handlers |

## Deploy

```sh
cd workers/pump-fun-mcp
npx wrangler deploy
```

## Secrets

Set the following with `wrangler secret put <NAME>`:

| Name | Required | Description |
| :--- | :--- | :--- |
| `SOLANA_RPC_URL` | No | Mainnet RPC endpoint (defaults to public endpoint) |
| `SOLANA_RPC_URL_DEVNET` | No | Devnet RPC endpoint (defaults to public endpoint) |
| `PUMPFUN_BOT_URL` | No | Upstream indexer MCP endpoint; indexer-backed tools return -32004 without it |
| `PUMPFUN_BOT_TOKEN` | No | Bearer token for the indexer endpoint |

## Local dev

```sh
npx wrangler dev workers/pump-fun-mcp/worker.js --local
# Test tools/list:
curl -s http://localhost:8787 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

## Tool parity

Both runtimes import `TOOLS` from `src/pump/mcp-tools.js`, so the tool list exposed by `tools/list` is identical by construction. The test `tests/pump-mcp-tools.test.js` asserts this guarantee.

## Differences from the primary handler

- No IP rate limiting (handled at the Cloudflare edge layer instead).
- Env vars come from Workers secrets (`env` binding) rather than `process.env`.
- `kol_radar` and `kol_leaderboard` are not wired in the Worker (they depend on server-side infrastructure not available at the edge).
