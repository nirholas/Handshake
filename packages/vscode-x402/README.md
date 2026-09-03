# three.ws — x402 for VS Code

Browse the [x402](https://three.ws/x402.md) bazaar, decode `402 Payment Required`
challenges, and pay per call for paid APIs and MCP tools in **USDC or $THREE on
Solana**, or **USDC on Base** and other EVM chains, without leaving your editor.
Powered by [three.ws](https://three.ws).

x402 is a protocol for developers and agents, not end users, so unlike a 3D
viewer this is genuinely editor-native: the people wiring up paid endpoints and
calling them live in VS Code.

## Features

- **Bazaar sidebar** — live list of paid x402 HTTP APIs and MCP tools, merged
  across every facilitator via the three.ws discovery proxy
  (`/api/bazaar/list`, `/api/bazaar/search`). Filter by type, price, and tag;
  full-text search.
- **Inspect an endpoint** — paste any URL and decode its 402 challenge: every
  accepted network, asset, scheme, price (in USD), and `payTo`, with the rail
  each accept settles on (`[solana]` / `[evm]`) and the one this wallet can
  satisfy flagged.
- **Pay & call** — make a real paid request and settle it on the right rail
  automatically: **USDC or $THREE on Solana** via the real `@x402/svm` `exact`
  scheme, or **USDC on Base** and other EVM chains via
  [`@three-ws/x402-fetch`](../x402-fetch). The exact USD amount, token, and
  network are shown and confirmed before signing; a spending cap blocks anything
  above your limit. The response body and on-chain settlement receipt (tx hash)
  render inline.
- **Two secure wallets** — an EVM key and a Solana key, each stored only in VS
  Code SecretStorage (the OS keychain). Never in settings, never on disk in
  plaintext. The status bar shows both derived addresses.
- **Scaffold a paid endpoint** — generate a working `api/x402/<slug>.js` that
  follows the repo's canonical `paidEndpoint()` pattern, wired end-to-end from
  the first deploy.

## Setup

1. Install the extension and open the **x402 Bazaar** view in the activity bar.
2. Set a wallet key for the rail you want to pay on:
   - **x402: Set Solana Wallet Key** — a base58 secret key (or JSON byte array)
     for a funded Solana wallet holding USDC and/or $THREE.
   - **x402: Set EVM Wallet Key** — a `0x` + 64 hex key for a funded Base USDC
     wallet.
   Either or both; keys are stored in your OS keychain.
3. Browse or search the bazaar, open a service, and **Pay & call**.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `threewsX402.origin` | `https://three.ws` | Host of the bazaar discovery API. |
| `threewsX402.maxPaymentUsd` | `0.10` | Per-request spending cap, in USD. |
| `threewsX402.confirmEachPayment` | `true` | Confirm the exact amount before signing. |
| `threewsX402.network` | `""` (auto) | Preferred CAIP-2 network when a service accepts several (`solana:…` or `eip155:…`). Auto prefers USDC on Solana, then Base. |
| `threewsX402.preferToken` | `auto` | Token to pay when several are offered: `auto` (USDC first, then $THREE), `usdc`, or `three`. |
| `threewsX402.filters` | `{ "type": "http" }` | Default bazaar filters. |

## How payment works

The extension reads the 402 challenge and picks a payable requirement across both
rails, honouring `network` and `preferToken`.

- **Solana** (`solana:*`): the real `@x402/svm` `exact` scheme signs an SPL
  transfer of the selected token (USDC or **$THREE**, mint
  `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`) from your key and retries with
  the `X-PAYMENT` proof. This is the same buyer `@three-ws/x402-mcp` uses.
- **EVM** (`eip155:*`): [`@three-ws/x402-fetch`](../x402-fetch) signs a USDC
  **EIP-3009** `transferWithAuthorization` on Base (or another EVM chain) and
  retries with the proof.

Either way the merchant settles on-chain and returns the work plus a settlement
receipt, rendered inline with the token, network, and transaction hash. A
service that only accepts a rail you have no key for is flagged, and the
extension offers to set the matching wallet.

## Development

```bash
npm install
npm run build        # bundle to dist/extension.cjs
npm run watch        # rebuild on change
npm test             # requirement selection, token rules, scaffold template
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

Apache-2.0 (see [LICENSE](./LICENSE)) · part of the
[three.ws](https://three.ws) monorepo.
