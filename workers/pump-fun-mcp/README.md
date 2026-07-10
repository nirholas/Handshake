# pump-fun-mcp (Cloudflare Workers mirror)

Mirror of the canonical pump.fun MCP server at `https://three.ws/api/pump-fun-mcp`
(`api/pump-fun-mcp.js`). Deploy: `wrangler deploy`

## Transport

Full MCP Streamable HTTP (protocol `2025-06-18`), identical to the three.ws handler:

- `POST` — JSON-RPC 2.0, single requests and batches (max 16). Notification-only
  requests return `202 Accepted` with no body.
- `GET` / `HEAD` — SSE handshake (`content-type: text/event-stream`). The worker is
  stateless and never initiates server→client messages, so the stream closes
  immediately after opening — permitted by the spec.
- `DELETE` — session terminate (`204`; nothing to tear down).
- `OPTIONS` — CORS preflight. CORS is open (`*`), matching the read-only surface.

Every JSON-RPC response carries the `mcp-protocol-version` header.

## Tool names

Canonical names are snake_case (`search_tokens`, `get_bonding_curve`, …).
`tools/list` advertises only canonical names; `tools/call` accepts the legacy
camelCase names (`searchTokens`, `getBondingCurve`, …) forever via
`TOOL_NAME_ALIASES` in `src/pump/mcp-tools.js` — the shared single source of truth.

## Documented divergences from the three.ws handler

These are deliberate scope decisions, not platform constraints — CF Workers
support SSE/streams fine:

1. **Tool subset.** The worker serves only the on-chain + indexer data tools
   (`get_bonding_curve`, `get_token_details`, `get_token_holders`, `search_tokens`,
   `get_token_trades`, `get_trending_tokens`, `get_new_tokens`,
   `get_graduated_tokens`, `get_king_of_the_hill`, `get_creator_profile`), and its
   `tools/list` honestly advertises exactly that subset. The kol/sns/social/claims
   and auth-gated tools depend on three.ws backend modules (x402 settlement,
   bearer auth, the radar/leaderboard stores) that live in the three.ws
   (Cloud Run) deployment.
2. **No auth / x402 gating.** None of the gated tools (`pumpfun_vanity_mint`,
   `pumpfun_watch_whales`, `pumpfun_watch_claims`) are served here, so the worker
   carries no bearer or payment plumbing.
3. **No rate limiting in-process.** Handled at the Cloudflare edge layer.
4. **`get_token_trades` is indexer-only here.** The three.ws handler falls back to
   decoding trades from chain; the worker requires `PUMPFUN_BOT_URL`.

## Secrets (`wrangler secret put <NAME>`)

| Secret                  | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `SOLANA_RPC_URL`        | mainnet RPC endpoint (default: public)   |
| `SOLANA_RPC_URL_DEVNET` | devnet RPC endpoint (default: public)    |
| `PUMPFUN_BOT_URL`       | upstream indexer endpoint (optional)     |
| `PUMPFUN_BOT_TOKEN`     | bearer token for the indexer (optional)  |
