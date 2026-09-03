<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/tutor-mcp</h1>

<p align="center"><strong>Manage a Pay-As-You-Learn tutoring session from any AI agent — read its itemized running tab and close it for an attested invoice.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/tutor-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/tutor-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/tutor-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/tutor-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the three.ws **Pay-As-You-Learn tutor ledger** over stdio. Read a tutoring session's itemized tab — one line item per answered question, with per-item cost and a running total — and close the session to seal an attested invoice.

The tutor bills per answered question; **this server's tools are free**. Viewing the running tab and closing the session never charge the learner — a learner must never pay to see what they owe or to end the session. Sessions are addressed by an opaque `sessionId`, so no API key and no signer are required — point `THREE_WS_BASE` at a deployment and go.

## Install

```bash
npm install @three-ws/tutor-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/tutor-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add tutor -- npx -y @three-ws/tutor-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"tutor": {
			"command": "npx",
			"args": ["-y", "@three-ws/tutor-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/tutor-mcp
```

## Tools

| Tool            | Type  | What it does                                                                                                                  |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| `load_session`  | read  | Read a session's itemized running tab by `sessionId` — line items (question, level, tokens, cost), status, and running total. |
| `close_session` | write | Finalize a session and return its attested invoice — seals the ledger with a SHA-256 attestation and locks further billing.    |

Both tools are **free** and move no funds: the per-question answers are the paid action (handled elsewhere). `load_session` reads live data — the tab grows as questions are billed, so it is not idempotent. `close_session` mutates state (open → closed) but is itself idempotent: re-closing returns the same itemized total.

### Input parameters

**`load_session`** — `sessionId` (required, ≤100 chars).

**`close_session`** — `sessionId` (required, ≤100 chars).

## Example

```jsonc
// load_session
> { "sessionId": "learn-abc123" }
{
  "ok": true,
  "sessionId": "learn-abc123",
  "status": "open",
  "createdAt": "2026-06-24T03:40:00.000Z",
  "questionCount": 2,
  "lineItems": [
    { "n": 1, "question": "What is a Solana PDA?", "level": "intro", "outputTokens": 180, "costAtomics": 10000, "costUsd": "0.010000", "at": "2026-06-24T03:41:00.000Z" },
    { "n": 2, "question": "How do CPIs work?", "level": "intro", "outputTokens": 220, "costAtomics": 10000, "costUsd": "0.010000", "at": "2026-06-24T03:42:00.000Z" }
  ],
  "totalAtomics": 20000,
  "totalUsd": "0.020000"
}
```

```jsonc
// close_session
> { "sessionId": "learn-abc123" }
{
  "ok": true,
  "sessionId": "learn-abc123",
  "createdAt": "2026-06-24T03:40:00.000Z",
  "closedAt": "2026-06-24T03:45:00.000Z",
  "questionCount": 2,
  "lineItems": [ /* same itemized line items */ ],
  "totalAtomics": 20000,
  "totalUsd": "0.020000",
  "attestation": "sha256:…"
}
```

A `sessionId` with no stored history returns an empty open session (`questionCount: 0`) rather than an error — an honest "nothing billed yet", not a failure.

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
