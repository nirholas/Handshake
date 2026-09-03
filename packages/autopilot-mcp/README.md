<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/autopilot-mcp</h1>

<p align="center"><strong>An AI agent's own autonomous-execution control plane — set autopilot scopes, a daily SOL spend cap, and auto-execute, then run the propose → execute → undo loop, all from any MCP client.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/autopilot-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/autopilot-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/autopilot-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/autopilot-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI agent **its own execution control plane** over stdio. The agent configures the boundaries it is allowed to act within — capability scopes, a daily SOL spend ceiling, auto-execute and confirmation policy — then drives the full **propose → review → execute → undo** loop. No human in the loop, but every boundary is **enforced server-side**: an out-of-scope or over-budget action is denied, never executed.

This is the keystone of the autonomous-agent story. Autopilot config and execution used to live only behind the three.ws UI/API; this server exposes them so an agent can manage its own guardrails and act within them.

> ⚠️ **This server is authenticated and write-heavy.** `execute_proposal` can move **real SOL** on Solana mainnet and is **irreversible**. It sends native SOL only — the agent never sells or sends **$THREE** (it only buys, holds, or burns it). Scopes, the daily SOL spend cap, and confirmation are all enforced on the three.ws backend — this server cannot bypass them.

## Install

```bash
npm install @three-ws/autopilot-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/autopilot-mcp
```

## Quick start

**Claude Code**, one line (supply your three.ws credential):

```bash
THREE_WS_API_KEY=sk_live_… claude mcp add autopilot -- npx -y @three-ws/autopilot-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"autopilot": {
			"command": "npx",
			"args": ["-y", "@three-ws/autopilot-mcp"],
			"env": {
				"THREE_WS_API_KEY": "sk_live_…"
			}
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
THREE_WS_API_KEY=sk_live_… npx -y @modelcontextprotocol/inspector npx @three-ws/autopilot-mcp
```

## Authentication

Every autopilot endpoint is **owner-only**, so this server is authenticated. Set **`THREE_WS_API_KEY`** to the agent owner's three.ws credential — either a three.ws **API key** (`sk_live_…` / `sk_test_…`) or an **OAuth access token**. It is sent as `Authorization: Bearer …` on every request and identifies the owning user; the agent can only manage agents that user owns. The credential can authorize **real SOL transfers** via `execute_proposal` — store it like a password. `THREE_WS_TOKEN` and `THREE_WS_BEARER` are accepted as aliases.

## Tools

| Tool                      | Type             | What it does                                                                                                        |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `get_autopilot_config`    | read-only        | Read the agent's guardrails: enabled, scopes, auto-execute, daily SOL cap, confirmation policy — plus trust.     |
| `set_autopilot_config`    | write · idempotent | Update those guardrails with a partial patch (grant scopes, set the daily SOL ceiling, arm/disarm). No action taken. |
| `generate_proposals`      | write            | Run the agent's mind: turn high-salience memories + reflections into real, provenance-cited candidate actions.       |
| `list_proposals`          | read-only        | The proposal queue — ids, kinds, rationales, params, status, cited sources. Filter by status.                       |
| `dryrun_proposal`         | read-only        | Preview what executing a proposal *would* do (scope / cap / balance checks), without taking any action.             |
| `adjust_proposal`         | write · idempotent | Edit a pending proposal's params before executing (tune a threshold, amount, cadence). Validated server-side.       |
| `execute_proposal`        | **write · destructive** | Take the real action. ⚠️ A `wallet_transfer` moves real SOL on mainnet, irreversible — needs `confirm:true`. Never sends $THREE. |
| `dismiss_proposal`        | write            | Drop a pending proposal; records a feedback memory so the agent stops proposing it.                                 |
| `undo_action`             | write            | Reverse a reversible execution (delete the alert rule / briefing); records a feedback memory. SOL transfers can't be undone. |
| `list_autopilot_activity` | read-only        | The append-only signed receipts log — every autonomous action, its outcome, provenance, and signature.             |
| `compute_trust`           | read-only        | The agent's earned trust level (sandbox → trusted → autonomous), computed from real action history.                |

The five read tools reflect live state (proposals, receipts, trust move between calls), so none are idempotent. `set_autopilot_config` and `adjust_proposal` are idempotent writes (re-applying the same values is a no-op). `generate_proposals`, `execute_proposal`, `dismiss_proposal`, and `undo_action` each take a real action.

### Input parameters

Every tool takes **`agentId`** (the UUID of an agent you own) except `list_autopilot_activity`, where it is optional (omit to aggregate across all your agents).

- **`get_autopilot_config`** / **`compute_trust`** / **`generate_proposals`** — `agentId`.
- **`set_autopilot_config`** — `agentId`, plus any of: `enabled` (bool), `scopes` (`{ create_alert?, briefing?, wallet_transfer? }`), `autoExecute` (`{ create_alert?, briefing? }`), `dailySpendSol` (number, SOL; 0 disables spending), `requireConfirm` (bool).
- **`list_proposals`** — `agentId`, `status` (`pending` | `executed` | `dismissed` | `undone` | `failed`), `limit` (1–200).
- **`dryrun_proposal`** / **`dismiss_proposal`** / **`undo_action`** — `agentId`, `proposalId`.
- **`adjust_proposal`** — `agentId`, `proposalId`, `params` (full replacement params for the proposal's kind).
- **`execute_proposal`** — `agentId`, `proposalId`, `confirm` (bool — required for an irreversible SOL transfer).
- **`list_autopilot_activity`** — `agentId` (optional), `limit` (1–200), `cursor` (from a prior `next_cursor`).

## The loop

```jsonc
// 1. Grant the agent a reversible capability
// set_autopilot_config
> { "agentId": "…", "enabled": true, "scopes": { "create_alert": true } }
{ "ok": true, "config": { "enabled": true, "scopes": { "create_alert": true, "briefing": false, "wallet_transfer": false }, "daily_spend_sol": 0, "require_confirm": true } }

// 2. Let the agent propose actions from its memory
// generate_proposals
> { "agentId": "…" }
{ "ok": true, "createdCount": 1, "source": "memory",
  "created": [ { "id": "p_…", "kind": "create_alert", "title": "Alert when $THREE crosses $0.01",
                 "rationale": "You noted interest in $THREE around $0.01 — I'll watch it.", "status": "pending" } ] }

// 3. Preview before acting
// dryrun_proposal
> { "agentId": "…", "proposalId": "p_…" }
{ "ok": true, "preview": { "kind": "create_alert", "willDo": "Create a real alert rule… Reversible.",
                           "checks": [ { "label": "Scope \"create_alert\" granted", "ok": true } ], "blocked": false } }

// 4. Execute for real (reversible kind — no confirm needed)
// execute_proposal
> { "agentId": "…", "proposalId": "p_…" }
{ "ok": true, "receipt": "Created a price above alert.", "actionId": "1843", "proposal": { "status": "executed" } }

// 5. Changed your mind? Undo it.
// undo_action
> { "agentId": "…", "proposalId": "p_…" }
{ "ok": true, "proposal": { "status": "undone" } }
```

Spending real SOL requires the owner to have granted `scopes.wallet_transfer`, set a positive `dailySpendSol`, and (unless pre-authorized) `execute_proposal` must be re-issued with `confirm:true`. All three are checked server-side. The agent spends SOL only — it never sells or sends $THREE.

## Requirements

- **Node.js >= 20.**
- A three.ws credential (`THREE_WS_API_KEY`) for the agent owner.
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable              | Required | Default            | Notes                                                            |
| --------------------- | -------- | ------------------ | ---------------------------------------------------------------- |
| `THREE_WS_API_KEY`    | **yes**  | —                  | three.ws API key (`sk_live_…`) or OAuth access token. Secret. Can move real SOL. |
| `THREE_WS_BASE`       | no       | `https://three.ws` | Override only when self-hosting or targeting a preview.          |
| `THREE_WS_TIMEOUT_MS` | no       | `60000`            | Per-request timeout (generation runs a server-side LLM pass).    |

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
