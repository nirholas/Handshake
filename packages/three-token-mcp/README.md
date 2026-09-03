<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/three-token-mcp</h1>

<p align="center"><strong>The first MCP server whose actions burn a token — let any AI agent price, hold, and burn $THREE on Solana.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/three-token-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/three-token-mcp?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/three-token-mcp"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/three-token-mcp?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/three-token-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/three-token-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#requirements">Requirements</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI assistant three $THREE primitives over stdio: read the live USD price, read a wallet's balance, and **burn $THREE on-chain** — split between the incinerator and the three.ws treasury, priced live via Jupiter. Deflation as an agent primitive: every `three_burn` call is a real, verifiable Solana transaction that permanently removes $THREE from supply and funds the treasury.

$THREE is the only coin this server touches. Contract address (mainnet SPL): `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`.

## Why this is different

Most paid MCP servers settle in USDC. This one moves the project's own token, and the destinations are not hardcoded — they're read at runtime from the **public** three.ws token surface (`/api/token/config`, `/api/token/price`), so the mint, decimals, burn address, treasury, and split always track the canonical on-chain config the rest of three.ws uses. Before signing, the resolved mint is asserted to equal the canonical $THREE address above — a misconfigured or compromised endpoint cannot redirect a burn to any other token.

## Install

```bash
npm install @three-ws/three-token-mcp
```

Run it directly with `npx` (no install needed):

```bash
SOLANA_SECRET_KEY=<base58> npx @three-ws/three-token-mcp
```

Or install globally for the `three-token-mcp` binary on your `PATH`:

```bash
npm install -g @three-ws/three-token-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add three-token -- npx -y @three-ws/three-token-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"three-token": {
			"command": "npx",
			"args": ["-y", "@three-ws/three-token-mcp"],
			"env": {
				"SOLANA_SECRET_KEY": "<base58 secret of the wallet that holds $THREE>",
				"SOLANA_RPC_URL": "https://your-rpc-provider"
			}
		}
	}
}
```

`SOLANA_SECRET_KEY` is only required for `three_burn`. The read-only tools (`three_price`, `three_balance`) work without it. Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/three-token-mcp
```

## Tools

| Tool            | Type          | What it does                                                                                                                                |
| --------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `three_price`   | read-only     | Live USD price of $THREE (Jupiter primary, Birdeye fallback). Pass `usd` to also get the token-amount quote.                                |
| `three_balance` | read-only     | $THREE + SOL balance for any pubkey (defaults to the configured signer).                                                                    |
| `three_burn`    | **execution** | Burn a USD-denominated amount of $THREE in one Solana tx, split incinerator/treasury. Returns the signature, breakdown, and a Solscan link. |

`three_burn` burns $THREE the wallet **already holds**. To acquire $THREE first, swap SOL → $THREE on any Solana DEX, then burn.

### Safety

All three tools ship [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations): `three_price` and `three_balance` advertise `readOnlyHint: true` and can be safely auto-approved; `three_burn` is flagged `destructiveHint: true`, so annotation-aware MCP clients (Claude Code, Claude Desktop, Cursor) prompt for confirmation before running it. The hints are advisory — server-side, every burn is still bounded by `MAX_BURN_USD` (default $100), gated by `REQUIRE_CONFIRM` (default on: the call refuses until re-issued with `confirm: true`), and the resolved mint is asserted to be canonical $THREE before signing, independent of the client.

### Input parameters

**`three_price`** — `usd` (optional positive number: USD amount to quote into $THREE).

**`three_balance`** — `pubkey` (optional base58, 32–64 chars; defaults to the configured signer's address).

**`three_burn`** — `usd` (required positive number: USD value of $THREE to burn), `burnBps` (0–10000, default 5000 = 50% burn / 50% treasury; 10000 = burn everything), `memo` (optional, ≤120 chars; appended to the on-chain memo), `secret` (optional base58 signer override; defaults to `SOLANA_SECRET_KEY`), `confirm` (must be `true` to execute the irreversible burn when `REQUIRE_CONFIRM` is on).

## Example

```jsonc
// three_price
> { "usd": 5 }
{ "price_usd": 0.0042, "quote": { "usd": 5, "token_amount": 1190.47, "atomics": "1190476190" } }

// three_burn — irreversible; confirm:true required by default
> { "usd": 5, "burnBps": 5000, "confirm": true }
{
  "ok": true,
  "signature": "5x...",
  "explorer": "https://solscan.io/tx/5x...",
  "usd": 5,
  "burned": 595.23,
  "legs": [
    { "role": "burn", "amount": 595.23 },
    { "role": "treasury", "amount": 595.23 }
  ]
}
```

## How a burn is built

`three_burn` mirrors the proven three.ws browser payment flow:

1. `GET /api/token/config` → mint, decimals, burn address, treasury.
2. `GET /api/token/price?usd=<n>` → live Jupiter price and the exact $THREE atomics.
3. Build **one** transaction: an idempotent ATA-create + SPL transfer per leg (burn + treasury), plus a memo tagging the burn on-chain. An amount that will not divide evenly at `burnBps` gives the leftover atomic unit to the **burn** leg, so a burn is never short of its share; with `burnBps: 10000` (or a config with no treasury) there is one leg and everything is destroyed.
4. Sign with your wallet, send, and confirm. The result reports the on-chain signature and per-leg amounts.

The server pre-checks your $THREE balance and fails fast with a clear error if it can't cover the burn — no opaque on-chain failures. Burns are bounded by `MAX_BURN_USD` (default $100) and gated by `REQUIRE_CONFIRM` (default on).

## Requirements

- **Node.js >= 20.**
- A Solana mainnet RPC endpoint (the public cluster works for read-only; bring your own — Helius / Quicknode / Triton — for burn traffic). The endpoint must be `https` (only `http://localhost` is accepted, for local dev validators).
- For burns: a wallet holding $THREE, provided as a base58 `SOLANA_SECRET_KEY` (or a per-call `secret`).

### Environment variables

| Variable             | Required       | Default                                           |
| -------------------- | -------------- | ------------------------------------------------- |
| `SOLANA_SECRET_KEY`  | for burns only | none (`FUNDER_SECRET` is accepted as a fallback)   |
| `SOLANA_RPC_URL`     | no             | `https://api.mainnet-beta.solana.com`             |
| `THREE_WS_BASE`      | no             | `https://three.ws`                                |
| `MAX_BURN_USD`       | no             | `100`                                             |
| `REQUIRE_CONFIRM`    | no             | `true` (set `0`/`false` to skip the confirm gate) |
| `THREE_BURN_ADDRESS` | no             | the Solana incinerator                            |

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
