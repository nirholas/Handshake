<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/alerts-mcp</h1>

<p align="center"><strong>Run your own pump.fun monitoring from any AI agent — define alert rules, deliver them in-app / by signed webhook / to Telegram, and read the fired-alert history.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/alerts-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/alerts-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/alerts-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/alerts-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that turns the three.ws pump.fun **alerts** surface into an agent-drivable control plane over stdio. Define rules on pump.fun events — graduations, market-cap crossings, whale buys, new launches — and let the three.ws cron evaluate them against the live event stream and deliver across in-app, webhook, and Telegram. Read back what actually fired, with per-channel delivery health.

Rules are **account-scoped**: every call carries your three.ws session, so the server reads and writes only *your* rules and *your* alert history. The pumpfun-monitor cron does the watching server-side, so your rules fire across devices with no dashboard open.

## Install

```bash
npm install @three-ws/alerts-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/alerts-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add alerts -e THREE_WS_SESSION=your-__Host-sid-cookie -- npx -y @three-ws/alerts-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"alerts": {
			"command": "npx",
			"args": ["-y", "@three-ws/alerts-mcp"],
			"env": {
				"THREE_WS_SESSION": "your-__Host-sid-cookie"
			}
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
THREE_WS_SESSION=… npx -y @modelcontextprotocol/inspector npx @three-ws/alerts-mcp
```

## Authentication

Every tool is account-scoped. Set **`THREE_WS_SESSION`** to the value of your `__Host-sid` cookie from a signed-in [three.ws](https://three.ws) browser session (DevTools → Application → Cookies → `__Host-sid`). The server sends it the same way your browser does; for writes it first fetches a one-time CSRF token from `/api/csrf-token` and echoes it, exactly like the site. Treat the session value like a password. No Solana key or signer is involved.

## Tools

| Tool                | Type                  | What it does                                                                                                       |
| ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `list_alert_rules`  | read-only             | List your alert rules with live delivery health — `last_fired_at`, recent failures, recent per-channel outcomes.   |
| `create_alert_rule` | write (appends)       | Define a new rule on a pump.fun event. Not idempotent — each call adds a rule (max 50).                            |
| `update_alert_rule` | write (idempotent)    | Retune a threshold, pause/resume (`enabled`), swap delivery channels, or change `kind`. Only passed fields change. |
| `delete_alert_rule` | write (**destructive**) | Permanently remove a rule and its fire/delivery history. Prefer `update_alert_rule` with `enabled:false` to pause. |
| `get_alert_history` | read-only             | Read the alerts that actually fired, newest first — each with a summary, originating `rule_id`, and full payload.   |

### Rule kinds & targeting

| `kind`         | Target                          | `threshold`               |
| -------------- | ------------------------------- | ------------------------- |
| `graduation`   | global, or `target_mint` / `target_agent` | — |
| `price_above`  | `target_mint` (required)        | USD market cap            |
| `price_below`  | `target_mint` (required)        | USD market cap            |
| `whale_buy`    | `target_mint` (required)        | minimum buy size in SOL   |
| `new_mint`     | `target_agent` (required)       | —                         |

At least one delivery channel must be on: `deliver_in_app` (default true), `webhook_url` (HTTPS — a per-rule `webhook_secret` is generated for verifying the `webhook-signature` header), and/or `telegram_chat` (numeric chat id or `@username`). `cooldown_seconds` (5–86400, default 300) throttles repeat fires.

> Any coin referenced in a rule is **runtime input you supply**. three.ws promotes only **$THREE** (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`).

## Example

```jsonc
// create_alert_rule — alert when a tracked agent's coin graduates, via webhook + Telegram
> {
    "kind": "graduation",
    "target_agent": "8a1c…-uuid",
    "webhook_url": "https://hooks.example.com/pump",
    "telegram_chat": "123456789",
    "cooldown_seconds": 600
  }
{
  "ok": true,
  "rule": {
    "id": "…", "kind": "graduation", "label_display": "Graduations · tracked agent",
    "target_agent": "8a1c…-uuid", "deliver_in_app": true,
    "webhook_url": "https://hooks.example.com/pump",
    "webhook_secret": "whsec_…", "telegram_chat": "123456789",
    "cooldown_seconds": 600, "enabled": true,
    "last_fired_at": null, "recent_failures": 0, "recent_deliveries": []
  }
}
```

```jsonc
// get_alert_history — what fired, newest first
> { "limit": 2 }
{
  "ok": true, "count": 2, "unread_count": 1,
  "alerts": [
    { "id": 1841, "fired_at": "2026-06-24T…Z", "read": false,
      "summary": "Whale bought 12.50 SOL ($2,310) of $THREE",
      "rule_id": "…", "kind": "whale_buy", "mint": "FeMb…pump", "symbol": "THREE",
      "event": { "amount_sol": 12.5, "amount_usd": 2310, "buyer": "…", "tx": "…" } }
  ]
}
```

## Requirements

- **Node.js >= 20.**
- A signed-in three.ws session (`THREE_WS_SESSION`).
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable              | Required | Default            | Notes                                                        |
| --------------------- | -------- | ------------------ | ------------------------------------------------------------ |
| `THREE_WS_SESSION`    | **yes**  | —                  | Your `__Host-sid` cookie value. Account credential — secret. |
| `THREE_WS_BASE`       | no       | `https://three.ws` | Override only for self-hosting / preview deployments.        |
| `THREE_WS_TIMEOUT_MS` | no       | `20000`            | Per-request timeout (ms).                                    |

## Programmatic use

The package entry point exports **`TOOLS`** (every tool definition: `name`, `title`,
`description`, `inputSchema`, `annotations`, `handler`) and **`buildServer()`**, which returns a
fully-registered `McpServer` with no transport attached. Importing is side-effect free and needs
no session, so you can mount the alert tools inside a host of your own or inspect the surface
offline; the session is only required when a handler actually runs.

```js
// run with: THREE_WS_SESSION=<your __Host-sid value> node this-file.mjs
import { TOOLS, buildServer } from '@three-ws/alerts-mcp';

for (const tool of TOOLS) {
	const kind = tool.annotations.readOnlyHint ? 'read ' : 'write';
	console.log(`${kind} ${tool.name}`);
}

// A tool handler is a plain async function against the live API.
const list = TOOLS.find((t) => t.name === 'list_alert_rules');
console.log(await list.handler({}));

// Or hand the whole registered server to your own MCP transport.
buildServer();
```

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
