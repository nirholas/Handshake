<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/x402-mcp</h1>

<p align="center"><strong>Give any AI agent a self-custodial x402 wallet — discover, inspect, and pay any paid service in USDC from your own Solana key.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/x402-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/x402-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/x402-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/x402-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that turns any AI assistant into an autonomous economic agent on the [x402](https://x402.org) network. Search the live bazaar for paid services, read an endpoint's price **before** committing money, and `pay_and_call` any x402 service in USDC — settled on Solana with **your own key**, never a custodial wallet.

This is the *buyer* side of the three.ws agent economy. The payment dance and Solana `exact`-scheme signing are handled by the real `@x402/*` libraries — nothing is mocked.

## Install

```bash
npm install @three-ws/x402-mcp
```

Or run with `npx`:

```bash
SOLANA_SECRET_KEY=<base58> npx @three-ws/x402-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add x402 --env SOLANA_SECRET_KEY=<base58> -- npx -y @three-ws/x402-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"x402": {
			"command": "npx",
			"args": ["-y", "@three-ws/x402-mcp"],
			"env": {
				"SOLANA_SECRET_KEY": "<base58 secret of the wallet that holds USDC>",
				"SOLANA_RPC_URL": "https://your-rpc-provider",
				"MAX_PAY_USD": "1"
			}
		}
	}
}
```

`SOLANA_SECRET_KEY` is only needed to **spend** (`pay_and_call`, and `x402_wallet` defaulting to your wallet). `find_services` and `inspect_endpoint` work with no key.

## Tools

| Tool               | Type          | What it does                                                                                              |
| ------------------ | ------------- | -------------------------------------------------------------------------------------------------------- |
| `x402_wallet`      | read-only     | A wallet's address + live SOL/USDC balance. Defaults to your signer wallet — confirm funds before paying. |
| `find_services`    | read-only     | Search the live x402 bazaar (PayAI + Coinbase CDP) for paid HTTP/MCP services with prices.                |
| `inspect_endpoint` | read-only     | Read any endpoint's 402 payment requirements (scheme, network, asset, price, pay-to) **without paying**.  |
| `pay_and_call`     | **execution** | Pay an x402 endpoint in USDC from your Solana key and return its result. Bounded by `MAX_PAY_USD`.        |

### Safety

`pay_and_call` carries `destructiveHint: true`, so annotation-aware clients (Claude Code, Claude Desktop, Cursor) prompt before running it. Beyond the client hint, every payment is bounded server-side: it **probes the 402 first** and refuses if the price exceeds `max_usd` or `MAX_PAY_USD` (default $1) **before any money moves**, and with `REQUIRE_CONFIRM` on (default) the call refuses until re-issued with `confirm: true`. Only the Solana (`solana:*`) `exact`-scheme requirement is settled — with the key you control.

### Input parameters

**`x402_wallet`** — `address` (optional base58; defaults to the signer wallet).

**`find_services`** — `query` (required), `type` (`http` | `mcp`, default `http`), `network` (CAIP-2 filter), `max_price_usdc`, `limit` (1–100).

**`inspect_endpoint`** — `url` (required), `method` (`GET` | `POST`), `body` (object).

**`pay_and_call`**: `url` (required), `method` (`GET` | `POST`), `body` (object), `max_usd` (lowers the cap for this call), `secret` (per-call signer override), `confirm` (must be `true` when `REQUIRE_CONFIRM` is on), `session_token`, `token`, `idempotency_key`.

It has two settlement modes:

- **Self-custodial (default).** Signs with `SOLANA_SECRET_KEY`, or the per-call `secret`. You hold the key.
- **Session-governed.** Pass `session_token`, a [three.ws Payment Session](../../docs/payment-sessions.md) token, and the platform wallet signs on your behalf while enforcing that session's budget, host allowlist, and per-transaction cap. No private key needed. Solana USDC and Base USDC sessions are both supported, and `secret` and `token` are ignored in this mode.

`token` selects the settlement asset: `usdc` (default), or `three` for the $THREE platform token when the endpoint advertises it. `idempotency_key` deduplicates a call, which is recommended with `session_token` so a retry cannot double-charge.

## Example

```jsonc
// inspect_endpoint — what does it cost? (no payment)
> { "url": "https://three.ws/api/x402/vanity?prefix=ab" }
{
  "ok": true, "paid": true,
  "accepts": [
    { "scheme": "exact", "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "asset": "EPjFW…", "price": 50000 }
  ],
  "payable_with_this_wallet": true
}

// pay_and_call — confirm:true required by default
> { "url": "https://three.ws/api/x402/vanity?prefix=ab", "confirm": true }
{ "ok": true, "paid": true, "payer": "Gx5E…", "price_usd": 0.05, "settlement": { … }, "result": { … } }
```

## Examples

Runnable, no-payment examples live in [`examples/`](./examples):

```bash
node examples/list-tools.mjs      # every tool with its full input schema
node examples/inspect-price.mjs   # find_services + inspect_endpoint on live data
```

Both spawn this server over stdio and hit the real bazaar. Neither reads a key or
calls `pay_and_call`, so nothing is signed and nothing is spent. See
[`examples/README.md`](./examples/README.md) for expected output.

## Requirements

- **Node.js >= 20.**
- A Solana mainnet RPC endpoint (`https`; only `http://localhost` is allowed for dev). Public cluster works for reads; bring your own for payment traffic.
- To pay: a Solana wallet holding USDC, as a base58 `SOLANA_SECRET_KEY` (or per-call `secret`).

### Environment variables

| Variable            | Required     | Default                               |
| ------------------- | ------------ | ------------------------------------- |
| `SOLANA_SECRET_KEY` | to pay only  | —                                     |
| `SOLANA_RPC_URL`    | no           | `https://api.mainnet-beta.solana.com` |
| `MAX_PAY_USD`       | no           | `1`                                   |
| `REQUIRE_CONFIRM`   | no           | `true`                                |
| `THREE_WS_BASE`     | no           | `https://three.ws`                    |

## Links

- Homepage: https://three.ws
- MCP catalog: https://three.ws/docs/mcp
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
