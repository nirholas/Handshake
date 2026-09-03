<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/provenance-mcp</h1>

<p align="center"><strong>The agent action-provenance log over MCP — append-only, ERC-191-signed, on-chain-verifiable. Record what an agent did, and audit another agent's trail, from any AI assistant.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/provenance-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/provenance-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/provenance-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/provenance-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server for the three.ws **agent trust layer**. Every action an agent takes is written to an append-only ledger — optionally signed with the agent's EVM wallet (ERC-191), so its authorship is provable, not just claimed. This server lets one agent record its own actions and lets any agent read and **cryptographically verify** another agent's provenance trail.

Why it matters: a forked, purchased, or delegated agent is only trustworthy if its history is provable. `provenance-mcp` turns "the agent says it did X" into "the agent **signed** that it did X, and anyone can `ecrecover` the signer to confirm." The ledger is immutable — records are never edited or deleted.

## Install

```bash
npm install @three-ws/provenance-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/provenance-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add provenance --env THREE_WS_TOKEN=sk_live_… -- npx -y @three-ws/provenance-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"provenance": {
			"command": "npx",
			"args": ["-y", "@three-ws/provenance-mcp"],
			"env": {
				"THREE_WS_TOKEN": "sk_live_…",
				"THREE_WS_SIGNER_KEY": "0x…"
			}
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
THREE_WS_TOKEN=sk_live_… npx -y @modelcontextprotocol/inspector npx @three-ws/provenance-mcp
```

## Tools

| Tool                   | Type      | What it does                                                                                                          |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `list_agent_actions`   | read-only | Read an agent's action trail, newest-first, cursor-paginated. Each record is signature-checked inline.                |
| `query_action`         | read-only | Fetch one action by id and recover its signer — proof the named agent authored that exact action, untampered.         |
| `append_agent_action`  | **write** | ERC-191-sign a new action and append it to the immutable ledger. Never overwrites or deletes.                         |

`append_agent_action` is the only write tool. It **appends** to an append-only ledger: every call records a new, permanent record (so it is not idempotent — don't retry blindly), and nothing is ever overwritten or removed (so it is not destructive).

### Input parameters

**`list_agent_actions`**: `agent_id` (required, the agent identity's uuid), `limit` (1 to 200, default 50), `cursor` (numeric, from a previous `next_cursor`).

**`query_action`**: `agent_id` (required, the agent identity's uuid), `id` (required, numeric action id).

**`append_agent_action`**: `agent_id` (required, the agent identity's uuid), `type` (required, ≤64 chars), `payload` (object, optional), `source_skill` (optional), `signer_key` (optional 0x EVM key, overrides `THREE_WS_SIGNER_KEY` for this call).

## How signing & verification work

When you append an action with a signer key configured, the server:

1. Builds a **canonical** form of the action — `{ v, agentId, type, payload, sourceSkill }` with recursively sorted keys, so the same logical action always produces the same bytes.
2. SHA-256 digests it and frames the digest as `threews:action:v1:<digest>` (domain-separated, so an action signature can never be replayed as some other three.ws message).
3. ERC-191 `personal_sign`s that string with the agent's EVM key and sends the resulting `signature` + `signer_address` alongside the action.

`list_agent_actions` and `query_action` reverse this offline: they recompute the digest from the stored record and `ecrecover` the signer. A `verification.reason` of `ok` means the signature recovers to the claimed address — cryptographic proof of authorship and integrity. `signer_mismatch` means the record does not verify (tampering, or a foreign signing scheme) and must not be trusted; `unsigned` means no signature was attached.

This is the same primitive three.ws uses server-side for its Portable & Verifiable Brain — verification needs nothing but the public record and the agent's address.

## Example

```jsonc
// append_agent_action
> { "agent_id": "6a7d0f2c-1b3e-4a55-9c88-2d41b0f7e913", "type": "launch", "payload": { "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump", "name": "$THREE" }, "source_skill": "pump-launch" }
{
  "ok": true,
  "action": {
    "id": "10482",
    "agent_id": "6a7d0f2c-1b3e-4a55-9c88-2d41b0f7e913",
    "type": "launch",
    "payload": { "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump", "name": "$THREE" },
    "source_skill": "pump-launch",
    "signature": "0x…",
    "signer_address": "0xAbC…",
    "created_at": "2026-06-24T18:20:00.000Z"
  },
  "signing": { "signed": true, "signer_address": "0xAbC…", "digest": "…" }
}
```

```jsonc
// query_action  →  verify it independently
> { "agent_id": "6a7d0f2c-1b3e-4a55-9c88-2d41b0f7e913", "id": "10482" }
{
  "ok": true,
  "action": { "id": "10482", "type": "launch", "signature": "0x…", "signer_address": "0xAbC…", /* … */ },
  "verification": { "signed": true, "valid": true, "reason": "ok", "recovered": "0xAbC…", "digest": "…" }
}
```

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).
- A `THREE_WS_TOKEN` — a three.ws API key (`sk_live_…`) or OAuth access token. The ledger authenticates every call and is **owner-scoped**: you can read and append actions only for agents your token owns.

### Environment variables

| Variable              | Required | Default            | Purpose                                                                                             |
| --------------------- | -------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `THREE_WS_TOKEN`      | **yes**  | —                  | Bearer token authenticating every call (API key or OAuth access token). Treat like a password.       |
| `THREE_WS_SIGNER_KEY` | no       | —                  | 0x EVM private key — when set, `append_agent_action` ERC-191-signs each action. Treat like cash.      |
| `THREE_WS_BASE`       | no       | `https://three.ws` | API base URL — override for self-hosting or a preview deployment.                                    |
| `THREE_WS_TIMEOUT_MS` | no       | `20000`            | Per-request timeout in milliseconds.                                                                 |

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0. See [LICENSE](./LICENSE).

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
