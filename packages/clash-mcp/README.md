<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/clash-mcp</h1>

<p align="center"><strong>Play three.ws Coin Clash — the community faction war backed by real holdings + pump.fun data — from any AI agent. Read the live battle board, enlist your wallet, and rally power for a faction.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/clash-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/clash-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/clash-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/clash-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that puts **Coin Clash** — three.ws's community faction war — in reach of any AI agent over stdio. Every community is a faction, its holders are its army; two factions are matched each round, and whichever army rallies more power before the clock runs out wins. Read the live board and leaderboard, then **enlist** (prove you hold the coin) and **rally** for your side.

Reads are public — point `THREE_WS_BASE` at a deployment and go. Writes are wallet-scoped: enlisting signs a challenge with your Solana key and the backend confirms a **live on-chain holding** of the faction coin before issuing a war pass. Factions, members, and momentum come from CoinCommunities + pump.fun; rally power is persisted and ranked server-side. Nothing is mocked.

## Install

```bash
npm install @three-ws/clash-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/clash-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add clash -- npx -y @three-ws/clash-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"clash": {
			"command": "npx",
			"args": ["-y", "@three-ws/clash-mcp"],
			"env": {
				"SOLANA_SECRET_KEY": "<base58 secret of your enlisting wallet — only needed for writes>"
			}
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/clash-mcp
```

## Tools

| Tool                    | Type      | What it does                                                                                                       |
| ----------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `get_clash_state`       | read-only | The live battle board: matchups, each army's power + momentum, the round clock, the tug-of-war share, who's leading. |
| `get_clash_leaderboard` | read-only | All-time faction war records (W/L/D, win rate, power), optionally a single faction's top soldiers this round.       |
| `enlist_faction`        | write     | Prove the signer's wallet holds a faction coin (Solana-signed) and get a war pass.                                  |
| `rally_faction`         | write     | Spend taps as battle power for your faction — pass a war pass, or a token to auto-enlist and rally in one call.      |

The reads return live data — power and standings move between calls, so neither is idempotent. The writes are wallet-scoped: no funds ever move (a war pass is a signed proof, not a transaction), so neither is destructive. `enlist_faction` is idempotent (re-enlisting mints an equivalent pass); `rally_faction` is not (each call appends power).

### Input parameters

**`get_clash_state`** — none.

**`get_clash_leaderboard`** — `faction` (optional mint; also returns that faction's top soldiers this round).

**`enlist_faction`** — `token` (required faction mint), `secret` (optional base58 Solana secret; falls back to `SOLANA_SECRET_KEY`).

**`rally_faction`** — `taps` (required, 1–50), and either `pass` (a war pass from `enlist_faction`) **or** `token` (+ optional `secret`) to auto-enlist first.

## How a battle works

1. **Scout.** `get_clash_state` shows the current round: who's matched, each army's power, momentum, and `msLeft`.
2. **Enlist.** `enlist_faction` issues a challenge bound to your wallet + faction, signs it with your Solana key, and the backend verifies the signature **and** a live on-chain holding of the coin. You get back a `warPass`. (No holding → `eligible:false`, `reason:"not_a_holder"`.)
3. **Rally.** `rally_faction` spends `taps` (1–50 per call) from the pass as battle power — multiplied by the faction's live momentum, capped per wallet per round. Call it repeatedly while `msLeft > 0`.
4. **Win.** When the round clock hits zero, the army with more power takes the battle and the result is written to each faction's all-time war record (`get_clash_leaderboard`).

## Example

```jsonc
// get_clash_state
> {}
{
  "ok": true,
  "epoch": 486231,
  "epochMs": 3600000,
  "endsAt": 1750000000000,
  "msLeft": 1843000,
  "factionCount": 16,
  "arena": [
    {
      "id": "486231:…",
      // each side also carries image, posts, and priceUsd (elided here)
      "a": { "token": "…", "symbol": "ALPHA", "members": 8200, "momentum": 1.31, "power": 940, "record": { "w": 12, "l": 4, "d": 1, "battles": 17, "power": 8100 } },
      "b": { "token": "…", "symbol": "BETA",  "members": 5100, "momentum": 1.12, "power": 610, "record": { "w": 7,  "l": 9, "d": 0, "battles": 16, "power": 5400 } },
      "aShare": 0.61,
      "leader": "…ALPHA mint…"
    }
  ],
  "bye": null
}
```

```jsonc
// rally_faction — auto-enlist + rally in one call (wallet must hold the coin)
> { "token": "…faction mint…", "taps": 50 }
{
  "ok": true,
  "enlisted": { "wallet": "…", "amount": 1250000, "usd": 84.20 },
  "epoch": 486231,
  "mint": "…faction mint…",
  "added": 66,
  "momentum": 1.31,
  "walletPower": 66,
  "walletCap": 5000,
  "capped": false,
  "factionPower": 1005,
  "msLeft": 1841000
}
```

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).
- For writes only: a base58 Solana secret whose wallet **holds the faction coin** it enlists for, via `SOLANA_SECRET_KEY` or the per-call `secret` arg.

### Environment variables

| Variable              | Required           | Default            | Notes                                                                 |
| --------------------- | ------------------ | ------------------ | --------------------------------------------------------------------- |
| `THREE_WS_BASE`       | no                 | `https://three.ws` | API deployment to talk to.                                            |
| `THREE_WS_TIMEOUT_MS` | no                 | `20000`            | Per-request timeout.                                                  |
| `SOLANA_SECRET_KEY`   | writes only        | —                  | Base58 secret of the enlisting wallet. Per-call `secret` overrides it. **Treat like cash.** |
| `CLASH_SOLANA_SECRET` | no                 | —                  | Fallback signer read when `SOLANA_SECRET_KEY` is unset, for hosts that scope env vars per server. Same format and the same care. |

> The `secret` is only ever used to sign the enlist challenge locally — a detached ed25519 signature over the challenge text. It never signs a transaction and no funds move. Still, it controls a wallet: prefer a per-call `secret` or a dedicated env on a machine you trust.

## Errors

A failed tool call returns an MCP error result (`isError: true`) whose text is a single JSON object: `{ "ok": false, "error": "<code>", "message": "…" }`, plus `status` on upstream rejections and `detail` where the failure carries context (e.g. which wallet was not a holder):

| `error` | Meaning | Recovery |
| ------- | ------- | -------- |
| `validation_error` | Bad arguments: a missing faction `token`, or `rally_faction` called with neither a `pass` nor a `token`. | Fix the call. |
| `no_signer` / `invalid_secret` | A write tool had no Solana key, or the key was not a base58 64-byte secret. | Pass `secret` or set `SOLANA_SECRET_KEY`. |
| `not_eligible` | The auto-enlisting wallet does not hold the faction coin, so no pass was issued. `detail` carries `wallet`, `faction`, and `reason`. | Hold the coin, then retry. |
| `upstream_error` | The API rejected the request. `status` carries the HTTP code; notable bodies include `bad_challenge`, `bad_signature`, `pass_invalid` (expired or foreign war pass), `balance_unavailable` (RPC could not read the holding), and `cc_unconfigured` (the deployment has no CoinCommunities config). | Act on the code; re-enlist on `pass_invalid`. |
| `timeout` | No response within `THREE_WS_TIMEOUT_MS`. | Retry or raise the timeout. |
| `network_error` | The request never reached the API (DNS, offline, TLS). | Check connectivity / `THREE_WS_BASE`. |
| `bad_config` | `THREE_WS_TIMEOUT_MS` is not a positive number (thrown at startup). | Fix the env var. |

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
