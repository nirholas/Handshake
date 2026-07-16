<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/mcp-bridge</h1>

<p align="center"><strong>One MCP server that can pay any x402-paid endpoint on the open web — the universal x402 payer for AI agents.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/mcp-bridge"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/mcp-bridge?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/mcp-bridge"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/mcp-bridge?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/mcp-bridge?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/mcp-bridge?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#security-and-spending-controls">Security</a> ·
  <a href="#what-it-exposes">Tools</a> ·
  <a href="#environment">Environment</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that can pay any x402-paid endpoint on the open web. Point your agent at a URL that answers `402 Payment Required`; the bridge signs, pays, retries, and hands back the response plus the settlement receipt — EVM exact, EVM batch-settlement, and Solana exact, all behind hard spending caps. It also pre-loads a tool per service discovered on the [Coinbase x402 Bazaar](https://docs.cdp.coinbase.com/x402/docs/welcome), so the entire paid-API economy shows up in your tool list.

## Quick start

Claude Code:

```bash
claude mcp add x402-bridge -e MCP_BRIDGE_SVM_PRIVATE_KEY=... -- npx -y @three-ws/mcp-bridge
```

Use `-e MCP_BRIDGE_EVM_PRIVATE_KEY=0x...` instead (or as well) to pay on Base and other EVM chains. At least one key is required.

Claude Desktop (`claude_desktop_config.json`) or Cursor (`~/.cursor/mcp.json`):

```json
{
	"mcpServers": {
		"x402-bridge": {
			"command": "npx",
			"args": ["-y", "@three-ws/mcp-bridge"],
			"env": {
				"MCP_BRIDGE_EVM_PRIVATE_KEY": "0x…buyer key…",
				"MCP_BRIDGE_SVM_PRIVATE_KEY": "…base58 64-byte secret key…",
				"MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC": "100000",
				"MCP_BRIDGE_DISCOVER_LIMIT": "20"
			}
		}
	}
}
```

Restart the client and ask for something like "pay $0.01 on Base for a weather report" — the model picks a matching Bazaar tool (or `call_paid_endpoint`), and the bridge auto-pays via x402.

## Security and spending controls

**This server holds private keys and spends real USDC.** Read this section before configuring it.

- **Use a dedicated, low-balance wallet.** `MCP_BRIDGE_EVM_PRIVATE_KEY` / `MCP_BRIDGE_SVM_PRIVATE_KEY` should never be a main wallet. Fund it with only what you are willing to let an agent spend.
- **Per-call cap.** Any payment above `MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC` (default `100000` = $0.10 USDC) is refused before a payload is signed, with an error naming the network, asset, and cap.
- **Session ceiling.** Cumulative spend per process is capped by `MCP_BRIDGE_MAX_TOTAL_ATOMIC` (default `1000000` = $1.00 USDC). This bounds the damage of a looping or prompt-injected agent: once the ceiling is reached, every further payment aborts until restart. The accumulator reserves atomically, so concurrent calls cannot jointly overshoot it.
- **Payee allowlist.** Set `MCP_BRIDGE_ALLOWED_PAYTO` (comma-separated addresses) to refuse payment to any recipient you have not explicitly trusted.
- **SSRF guard.** Every outbound payable URL — whether supplied by the model or by a Bazaar listing — passes one chokepoint that enforces an https-only scheme policy, resolves the hostname, and rejects the request if **any** resolved address is private, loopback, link-local (including `169.254.169.254` cloud metadata), CGNAT, ULA, or unspecified. Literal-IP hosts are checked directly; redirects are never followed (a public host cannot 3xx the bridge into internal infrastructure). `http://` is available only behind the explicit `MCP_BRIDGE_ALLOW_HTTP=1` dev opt-in.
- **Host allowlist.** Set `MCP_BRIDGE_ALLOWED_HOSTS` (comma-separated hostnames) for strict mode: only listed hosts can be paid at all.
- **Deposit caps.** Batch-settlement channel deposits are bounded by `MCP_BRIDGE_MAX_DEPOSIT_ATOMIC` (default $5.00) regardless of what a server requests.
- **Honest annotations.** Every paying tool is annotated `readOnlyHint: false`, `idempotentHint: false`, `openWorldHint: true`, so MCP hosts apply their strictest confirmation policy. Retrying a paid call is a new charge.

## What it exposes

On startup the bridge registers:

| Tool                 | What it does                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `call_paid_endpoint` | Universal fallback: hit any URL, auto-pay if it returns 402. Returns the response + parsed settlement.       |
| `list_bazaar_tools`  | Returns the cached list of Bazaar-discovered tools (name, resource, accepted payment terms). Free.           |
| `refresh_bazaar`     | Re-queries the x402 Bazaar and re-registers dynamic tools without restarting. Free.                          |
| `paid_<derived>` …   | One tool per discovered Bazaar resource (up to `MCP_BRIDGE_DISCOVER_LIMIT`), with that endpoint's schema.    |

Tools whose prices all exceed the per-call cap are filtered out at discovery time, so the model never sees a tool it cannot afford.

### Tool annotations

Every tool carries MCP `ToolAnnotations` so hosts can apply the right confirmation policy:

- `call_paid_endpoint` and every dynamic `paid_*` tool: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`. **These spend real USDC** — each call settles a payment (capped by `MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC`), and retrying is a new charge. They never delete or overwrite caller state, hence not destructive.
- `list_bazaar_tools`: `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`. Pure in-process cache read; free, no network.
- `refresh_bazaar`: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`. Free (no payment), but it mutates the registered tool set from the live Bazaar feed, so repeat calls can differ.

Tool results that are plain objects are returned as both a JSON `text` block (backward compatible) and `structuredContent` for typed clients.

### Payment schemes

Payment paths registered on the buyer client:

- `eip155:*` → `BatchSettlementEvmScheme` (preferred when the server advertises it; voucher-based, no per-call gas)
- `eip155:*` → `ExactEvmScheme` (used when the server advertises `scheme: "exact"`)
- `solana:*` → `ExactSvmScheme` (USDC SPL transfer co-signed by the advertised fee payer)

Batch-settlement channel state is persisted to `~/.x402-mcp-bridge/channels/client/` so client restarts do not re-deposit on the next call.

## Environment

| Variable                               | Required                | Default                                                             | Notes                                                                              |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `MCP_BRIDGE_EVM_PRIVATE_KEY`           | one of EVM/SVM required | —                                                                   | 0x-prefixed 32-byte hex. Funds USDC payments on Base, Arbitrum, etc.               |
| `MCP_BRIDGE_SVM_PRIVATE_KEY`           | one of EVM/SVM required | —                                                                   | base58 64-byte secret key (Phantom/solana-keygen format) **or** 64-int JSON array. |
| `MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC` | no                      | `100000` (= $0.10 USDC at 6 decimals)                               | Per-call spending cap. Payment aborts above this with a clear reason.              |
| `MCP_BRIDGE_MAX_TOTAL_ATOMIC`          | no                      | `1000000` (= $1.00 USDC)                                            | Cumulative session spending ceiling. Aborts further payments once reached.         |
| `MCP_BRIDGE_ALLOWED_PAYTO`             | no                      | — (any payee)                                                       | Comma-separated payee allowlist. When set, unlisted `payTo` addresses are refused. |
| `MCP_BRIDGE_ALLOWED_HOSTS`             | no                      | — (any public host)                                                 | Comma-separated hostname allowlist for outbound paid requests.                     |
| `MCP_BRIDGE_ALLOW_HTTP`                | no                      | `0`                                                                 | Set `1` to allow `http://` targets. Local development only.                        |
| `MCP_BRIDGE_DISCOVER_LIMIT`            | no                      | `20`                                                                | Max number of Bazaar tools to register dynamically. Set `0` to disable discovery.  |
| `MCP_BRIDGE_BAZAAR_URL`                | no                      | `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` | Override to point at a self-hosted or alternative bazaar.                          |
| `MCP_BRIDGE_BATCH_DEPOSIT_MULTIPLIER`  | no                      | `5`                                                                 | How many request-amounts to deposit at once when opening a batch channel.          |
| `MCP_BRIDGE_MAX_DEPOSIT_ATOMIC`        | no                      | `5000000` (= $5.00 USDC)                                            | Hard cap on the deposit amount per channel open / top-up.                          |
| `X402_MCP_BRIDGE_CHANNELS_DIR`         | no                      | `~/.x402-mcp-bridge/channels`                                       | Override the directory used by `FileClientChannelStorage`.                         |
| `RPC_URL_<chainId>`                    | no                      | viem default public RPC                                             | Per-chain RPC override. Example: `RPC_URL_8453=https://mainnet.base.org`.          |

`MCP_BRIDGE_*` key vars also fall back to `EVM_PRIVATE_KEY` / `SVM_PRIVATE_KEY` if you already have those set.

## Spending cap behavior

The pre-payment hook inspects the selected `accepts` entry and aborts payload creation if the amount exceeds the per-call cap, the payee is outside the allowlist, or the session ceiling would be crossed. The tool result then carries a clear error message naming the network, asset, and the limit that was hit — useful for the model to decide whether to ask you to raise it.

## Inspecting without a client

```bash
MCP_BRIDGE_SVM_PRIVATE_KEY=... npx -y @modelcontextprotocol/inspector npx -y @three-ws/mcp-bridge
```

The inspector connects over stdio and lists the static tools (`call_paid_endpoint`, `list_bazaar_tools`, `refresh_bazaar`) plus one dynamic tool per discovered Bazaar entry.

## Programmatic use

Any Node module can consume an x402 endpoint through the same buyer client:

```js
import { buildBuyerAxios } from '@three-ws/mcp-bridge/src/x402-axios-client.js';

const { api } = await buildBuyerAxios();
const res = await api.get('https://api.example.com/some-paid-resource');
```

The same spending caps, SSRF guard, and channel-storage rules apply. Idle batch channels can be refunded out-of-band with the `@x402` SDK's `client.refund(resourceUrl, { amount })`.

## Tests

```bash
npm test           # hermetic: url-guard SSRF policy, spending-cap hook, tool naming, stdio boot
npm run test:smoke # live: boots against the real Bazaar and asserts the cap blocks a real paid call
```

The hermetic suite generates throwaway keypairs in-process; no real keys or funds are ever involved.

## License

All rights reserved. See [LICENSE](./LICENSE).
