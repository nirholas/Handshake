<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/copy-mcp</h1>

<p align="center"><strong>Drive your three.ws copy-trading from any AI agent — follow leaders, tune sizing &amp; guard rules, work the copy-intent inbox, and track fees owed. Headless, non-custodial.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/copy-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/copy-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/copy-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/copy-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that turns the three.ws **copy-trading** control surface — follow/unfollow leaders, tune guard rules, read your copy-intent inbox, and see fees owed — into agent-drivable tools over stdio. Everything the website's copy dashboard does, headless.

**Non-custodial by design.** three.ws never signs a transaction or holds your funds. When a leader you follow trades, the engine produces a **sized, guard-checked copy INTENT** that you (or your agent) act on from your own wallet. Every order is clamped to your per-trade cap and your remaining daily budget, so a runaway leader can never drain you. Performance fees settle in **$THREE**.

## Install

```bash
npm install @three-ws/copy-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/copy-mcp
```

## Quick start

Copy trading is account-scoped, so set `THREE_WS_API_KEY` to a three.ws API key (`sk_live_…` / `sk_test_…`) or OAuth access token. Mint one at [three.ws/dashboard/developers](https://three.ws/dashboard/developers).

**Claude Code**, one line:

```bash
claude mcp add copy --env THREE_WS_API_KEY=sk_live_xxx -- npx -y @three-ws/copy-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"copy": {
			"command": "npx",
			"args": ["-y", "@three-ws/copy-mcp"],
			"env": { "THREE_WS_API_KEY": "sk_live_xxx" }
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
THREE_WS_API_KEY=sk_live_xxx npx -y @modelcontextprotocol/inspector npx @three-ws/copy-mcp
```

> Discovery (which leaders to follow) lives in [`@three-ws/intel-mcp`](https://www.npmjs.com/package/@three-ws/intel-mcp) → `copy_smart_wallets`. This server manages the follows you commit to.

## Tools

| Tool                  | Type             | What it does                                                                                                   |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_subscriptions`  | read-only        | Every leader you follow — status, sizing rule, full guard-rule set, perf fee, and live pending/acted counts.   |
| `create_subscription` | write (idempotent)| Follow a leader / re-tune the follow. Defines how their trades size into your wallet. Upserts per leader.      |
| `update_subscription` | write (idempotent)| Pause / resume / stop a follow, or change its sizing &amp; guard rules. Patch by id — only the fields you pass. |
| `cancel_subscription` | write (destructive)| Soft-stop a follow: no more intents, history preserved. Re-follow later with `create_subscription`.           |
| `get_executions`      | read-only        | Your copy-intent inbox + history — coin, direction, sized order, skip reason, status, recorded fill.           |
| `record_execution`    | write            | Mark a pending intent **acted** (optionally with your fill signature) or **dismissed**. Never signs for you.    |
| `get_earnings`        | read-only        | Your fees owed across the leaders you copy — or, with `agent_id`, a leader's public aggregate earnings.         |

All reads return live data (counts, intents, and accruals move between calls), so none are idempotent.

### Input parameters

**`list_subscriptions`** — none.

**`create_subscription`** — `leader_agent_id` (required, UUID), `copier_wallet` (required, base58), `network` (`mainnet` | `devnet`, default `mainnet`), `sizing_rule` (`fixed` | `multiplier` | `pct_balance`, default `fixed`), `fixed_sol` (required for `fixed` sizing), `multiplier` (default `0.1`), `pct_balance` (0–100), `per_trade_cap_sol` (default `0.5`), `min_order_sol` (default `0.02`), `daily_budget_sol` (default `1`), `max_open_copies` (1–100, default `5`), `mcap_floor_usd`, `mcap_ceiling_usd`, `copy_sells` (default `true`), `require_safety_pass` (default `false`), `min_oracle_score` (0–100), `perf_fee_bps` (0–3000, default `1000`), `telegram_chat_id`.

**`update_subscription`** — `id` (required, UUID) plus any of: `status` (`active` | `paused` | `stopped`), and the sizing/guard fields from `create_subscription` (each optional; pass `null` to clear `mcap_floor_usd` / `mcap_ceiling_usd` / `min_oracle_score` / `telegram_chat_id`). Only the fields you pass change. `leader_agent_id` and `network` cannot be changed here: they identify the subscription, so re-pointing them means creating a new follow with `create_subscription`.

**`cancel_subscription`** — `id` (required, UUID).

**`get_executions`** — `status` (`pending` | `acted` | `dismissed` | `skipped` | `expired` | `all`, default `pending`), `limit` (1–100, default `50`).

**`record_execution`** — `id` (required, UUID), `action` (`acted` | `dismissed`), `tx_signature` (optional, recorded only when `acted`).

**`get_earnings`** — `agent_id` (optional UUID — provide for a leader's public aggregate; omit for your own rollup), `network` (`mainnet` | `devnet`, default `mainnet`).

## Example

```jsonc
// create_subscription — follow a leader, 0.05 SOL per copy, capped, safety-gated
> {
    "leader_agent_id": "8f3c…-uuid",
    "copier_wallet": "7Np…YourWallet",
    "sizing_rule": "fixed",
    "fixed_sol": 0.05,
    "per_trade_cap_sol": 0.1,
    "daily_budget_sol": 0.5,
    "mcap_floor_usd": 50000,
    "require_safety_pass": true
  }
{
  "ok": true,
  "subscription": {
    "id": "…",
    "status": "active",
    "network": "mainnet",
    // the create/update responses return the raw subscription row, so leader
    // name/image are null here; list_subscriptions joins the leader profile
    // and also adds pending_count / acted_count per row
    "leader": { "agent_id": "8f3c…", "name": null, "image": null, "wallet": null },
    "copier_wallet": "7Np…YourWallet",
    "sizing": { "rule": "fixed", "fixed_sol": 0.05, "multiplier": 0.1, "pct_balance": 0 },
    "guards": {
      "per_trade_cap_sol": 0.1, "min_order_sol": 0.02, "daily_budget_sol": 0.5,
      "max_open_copies": 5, "mcap_floor_usd": 50000, "mcap_ceiling_usd": null,
      "copy_sells": true, "require_safety_pass": true, "min_oracle_score": null
    },
    "perf_fee_bps": 1000
  }
}
```

```jsonc
// get_executions — the actionable inbox
> { "status": "pending", "limit": 5 }
{
  "ok": true,
  "status": "pending",
  "count": 1,
  "executions": [
    {
      "id": "…",
      "status": "pending",
      "leader": { "name": "…" },
      "coin": { "mint": "…", "symbol": "…", "name": "…" },
      "direction": "buy",
      "planned_sol": 0.05,
      "expires_at": "…"
    }
  ]
}
```

```jsonc
// record_execution — you bought it yourself; log the fill
> { "id": "…", "action": "acted", "tx_signature": "5xQ…" }
{ "ok": true, "execution": { "id": "…", "status": "acted", "tx_signature": "5xQ…" } }
```

## Requirements

- **Node.js >= 20.**
- A three.ws account credential in `THREE_WS_API_KEY` (all tools except a leader's public aggregate earnings).
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable              | Required | Default            | Notes                                                    |
| --------------------- | -------- | ------------------ | -------------------------------------------------------- |
| `THREE_WS_API_KEY`    | all tools except `get_earnings` with `agent_id` | — | API key (`sk_live_…`) or OAuth token. Treat like cash. |
| `THREE_WS_BASE`       | no       | `https://three.ws` | Override for self-hosting / preview deployments.         |
| `THREE_WS_TIMEOUT_MS` | no       | `20000`            | Per-request timeout in ms.                               |

## Errors

A failed tool call returns an MCP error result (`isError: true`) whose text is a single JSON object: `{ "ok": false, "error": "<code>", "message": "…" }`, plus `status` on upstream rejections:

| `error` | Meaning | Recovery |
| ------- | ------- | -------- |
| `missing_credential` | The tool needs auth and `THREE_WS_API_KEY` is unset. Thrown before any request is sent. | Set the key. |
| `validation_error` | Bad arguments caught client-side, e.g. `sizing_rule: "fixed"` without a positive `fixed_sol`. | Fix the call. |
| `no_changes` | `update_subscription` was called with only an `id`. | Pass at least one field to change. |
| `not_found` | `update_subscription` was given an `id` that is not one of your subscriptions. | Check `list_subscriptions`. |
| `upstream_error` | The API rejected the request; `status` carries the HTTP code (`400` bad fields, `401` bad/expired credential, `404` no such subscription on `cancel_subscription`, `409` no such pending intent on `record_execution`, `429` rate-limited). | Act on the message and `status`. |
| `timeout` | No response within `THREE_WS_TIMEOUT_MS`. | Retry or raise the timeout. |
| `network_error` | The request never reached the API (DNS, offline, TLS). | Check connectivity / `THREE_WS_BASE`. |
| `bad_config` | `THREE_WS_TIMEOUT_MS` is not a positive number. Thrown while the server starts (module load), so the process exits before serving. | Fix the env var. |

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
