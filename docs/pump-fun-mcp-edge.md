# pump-fun-mcp — Cloudflare Workers edge deployment

Mirror of the primary `/api/pump-fun-mcp` endpoint (served by the Cloud Run app in [`server/index.mjs`](../server/index.mjs)), deployable to Cloudflare Workers for sub-50 ms cold starts and region-local edge execution.

## Files

| Path | Purpose |
| :--- | :--- |
| `workers/pump-fun-mcp/worker.js` | CF Workers fetch handler implementing the MCP Streamable HTTP transport |
| `workers/pump-fun-mcp/wrangler.toml` | Wrangler config (`name`, `main`, `compatibility_date`) |
| `workers/pump-fun-mcp/README.md` | Full config table and the verified run, build, and deploy commands |
| `src/pump/mcp-tools.js` | Shared tool registry imported by both the Cloud Run and Workers handlers |
| `tests/workers/pump-fun-mcp-worker.test.js` | Covers the worker's MCP surface (`npx vitest run tests/workers/pump-fun-mcp-worker.test.js`) |

## Deploy

```sh
cd workers/pump-fun-mcp
npx wrangler@4 deploy
```

`wrangler` is not a repo dependency, so it is invoked through `npx`.

## Secrets

Set the following with `npx wrangler@4 secret put <NAME>` (or `--var NAME:VALUE` for a local `wrangler dev` run). Everything is optional:

| Name | Required | Description |
| :--- | :--- | :--- |
| `SOLANA_RPC_URL` | No | Primary mainnet RPC endpoint (defaults to the public endpoint) |
| `SOLANA_RPC_FALLBACKS` | No | Comma-separated mainnet failover endpoints, tried in order after the primary (same var name the three.ws deployment uses) |
| `SOLANA_RPC_URL_DEVNET` | No | Primary devnet RPC endpoint (defaults to the public endpoint) |
| `SOLANA_RPC_FALLBACKS_DEVNET` | No | Comma-separated devnet failover endpoints |
| `PUMPFUN_BOT_URL` | No | Upstream indexer MCP endpoint; indexer-backed tools return -32004 without it |
| `PUMPFUN_BOT_TOKEN` | No | Bearer token for the indexer endpoint |

Every on-chain tool walks the configured chain (primary, then each fallback) until one endpoint answers; the public endpoint is used only when nothing is configured, never as a silent downgrade. A tool-level verdict (invalid mint, account genuinely absent) propagates immediately instead of burning the chain, and a provider that is down, rate-limiting, or blocking the egress IP surfaces as `-32004`. `get_token_details` reads name, symbol, and URI from the Token-2022 `TokenMetadata` extension for Token-2022 mints (what pump.fun launches today) and falls back to the legacy Metaplex metadata PDA otherwise.

## Local dev

```sh
npx wrangler@4 dev workers/pump-fun-mcp/worker.js --local
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
