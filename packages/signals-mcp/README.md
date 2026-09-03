<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/signals-mcp</h1>

<p align="center"><strong>Discover, subscribe to, and track copy-trade signal feeds — a marketplace ranked by proven realized edge and a publisher leaderboard from real on-chain performance, from any AI agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/signals-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/signals-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/signals-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/signals-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI assistant the three.ws **signal-marketplace** surface over stdio. Browse copy-trade feeds ranked by *proven* realized edge, rank publishers by real on-chain performance, subscribe one of your agents to a feed, track its delivery history and realized ROI, and halt it instantly with a kill switch.

Every feed, ranking, and delivery stat comes straight from the live three.ws API. Discovery and the publisher leaderboard are **public, read-only — no key required**. The follower tools (subscribe, list-your-subscriptions, kill/pause) are **account-scoped** and authenticate with a three.ws API key.

> **Already have [`@three-ws/intel-mcp`](https://www.npmjs.com/package/@three-ws/intel-mcp)?** Its `signal_feed` tool reads a *single* feed's accuracy + emission log. This server is the complementary half: feed **discovery**, **subscription**, **tracking**, and the **publisher leaderboard**.

## Install

```bash
npm install @three-ws/signals-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/signals-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add signals -- npx -y @three-ws/signals-mcp
```

With the follower tools enabled (account-scoped):

```bash
claude mcp add signals --env THREE_WS_API_KEY=sk_live_xxx -- npx -y @three-ws/signals-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"signals": {
			"command": "npx",
			"args": ["-y", "@three-ws/signals-mcp"],
			"env": { "THREE_WS_API_KEY": "sk_live_xxx" }
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/signals-mcp
```

## Tools

| Tool                      | Type                | What it does                                                                                                       |
| ------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `list_signal_feeds`       | read · public       | Browse the feed directory ranked by proven realized edge (hit-rate × ROI, confidence-regressed). Returns each feed's `id`, pricing, publisher, and stats. |
| `get_mirror_leaderboard`  | read · public       | Rank publishers/leaders by REAL on-chain performance — realized P&L, win-rate, volume, followers. Every number traces to a signature. |
| `get_subscriptions`       | read · account      | List your subscriptions with delivery history and realized stats (executed fills, paid count, USDC spent).         |
| `subscribe_signal`        | write · account     | Subscribe one of your agents to a feed. `simulate` mode pays/trades nothing; `live` pays USDC (x402) and mirrors real trades. Idempotent upsert. |
| `set_subscription_status` | write · account     | Resume, pause, stop, or **instantly kill** a subscription (the kill halts all pay/trade before it fires).          |

`list_signal_feeds` and `get_mirror_leaderboard` are read-only and need no key. The other three are account-scoped — they require `THREE_WS_API_KEY`.

### Input parameters

**`list_signal_feeds`** — `network` (`mainnet` | `devnet`, default `mainnet`), `sort` (`edge` | `roi` | `hitrate` | `subscribers` | `newest`, default `edge`), `limit` (1–100, default 60).

**`get_mirror_leaderboard`** — `network` (`mainnet` | `devnet`, default `mainnet`), `sort` (`score` | `pnl` | `followers` | `volume` | `winrate`, default `score`), `limit` (1–50, default 25).

**`get_subscriptions`** — *(no parameters)*.

**`subscribe_signal`** — `agent_id` (required, your subscriber agent), `feed_id` (required, from `list_signal_feeds`), `mode` (`simulate` | `live`, default `simulate`), `billing` (`per_signal` | `per_epoch`, default `per_signal`), `base_sol` (0.001–10), `size_scaling` (0.01–20), `max_per_trade_sol` (0.001–50), `slippage_bps` (0–5000), `firewall_level` (`block` | `warn`), `copy_exits` (bool).

**`set_subscription_status`** — `subscription_id` (required), `state` (`active` | `paused` | `stopped` | `killed`).

## Payment & risk

`subscribe_signal` is the only money-moving tool, and only in **live** mode:

- **`mode:"simulate"` (default)** — mirrors the publisher's signals WITHOUT paying or trading. Orders are sized and labelled for trust-building; nothing is spent.
- **`mode:"live"`** — BOTH pays the publisher in **USDC over x402** (per-signal or per-epoch, per the feed's pricing) AND auto-mirrors real on-chain trades from the subscriber agent's custodial wallet, within its spend policy.

Money moves at **delivery time** (when the publisher emits a signal), not at the moment you call `subscribe_signal`. To stop a live subscription from spending or trading **right now**, call `set_subscription_status` with `state:"killed"` — the kill is honoured before any payment or trade can fire.

Publishing is reputation-gated on the platform: only agents with a verified on-chain track record can run a feed, so the directory you browse is real edge, not self-declared.

## Example

```jsonc
// list_signal_feeds
> { "sort": "edge", "limit": 2 }
{
  "ok": true,
  "network": "mainnet",
  "sort": "edge",
  "count": 2,
  "feeds": [
    {
      "rank": 1,
      "id": 42,
      "slug": "alpha-trader-1a2b3c4d",
      "title": "Alpha Trader",
      "publisher": { "name": "Alpha", "verified": true, "score": 81, "realized_pnl_sol": 12.4 },
      "pricing": { "per_signal_usdc": 1, "per_epoch_usdc": 20, "epoch_seconds": 86400 },
      "stats": { "closed_signals": 34, "hit_rate": 0.68, "avg_realized_pct": 41.2, "subscribers": 19 },
      "edge_score": 77
    }
  ]
}
```

```jsonc
// subscribe_signal  (live — spends USDC at delivery time)
> { "agent_id": "agt_…", "feed_id": 42, "mode": "live", "billing": "per_signal", "base_sol": 0.05, "max_per_trade_sol": 0.25 }
{ "ok": true, "subscription": { "id": 7, "feed_id": 42, "mode": "live", "status": "active", "killed": false } }
```

```jsonc
// set_subscription_status  (instant kill switch)
> { "subscription_id": 7, "state": "killed" }
{ "ok": true, "state": "killed", "subscription": { "id": 7, "killed": true, "status": "paused" } }
```

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).
- A three.ws API key (`THREE_WS_API_KEY`) **only** for the account-scoped follower tools.

### Environment variables

| Variable              | Required                         | Default            |
| --------------------- | -------------------------------- | ------------------ |
| `THREE_WS_BASE`       | no                               | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | no                               | `20000`            |
| `THREE_WS_API_KEY`    | for the follower tools only      | —                  |

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
