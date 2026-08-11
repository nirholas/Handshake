# pump-fun-mcp (Cloudflare Workers mirror)

A remote MCP server exposing free, read-only pump.fun and Solana data. It mirrors
the canonical server at `https://three.ws/api/pump-fun-mcp` ([api/pump-fun-mcp.js](../../api/pump-fun-mcp.js))
so the same tools can be served from Cloudflare's edge, and shares its tool
catalog with that handler through [src/pump/mcp-tools.js](../../src/pump/mcp-tools.js).

Point any MCP client at the worker URL. No API key, no account, no auth header.

## Where it runs

This worker is **not deployed today**: there is no Cloudflare account wired up in
this repo, and no `pump-fun-mcp` service exists on the project's Cloud Run fleet
(the canonical server there is the three.ws API route, not this file). The
production endpoint agents should use is `https://three.ws/api/pump-fun-mcp`.

The worker exists so the read-only surface can be run anywhere, by anyone, on
their own Cloudflare account. Both paths below are the ones verified against this
code; `wrangler` is not a repo dependency, so it is invoked through `npx`.

```bash
cd workers/pump-fun-mcp

# Run it locally (workerd, the real Workers runtime) on http://127.0.0.1:8787
npx wrangler@4 dev --var "SOLANA_RPC_URL:https://your-rpc.example"

# Type-free build check: bundles exactly what a deploy would upload
npx wrangler@4 deploy --dry-run --outdir /tmp/pump-fun-mcp-build

# Deploy to your own Cloudflare account (prompts for login on first run)
npx wrangler@4 deploy
```

Dependencies (`@solana/web3.js`, `@solana/spl-token`, `@pump-fun/pump-sdk`) resolve
from the repo root `node_modules`, so run `npm install` at the repo root first.
The worker has no `package.json` of its own by design: it is bundled from this
worktree, not published.

Tests: `npx vitest run tests/workers/pump-fun-mcp-worker.test.js` exercises the
transport, the dispatch table, the tools/list filtering, and the RPC failover
boundary against the real module.

## Transport

Full MCP Streamable HTTP (protocol `2025-06-18`), identical to the three.ws handler:

- `POST`: JSON-RPC 2.0, single requests and batches (max 16). Notification-only
  requests return `202 Accepted` with no body.
- `GET` / `HEAD`: SSE handshake (`content-type: text/event-stream`). The worker is
  stateless and never initiates server-to-client messages, so the stream closes
  immediately after opening, which the spec permits.
- `DELETE`: session terminate (`204`; nothing to tear down).
- `OPTIONS`: CORS preflight. CORS is open (`*`), matching the read-only surface.

Every JSON-RPC response carries the `mcp-protocol-version` header.

## Tools

Canonical names are snake_case. `tools/list` advertises only canonical names;
`tools/call` also accepts the legacy camelCase names (`searchTokens`,
`getBondingCurve`, and so on) forever, via `TOOL_NAME_ALIASES` in
[src/pump/mcp-tools.js](../../src/pump/mcp-tools.js), the shared single source of
truth for both this worker and the three.ws handler.

| Tool | Source | Listed when |
| --- | --- | --- |
| `get_bonding_curve` | on-chain (pump SDK) | always |
| `get_token_details` | on-chain (mint + metadata) | always |
| `get_token_holders` | on-chain (largest accounts) | always |
| `pumpfun_bot_status` | worker self-report | always |
| `search_tokens` | indexer | `PUMPFUN_BOT_URL` set |
| `get_token_trades` | indexer | `PUMPFUN_BOT_URL` set |
| `get_trending_tokens` | indexer | `PUMPFUN_BOT_URL` set |
| `get_new_tokens` | indexer | `PUMPFUN_BOT_URL` set |
| `get_graduated_tokens` | indexer | `PUMPFUN_BOT_URL` set |
| `get_king_of_the_hill` | indexer | `PUMPFUN_BOT_URL` set |
| `get_creator_profile` | indexer | `PUMPFUN_BOT_URL` set |

Indexer-backed tools are hidden from `tools/list` until `PUMPFUN_BOT_URL` is
configured, so a client never sees a tool whose only possible answer is an error.
`pumpfun_bot_status` is always listed and always callable: it reports whether the
indexer is configured and, if so, whether it is currently answering.
`initialize` carries the same signal as `serverInfo.indexerEnabled`.

`get_token_details` reads Token-2022 mints (what pump.fun launches today) from the
mint's own TokenMetadata extension, and legacy SPL mints from the Metaplex
metadata PDA. Metadata is best effort: a mint with neither returns `null` name,
symbol, and uri alongside its real supply and decimals.

## RPC failover

On-chain tools try each endpoint in order until one answers:
`SOLANA_RPC_URL`, then every comma-separated entry in `SOLANA_RPC_FALLBACKS`
(devnet uses `SOLANA_RPC_URL_DEVNET` and `SOLANA_RPC_FALLBACKS_DEVNET`). When
none of those are set, the chain is the public Solana endpoint alone. Configuring
any endpoint replaces the public default rather than prepending to it, so a
pinned paid RPC never silently downgrades to a shared one.

A tool-level verdict (invalid mint, account genuinely absent) stops the chain
immediately; only transport failures advance it. When every endpoint fails, the
caller gets JSON-RPC error `-32004` naming the upstream cause, never a `-32603`.
Public endpoints IP-block and rate-limit routinely, so a single-endpoint
deployment will go dark on every on-chain tool sooner or later. Set at least one
fallback.

## Divergences from the three.ws handler

Deliberate scope decisions, not platform constraints (Workers support SSE and
streams fine):

1. **Tool subset.** The worker serves the on-chain and indexer data tools listed
   above, and its `tools/list` advertises exactly that subset. The kol, sns,
   social, claims, and auth-gated tools depend on three.ws backend modules (x402
   settlement, bearer auth, the radar and leaderboard stores) that live in the
   Cloud Run deployment.
2. **No auth or x402 gating.** None of the gated tools (`pumpfun_vanity_mint`,
   `pumpfun_watch_whales`, `pumpfun_watch_claims`) are served here, so the worker
   carries no bearer or payment plumbing.
3. **No in-process rate limiting.** Handled at the Cloudflare edge layer.
4. **`get_token_trades` is indexer-only here.** The three.ws handler also decodes
   trades from chain; this worker requires `PUMPFUN_BOT_URL`.

## Configuration

Set with `npx wrangler@4 secret put <NAME>` for a deployment, or `--var NAME:VALUE`
for a local `wrangler dev` run. Everything is optional: with no configuration at
all, the on-chain tools work against the public Solana endpoint and the
indexer-backed tools stay unlisted.

| Variable | Purpose |
| --- | --- |
| `SOLANA_RPC_URL` | primary mainnet RPC endpoint |
| `SOLANA_RPC_FALLBACKS` | comma-separated mainnet failover endpoints |
| `SOLANA_RPC_URL_DEVNET` | primary devnet RPC endpoint |
| `SOLANA_RPC_FALLBACKS_DEVNET` | comma-separated devnet failover endpoints |
| `PUMPFUN_BOT_URL` | upstream indexer MCP endpoint |
| `PUMPFUN_BOT_TOKEN` | bearer token for the indexer |

## Example

```bash
curl -s -X POST http://127.0.0.1:8787/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_token_details","arguments":{"mint":"FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"}}}'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "structuredContent": {
      "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
      "name": "three.ws",
      "symbol": "three",
      "uri": "https://ipfs.io/ipfs/bafkreiftorgs5knoqr3z53unjpdmgyhp4abjnqjkast3iq3tfofetm2oom",
      "decimals": 6,
      "supply": "999668768738714",
      "mintAuthority": null,
      "freezeAuthority": null
    }
  }
}
```
