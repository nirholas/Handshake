<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/pumpfun-mcp</h1>

<p align="center"><strong>Free, read-only pump.fun + Solana MCP server — token discovery, on-chain analysis, and live 3D snapshots. No API keys.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/pumpfun-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/pumpfun-mcp?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/pumpfun-mcp"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/pumpfun-mcp?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/pumpfun-mcp?color=3b82f6">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-7c3aed"></a>
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/pumpfun-mcp?color=339933&logo=node.js">
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> A free, read-only [Model Context Protocol](https://modelcontextprotocol.io) server for **pump.fun** and **Solana**. It gives Claude — or any MCP client — live token discovery, on-chain bonding-curve and holder analysis, creator fee-claim tracking, Solana Name Service resolution, KOL signals, read-only swap quotes, and shareable live 3D token snapshots. Every Solana RPC and pump.fun API call runs server-side on the canonical [three.ws](https://three.ws) backend, so the data is live and on-chain while the client stays zero-config: **no API keys, no RPC URL, no wallet.**

## Install

### Claude Code (one-liner)

```bash
claude mcp add pumpfun -- npx -y @three-ws/pumpfun-mcp
```

### Claude Desktop / Cursor / any MCP client

Add to your MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, `.mcp.json`, etc.):

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

Restart the client and the pump.fun tools appear. No install step required.

### Run directly

```bash
npx -y @three-ws/pumpfun-mcp
# or install globally and run the bin
npm i -g @three-ws/pumpfun-mcp && pumpfun-mcp
```

## Quick start

The server speaks stdio JSON-RPC — your MCP client spawns it via the `npx` command above. Once configured, ask your client natural-language questions and it picks the right tool:

```text
"What's trending on pump.fun right now?"        → get_trending_tokens
"Show the bonding curve for <mint>"             → get_bonding_curve
"Who are the top holders of <mint>?"            → get_token_holders
"Resolve bonfida.sol"                           → sns_resolve
"Build a 3D snapshot for <mint>"                → pumpfun_token_3d
```

## Tools

All tools are **read-only** — nothing signs or sends a transaction. `pumpfun_quote_swap` only quotes; `pumpfun_vanity_mint` returns a keypair for you to use yourself.

| Tool                       | What it does                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_tokens`             | Search pump.fun tokens by name, symbol, or mint.                                                                                                                                                                                                                                      |
| `get_token_details`          | Full metadata for a mint.                                                                                                                                                                                                                                                             |
| `get_bonding_curve`          | Real/virtual reserves + graduation progress (on-chain).                                                                                                                                                                                                                               |
| `get_token_trades`           | Recent buy/sell history for a token.                                                                                                                                                                                                                                                  |
| `get_trending_tokens`        | Top tokens by market cap.                                                                                                                                                                                                                                                             |
| `get_new_tokens`             | Most recently launched tokens.                                                                                                                                                                                                                                                        |
| `get_graduated_tokens`       | Tokens that graduated to the Raydium AMM.                                                                                                                                                                                                                                             |
| `get_king_of_the_hill`         | Highest-cap token still on the bonding curve.                                                                                                                                                                                                                                         |
| `get_token_holders`          | Top holders with concentration analysis (on-chain).                                                                                                                                                                                                                                   |
| `get_creator_profile`        | A creator's tokens with rug-pull risk flags.                                                                                                                                                                                                                                          |
| `kol_leaderboard`          | Top KOL traders ranked by P&L for a 24h/7d/30d window.                                                                                                                                                                                                                                |
| `pumpfun_list_claims`      | Recent creator fee-claim events (on-chain).                                                                                                                                                                                                                                           |
| `pumpfun_watch_claims`     | Fee claims for a creator within a look-back window.                                                                                                                                                                                                                                   |
| `pumpfun_first_claims`     | First-ever creator claims — a cash-out signal.                                                                                                                                                                                                                                        |
| `pumpfun_quote_swap`       | Read-only pump.fun AMM swap quote (no signing).                                                                                                                                                                                                                                       |
| `pumpfun_watch_whales`     | Collect large trades on a token over a short window.                                                                                                                                                                                                                                  |
| `pumpfun_vanity_mint`      | Grind a vanity Solana keypair (secret returned to caller, never stored).                                                                                                                                                                                                              |
| `sns_resolve`              | Resolve a `.sol` domain to its owner wallet.                                                                                                                                                                                                                                          |
| `sns_reverseLookup`        | Reverse-lookup a wallet to its primary `.sol` domain.                                                                                                                                                                                                                                 |
| `social_cashtag_sentiment` | Deterministic lexicon sentiment over supplied posts.                                                                                                                                                                                                                                  |
| `social_x_post_impact`     | Correlate an X post to bonding-curve price impact.                                                                                                                                                                                                                                    |
| `pumpfun_bot_status`       | Configuration + health of the pump.fun indexer backend — `configured`, `healthy`, and ping latency. Always available.                                                                                                                                                                 |
| `pumpfun_token_3d`         | **Live 3D snapshot** of a token — composes metadata, holders, and graduation into a shareable [three.ws/coin3d](https://three.ws/coin3d) viewer (spinning coin medallion + holder galaxy + graduation ring) and returns the deep-link, an embeddable iframe, and the underlying data. |

The live tool list is fetched from the backend at startup; a bundled copy ships as an offline fallback so a fresh install always advertises a correct surface.

### Inspect the tools

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/pumpfun-mcp
```

## Configuration

No configuration is required. One optional override exists:

| Env var           | Default                             | Purpose                                                   |
| ----------------- | ----------------------------------- | --------------------------------------------------------- |
| `PUMPFUN_MCP_URL` | `https://three.ws/api/pump-fun-mcp` | Backend endpoint. Override only to self-host the handler. |

## How it works

This package is a small stdio ↔ HTTP bridge. It forwards MCP `tools/call` requests to the canonical three.ws pump.fun JSON-RPC backend, which performs the actual Solana RPC reads and pump.fun API queries. That keeps one authoritative implementation, ships no secrets to clients, and means the tool surface stays current automatically.

`pumpfun_token_3d` is a **native** tool: it runs in-process, orchestrating several backend reads (metadata + bonding curve + holders) and resolving the token logo from its on-chain metadata URI, then returns a deep-link into the three.ws 3D viewer. It needs no extra keys and adds no new backend dependency.

## Errors

Failures surface as MCP tool errors (`isError: true`) with the real cause — never a silent empty result:

| Error text | Meaning | Recovery |
| ---------- | ------- | -------- |
| `Backend request failed: …` | The bridge could not reach the backend (network, non-2xx, bad JSON). | Check connectivity / `PUMPFUN_MCP_URL`; safe to retry. |
| `[-32602] …` | Invalid argument (e.g. `pumpfun_token_3d` without a `mint`). | Fix the argument named in the message. |
| `[-32004] no on-chain data for <mint>: …` | `pumpfun_token_3d` found no metadata, curve, or holder data for the mint. | Verify the mint address and network (`mainnet`/`devnet`). |
| `[<code>] <message>` | Any other backend JSON-RPC error (unknown tool, indexer unavailable, on-chain read failure), passed through verbatim. | The message states the upstream cause; transient indexer errors are safe to retry. |

`pumpfun_token_3d` degrades gracefully: if only some of its three source reads succeed it still returns a snapshot, marking the missing parts (`no holder data available`, `no bonding-curve data available`) — it errors only when all three fail.

## Requirements

- Node.js **>= 20** (from `engines`).
- No API keys, RPC URL, or wallet. Outbound HTTPS to the three.ws backend (or your `PUMPFUN_MCP_URL`).

## Related

- [`@three-ws/mcp-server`](https://www.npmjs.com/package/@three-ws/mcp-server) — the paid, x402-settled three.ws MCP (text→3D mesh, avatars, pose seeds, ERC-8004 reputation, and a paid `pump_snapshot`).

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0 — see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
