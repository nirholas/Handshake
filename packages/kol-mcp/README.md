<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/kol-mcp</h1>

<p align="center"><strong>Track one smart trader — a tracked KOL wallet's portfolio P&L and its trades on a given mint, from any AI agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/kol-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/kol-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/kol-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/kol-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server for the **per-wallet KOL deep dive**. Where [`@three-ws/intel-mcp`](https://www.npmjs.com/package/@three-ws/intel-mcp) ranks the whole tracked KOL set (`kol_leaderboard`) and shows everyone's trades on a mint (`kol_trades`), this server zooms in on **one** smart trader: pull their live portfolio P&L card, then inspect their own buys/sells of a specific token — everything an agent needs to decide whether to copy or analyze them.

Portfolio P&L comes from the three.ws Birdeye proxy (the Birdeye key lives server-side); trade history comes from the three.ws Helius-backed KOL feed. All live, read-only — no API key, signer, or payment on the client. Point `THREE_WS_BASE` at a deployment and go.

## Install

```bash
npm install @three-ws/kol-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/kol-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add kol -- npx -y @three-ws/kol-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"kol": {
			"command": "npx",
			"args": ["-y", "@three-ws/kol-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/kol-mcp
```

## Tools

| Tool                   | Type      | What it does                                                                                                              |
| ---------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `get_wallet_portfolio` | read-only | One KOL wallet's live portfolio P&L card: realized P&L, unrealized (open-position) P&L, win rate, total trades, top holding. |
| `get_wallet_trades`    | read-only | That wallet's recent buys/sells of a given mint — side, SOL size, token amount, price, USD value, and timing, newest first. |

Both tools read live data: portfolio P&L and trade feeds move between calls, so neither is idempotent.

### Input parameters

**`get_wallet_portfolio`** — `wallet` (required).

**`get_wallet_trades`** — `wallet` (required), `mint` (required), `limit` (1–100, default 20).

> The three.ws trade feed is mint-keyed (it scans every tracked KOL wallet for activity on one mint), so a per-wallet view is that feed narrowed to your wallet. `get_wallet_trades` therefore needs both a `wallet` and a `mint`. To see *every* tracked wallet's trades on a mint, use `kol_trades` in [`@three-ws/intel-mcp`](https://www.npmjs.com/package/@three-ws/intel-mcp).

## Example

```jsonc
// get_wallet_portfolio
> { "wallet": "5xY…KoL" }
{
  "ok": true,
  "wallet": "5xY…KoL",
  "has_activity": true,
  "realized_pnl_usd": 124300,
  "unrealized_pnl_usd": 38120,
  "win_rate": 0.64,
  "total_trades": 412,
  "top_token": { "symbol": "THREE", "pnl": 38120 }
}
```

```jsonc
// get_wallet_trades
> { "wallet": "5xY…KoL", "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump", "limit": 3 }
{
  "ok": true,
  "wallet": "5xY…KoL",
  "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
  "count": 2,
  "trades": [
    { "side": "buy", "amountSol": 4.2, "amountToken": 1830000, "price": 0.0000022, "usd": 612.4, "time": "2026-06-24T09:12:03.000Z", "source": "kol", "label": "Top Trader" }
  ]
}
```

`has_activity: false` on a portfolio (all-zero P&L, no trades, no holding) means the proxy has no recorded history for that address yet — an honest "no data", not a failure.

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable              | Required | Default            |
| --------------------- | -------- | ------------------ |
| `THREE_WS_BASE`       | no       | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | no       | `20000`            |

No key on the client: the Birdeye key that backs portfolio P&L and the Helius key behind the trade feed both live server-side on three.ws.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: proprietary, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
