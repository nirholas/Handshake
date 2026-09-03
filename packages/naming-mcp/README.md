<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/naming-mcp</h1>

<p align="center"><strong>The on-chain identity layer for AI agents — resolve .sol names and claim your agent a name on three.ws.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/naming-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/naming-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/naming-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/naming-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI assistant the three.ws **naming / identity** layer over stdio. Resolve a Solana `.sol` name to the wallet that owns it, reverse-lookup a wallet to its primary name, and check whether a `*.threews.sol` agent handle is still free to claim.

This is the three.ws identity layer: where avatars give your agent a *face* and scenes give it a *world*, names give it an *identity*. A `*.threews.sol` subdomain showcases an agent profile at `https://three.ws/u/<label>` — claiming one gives your agent a name. No API key, no signer, no payment — every call hits the public `/api/sns` and `/api/threews/subdomain` endpoints, backed by Solana / Bonfida SNS (mainnet).

> **Note:** minting a `*.threews.sol` subdomain is the **authenticated write path** on the three.ws HTTP API. This MCP server exposes the public **resolution + availability** reads; once you find a free handle, claim it from your three.ws account.

## Install

```bash
npm install @three-ws/naming-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/naming-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add naming -- npx -y @three-ws/naming-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"naming": {
			"command": "npx",
			"args": ["-y", "@three-ws/naming-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/naming-mcp
```

## Tools

| Tool                   | Type      | What it does                                                                                  |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `sns_resolve`          | read-only | Resolve a `.sol` name → the base58 wallet that owns it.                                       |
| `sns_reverse`          | read-only | Reverse-lookup a wallet → its primary `.sol` name.                                            |
| `threews_availability` | read-only | Check whether `<label>.threews.sol` is free to claim as a three.ws agent identity.            |

All three are live public reads against Solana mainnet. A `.sol` name with no owner (or a wallet with no favorite name) returns `resolved: false` — a routine, expected answer, not an error.

### Input parameters

**`sns_resolve`** — `name` (required: a `.sol` label, subdomain, or full name with or without the trailing `.sol`).

**`sns_reverse`** — `address` (required: a base58 Solana public key).

**`threews_availability`** — `label` (required: the handle to check, e.g. `nick` for `nick.threews.sol`; 1–63 chars of `[a-z0-9-]`).

## Example

```jsonc
// sns_resolve
> { "name": "bonfida" }
{
  "ok": true,
  "name": "bonfida.sol",
  "address": "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v",
  "resolved": true
}

// threews_availability
> { "label": "test" }
{
  "ok": true,
  "full": "test.threews.sol",
  "label": "test",
  "available": true,
  "owner": null,
  "on_chain_check": "ok",
  "showcase_url": null
}
```

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
- License: Apache-2.0. See [LICENSE](./LICENSE).

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
