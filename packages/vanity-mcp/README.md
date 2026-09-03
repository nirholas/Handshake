<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/vanity-mcp</h1>

<p align="center"><strong>Read the three.ws vanity-address grind-bounty market + rarity gallery from any AI agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/vanity-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/vanity-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/vanity-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/vanity-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI assistant the read/discovery surface of the three.ws **vanity-address grind-bounty market** over stdio. Quote how hard a Solana vanity pattern is and what to escrow for it, appraise the rarity of any address, and browse the live bounty board, claimable queue, stats, leaderboard, config, and the proof-of-grind gallery.

The market is secret-blind: a requester escrows a USDC bounty for a pattern, a fleet of independent workers grinds it in parallel, and the first to submit a verified key matching the pattern is paid on-chain — yet the found secret is sealed to the requester, so the worker earns the bounty without ever seeing the wallet. **Posting a bounty and claiming one are the x402-paid write paths on the HTTP API**; this MCP exposes the read/discovery + rarity surface. No API key, no signer, no payment — every call hits the public `/api/vanity` endpoints.

## Install

```bash
npm install @three-ws/vanity-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/vanity-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add vanity -- npx -y @three-ws/vanity-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"vanity": {
			"command": "npx",
			"args": ["-y", "@three-ws/vanity-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/vanity-mcp
```

## Tools

| Tool                 | Type      | What it does                                                                                          |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `vanity_quote`       | read-only | Price a pattern: expected attempts, rarity tier, and an honest suggested USDC bounty. Idempotent.     |
| `vanity_appraise`    | read-only | Appraise any Solana address's rarity (pattern, score, bits, tier, attempts). Idempotent.             |
| `vanity_board`       | read-only | Browse the grind-bounty board — filter by status, sort by recency/reward/expiry, paginate.            |
| `vanity_open`        | read-only | List the claimable open-bounty queue workers poll.                                                    |
| `vanity_stats`       | read-only | Live market totals: open count, USDC escrowed, USDC paid out.                                         |
| `vanity_leaderboard` | read-only | Top grinders ranked by total USDC earned.                                                             |
| `vanity_config`      | read-only | Payout availability + asset/network metadata (settlement asset, decimals, networks, pricing band).   |
| `vanity_gallery`     | read-only | Browse the proof-of-grind rarity gallery — sort, filter by tier/length/substring, paginate.           |

`vanity_quote` and `vanity_appraise` are pure functions of their input (same pattern/address → same result), so they're marked idempotent. The other six read the live market and gallery.

### Input parameters

**`vanity_quote`** — `prefix` (optional Base58 prefix), `suffix` (optional Base58 suffix), `ignoreCase` (bool, default false). At least one of prefix/suffix is required.

**`vanity_appraise`** — `address` (required, Base58 32–44 chars), `prefixLen` (int, optional), `suffixLen` (int, optional).

**`vanity_board`** — `status` (`open` | `all` | `settled`, default `open`), `sort` (`recency` | `reward` | `expiry`, default `recency`), `limit` (1–100, default 24), `offset` (default 0).

**`vanity_open`** — `limit` (1–100, default 30).

**`vanity_stats`** — no params.

**`vanity_leaderboard`** — `limit` (1–100, default 10).

**`vanity_config`** — no params.

**`vanity_gallery`** — `sort` (`score` | `recency`, default `score`), `tier` (string), `minLength` (int), `contains` (string), `limit` (1–100, default 24), `offset` (default 0).

## Example

```jsonc
// vanity_quote
> { "prefix": "THREE" }
{
  "ok": true,
  "pattern": { "prefix": "THREE", "suffix": null, "ignoreCase": false },
  "difficulty": {
    "expectedAttempts": 11308763834,
    "rarityBits": 39,
    "tier": "mythic",
    "tierLabel": "Mythic",
    "accent": "#ff5db1",
    "expectedGrindSeconds": 7539
  },
  "oracle": {
    "floorAtomics": 50000,
    "suggestedAtomics": 2094216,
    "generousAtomics": 5235540,
    "maxAtomics": 5000000000,
    "expectedAttempts": 11308763834,
    "expectedGrindSeconds": 7539,
    "model": "58^effectiveLength @ refRate"
  },
  "band": { "floorAtomics": 50000, "maxAtomics": 5000000000, "decimals": 6, "asset": "USDC" }
}
```

## Examples

Runnable examples live in [`examples/`](./examples):

```bash
node examples/list-tools.mjs           # every tool with its full input schema
node examples/quote-and-appraise.mjs   # config + quote + appraise + stats, live
```

Both spawn this server over stdio and read the live market. Every tool here is
read-only, so nothing can be posted, claimed, or paid. See
[`examples/README.md`](./examples/README.md) for expected output.

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
