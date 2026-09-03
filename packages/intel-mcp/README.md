<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/intel-mcp</h1>

<p align="center"><strong>Read the market the way the smart money does — smart-money scoring, wallet intel, signal feeds, KOL trades, and the copy-trade directory, from any AI agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/intel-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/intel-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/intel-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/intel-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI assistant the three.ws **market-intelligence** surface over stdio. Judge a coin by *who* is buying it, pull a wallet's realized reputation, read a signal feed's proven accuracy, rank KOL traders, and browse the copy-trade Smart Money directory — all live, read-only, no key required.

Every score, signal, and ranking comes straight from the public three.ws API. No API key, no signer, no payment — point `THREE_WS_BASE` at a deployment and go.

## Install

```bash
npm install @three-ws/intel-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/intel-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add intel -- npx -y @three-ws/intel-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"intel": {
			"command": "npx",
			"args": ["-y", "@three-ws/intel-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/intel-mcp
```

## Tools

| Tool                 | Type      | What it does                                                                                                  |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `smart_money_coin`   | read-only | Score a coin by WHO is net-buying it — 0–100 smart-money score, reputable buyers, funder clusters, sybil flag. |
| `wallet_intel`       | read-only | One wallet's realized reputation: score, win rate, behavioral labels, and its funder cluster.                  |
| `signal_feed`        | read-only | A signal feed's proven accuracy (hit-rate, realized/follower ROI) and recent emissions with on-chain proof.    |
| `kol_leaderboard`    | read-only | Rank tracked KOL traders by realized P&L over a 7d / 30d window.                                               |
| `kol_trades`         | read-only | Recent KOL trades on a specific mint, across the tracked KOL set.                                              |
| `copy_smart_wallets` | read-only | Browse the ranked copy-trade Smart Money directory — filter by chain, category, and sort.                      |

All six tools read live data: scores, feeds, and rankings move between calls, so none are idempotent.

### Input parameters

**`smart_money_coin`** — `mint` (required), `network` (`mainnet` | `devnet`, default `mainnet`).

**`wallet_intel`** — `wallet` (required), `network` (`mainnet` | `devnet`, default `mainnet`).

**`signal_feed`** — `slug` (required), `network` (`mainnet` | `devnet`, default `mainnet`).

**`kol_leaderboard`** — `window` (`7d` | `30d`, default `7d`), `limit` (1–100, default 25).

**`kol_trades`** — `mint` (required), `limit` (1–100, default 20).

**`copy_smart_wallets`** — `chain` (`sol` | `bsc`), `category` (`smart_money` | `launchpad` | `kol` | `sniper`), `sort` (`profit` | `pnl` | `winrate` | `followers` | `score`, default `score`), `q` (text), `limit` (1–100, default 30), `offset` (default 0).

## Example

```jsonc
// copy_smart_wallets
> { "chain": "sol", "sort": "winrate", "limit": 3 }
{
  "ok": true,
  "count": 3,
  "total": 412,
  "offset": 0,
  "limit": 3,
  "has_more": true,
  "facets": { "byChain": { "sol": 300, "bsc": 112 }, "byCategory": { "smart_money": 180, "kol": 90 } },
  "wallets": [
    { "address": "…", "chain": "sol", "categories": ["smart_money"], "score": 94, "win_rate_30d": 0.71, "realized_profit_30d_usd": 182000, "follow_count": 1240 }
  ]
}
```

```jsonc
// smart_money_coin
> { "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" }
{
  "ok": true,
  "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
  "network": "mainnet",
  "computed": true,
  "smart_money_score": 78,
  "reputable_buyers": 12,
  "sybil_flag": false,
  "sybil_share": 0.18,
  "wallets": [ /* reputable buyers with realized_score, win_rate, labels */ ],
  "clusters": [ /* funder clusters in the book */ ]
}
```

`computed: false` on a coin or wallet means the smart-money graph has no on-chain history for it yet — that's an honest "not enough data", not a failure.

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable              | Required | Default            |
| --------------------- | -------- | ------------------ |
| `THREE_WS_BASE`       | no       | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | no       | `20000`            |

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
