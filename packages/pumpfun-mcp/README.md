# @three-ws/pumpfun-mcp

A **free, read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for **pump.fun** and **Solana**. Give Claude — or any MCP client — live token discovery, on-chain bonding-curve and holder analysis, creator fee-claim tracking, Solana Name Service resolution, KOL signals, and read-only swap quotes.

**No API keys. No RPC URL. No wallet.** Every Solana RPC and pump.fun API call runs server-side on the canonical [three.ws](https://three.ws) backend, so the data is live and on-chain and the client stays zero-config.

## Install

### Claude Desktop / Claude Code / Cursor

Add to your MCP config (`claude_desktop_config.json`, `.mcp.json`, etc.):

```json
{
	"mcpServers": {
		"pumpfun": {
			"command": "npx",
			"args": ["-y", "@three-ws/pumpfun-mcp"]
		}
	}
}
```

That's it — restart the client and the pump.fun tools appear.

### Run directly

```bash
npx @three-ws/pumpfun-mcp
# or
npm i -g @three-ws/pumpfun-mcp && pumpfun-mcp
```

### Inspect the tools

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/pumpfun-mcp
```

## Tools

| Tool | What it does |
| --- | --- |
| `searchTokens` | Search pump.fun tokens by name, symbol, or mint. |
| `getTokenDetails` | Full metadata for a mint. |
| `getBondingCurve` | Real/virtual reserves + graduation progress (on-chain). |
| `getTokenTrades` | Recent buy/sell history for a token. |
| `getTrendingTokens` | Top tokens by market cap. |
| `getNewTokens` | Most recently launched tokens. |
| `getGraduatedTokens` | Tokens that graduated to the Raydium AMM. |
| `getKingOfTheHill` | Highest-cap token still on the bonding curve. |
| `getTokenHolders` | Top holders with concentration analysis (on-chain). |
| `getCreatorProfile` | A creator's tokens with rug-pull risk flags. |
| `kol_radar` | gmgn-style early-detection radar signals. |
| `kol_leaderboard` | Top KOL traders ranked by P&L. |
| `pumpfun_list_claims` | Recent creator fee-claim events (on-chain). |
| `pumpfun_watch_claims` | Fee claims for a creator within a look-back window. |
| `pumpfun_first_claims` | First-ever creator claims — a cash-out signal. |
| `pumpfun_quote_swap` | Read-only pump.fun AMM swap quote (no signing). |
| `pumpfun_watch_whales` | Collect large trades on a token over a short window. |
| `pumpfun_vanity_mint` | Grind a vanity Solana keypair (returns secret to caller; never stored). |
| `sns_resolve` | Resolve a `.sol` domain to its owner wallet. |
| `sns_reverseLookup` | Reverse-lookup a wallet to its primary `.sol` domain. |
| `social_cashtag_sentiment` | Deterministic lexicon sentiment over supplied posts. |
| `social_x_post_impact` | Correlate an X post to bonding-curve price impact. |

Read-only by design: no tool signs or sends a transaction. `pumpfun_quote_swap` only quotes; `pumpfun_vanity_mint` returns a keypair for you to use yourself.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PUMPFUN_MCP_URL` | `https://three.ws/api/pump-fun-mcp` | Backend endpoint. Override only to self-host the handler. |

## How it works

This package is a small stdio ↔ HTTP bridge. It forwards MCP `tools/call` requests to the canonical three.ws pump.fun JSON-RPC backend, which performs the actual Solana RPC reads and pump.fun API queries. That keeps one authoritative implementation, ships no secrets to clients, and means the tool surface stays current automatically (the live `tools/list` is fetched at startup, with a bundled fallback for offline use).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
