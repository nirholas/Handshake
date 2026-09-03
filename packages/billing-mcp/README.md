<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/billing-mcp</h1>

<p align="center"><strong>An AI agent's own account economics over MCP, plan quotas, metered usage, invoices, receipts, and earnings. Read-only and account-scoped.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/billing-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/billing-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/billing-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/billing-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent self-serve its **own** account economics over stdio: how much of its plan quota is left, what its metered usage rolled up to this period, the line-item invoice and per-charge receipts behind every charge, and the earnings its agents have made, all without pulling in the human account owner.

Every read hits the live three.ws billing API: nothing is mocked. The account-scoped reads run against the account **you own**, resolved from your three.ws session. This server is **read-only**: it surfaces private billing data but never signs, charges, or moves funds.

## Install

```bash
npm install @three-ws/billing-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/billing-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add billing -- npx -y @three-ws/billing-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"billing": {
			"command": "npx",
			"args": ["-y", "@three-ws/billing-mcp"],
			"env": {
				"THREE_WS_SESSION": "<your __Host-sid cookie>"
			}
		}
	}
}
```

`THREE_WS_SESSION` is required for every read except the public fee rate, it's the value of the `__Host-sid` cookie from a signed-in three.ws browser session, and the API uses it to resolve your account and return only your data.

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/billing-mcp
```

## Tools

| Tool                       | Type              | What it does                                                                                                                |
| -------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `get_billing_summary`      | read · session    | Your plan tier, its quota ceilings, and live usage against them (avatars + storage, agents, MCP calls, LLM calls) + headroom. |
| `query_usage`              | read · session    | Metered usage rolled into an invoice statement for a period, per-action line items, totals, and reconciliation.            |
| `export_billing_history`   | read · session    | The same line items as a ready-to-save CSV payload (with a suggested filename and a parsed preview).                        |
| `get_receipt`              | read · session    | One itemized receipt, per-charge by `event_id` (with settlement tx + explorer link) or a signed skill-purchase receipt by `purchase_id`. |
| `get_fee_info`             | read · **public** | The current platform fee rate (`fee_bps` + `fee_percent`). Needs no session.                                                |

Everything reads live state: usage and invoices move between calls, so no tool is idempotent, and nothing here mutates anything.

### Input parameters

**`get_billing_summary`**: none.

**`query_usage`**: `period` (YYYY-MM, optional), `from` / `to` (ISO-8601, optional; ignored when `period` is set). Defaults to the current UTC calendar month.

**`export_billing_history`**: `period`, `from`, `to` (same as `query_usage`), `preview_rows` (0-100, default 5, how many parsed rows to echo in `preview`; the full CSV is always returned).

**`get_receipt`**: exactly one of `event_id` (numeric, per-charge receipt) or `purchase_id` (UUID, signed skill-purchase receipt).

**`get_fee_info`**: none.

## Examples

```jsonc
// get_billing_summary: plan ceilings and live usage against them
> {}
{
  "ok": true,
  "plan": "free",
  "quotas": {
    "max_avatars": 10,
    "max_bytes_per_avatar": 26214400,
    "max_total_bytes": 262144000,
    "mcp_calls_per_day": 1000
  },
  "usage": {
    "avatar_count": 1,
    "total_bytes": 1234540,
    "agent_count": 1,
    "mcp_calls_24h": 0,
    "llm_calls_month": 0
  },
  "remaining": { "avatars": 9, "total_bytes": 260909460, "mcp_calls_today": 1000 }
}
```

```jsonc
// query_usage: the period statement (defaults to the current UTC month)
> {}
{
  "ok": true,
  "period_label": "2026-08",
  "period": { "from": "2026-08-01T00:00:00.000Z", "to": "2026-09-01T00:00:00.000Z" },
  "line_item_count": 0,
  "line_items": [],
  "totals": {
    "charge_count": 0,
    "gross_atomics": "0", "fee_atomics": "0", "net_atomics": "0",
    "gross_usd": "0.00", "fee_usd": "0.00", "net_usd": "0.00",
    "currency": "USDC"
  },
  "reconciliation": { "total": 0, "reconciled": 0, "unreconciled": 0, "all_reconciled": true }
}
```

```jsonc
// export_billing_history: the same statement as a ready-to-save CSV
> { "preview_rows": 5 }
{
  "ok": true,
  "filename": "three-ws-invoice-2026-08.csv",
  "content_type": "text/csv; charset=utf-8",
  "row_count": 1,
  "preview": [ { "action": "TOTAL", "count": "0", "gross_usd": "0.00", "fee_usd": "0.00" } ],
  "csv": "action,label,count,units,gross_usd,fee_usd,discount_bps\nTOTAL,,0,,0.00,0.00,\n"
}
```

```jsonc
// get_fee_info: the one read that needs no session
> {}
{ "ok": true, "fee_bps": 250, "fee_percent": "2.5" }
```

A quiet account reads like the statements above: zeroed totals with
`all_reconciled: true`. That is the healthy empty state, not a failed call. Every
read without `THREE_WS_SESSION` (except `get_fee_info`) fails loudly instead of
returning empty data:

```jsonc
{ "ok": false, "error": "no_session", "status": 401,
  "message": "/api/billing/summary is account-scoped and needs your three.ws session. …" }
```

## What you owe

- **"What did this cost me?"** → `query_usage` / `export_billing_history` / `get_receipt`, metered charges, the period statement, and the receipt behind any single charge.

`get_billing_summary` sits above them: your plan, its quota ceilings, and how much headroom is left.

## Money & units

- Charge amounts are in **USDC atomics** (6 decimals) alongside a human `*_usd` string, e.g. `gross_atomics: "150000"` is `gross_usd: "0.15"`.
- `reconciliation` on the usage reads tells you whether every metered charge maps to a real on-chain settlement (`all_reconciled`, plus counts).

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable                | Required                         | Default              |
| ----------------------- | -------------------------------- | -------------------- |
| `THREE_WS_BASE`         | no                               | `https://three.ws`   |
| `THREE_WS_TIMEOUT_MS`   | no                               | `20000`              |
| `THREE_WS_SESSION`      | yes (all reads but `get_fee_info`) | -                  |

`THREE_WS_SESSION` is the value of the `__Host-sid` cookie from a signed-in three.ws browser session. Treat it like a password, it grants read access to your private billing data.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite, 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
