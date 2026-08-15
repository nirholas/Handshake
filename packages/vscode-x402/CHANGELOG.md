# Changelog

## 0.2.1

- **Scaffolded endpoints are Solana-first.** `x402: Scaffold a Paid Endpoint`
  used to emit `networks: ['base']`, so a generated endpoint advertised Base
  only. It now emits `['solana', 'base']`, matching every hand-written paid
  route on the platform.
- Test suite added (`npm test`): requirement selection across both rails, token
  classification, wallet-key parsing, and the scaffold template (which is now
  asserted to parse and to pass only options `paidEndpoint()` accepts).
- The bundle is emitted as `dist/extension.cjs` so the CommonJS extension entry
  and the ESM sources can coexist without ambiguity.

## 0.2.0

Solana + $THREE payments.

- Pay x402 services on **Solana** in **USDC or $THREE** (the three.ws platform
  token), settled with the real `@x402/svm` `exact` scheme — the same buyer
  `@three-ws/x402-mcp` uses. Nothing mocked.
- Dual wallets: an EVM key (USDC on Base and other EVM chains) and a Solana key
  can be set independently. Each is stored in VS Code SecretStorage.
- New commands: `x402: Set Solana Wallet Key`, `x402: Clear Solana Wallet Key`.
  The status bar and wallet picker manage both keys.
- New `threewsX402.preferToken` setting (`auto` | `usdc` | `three`) to choose
  which token to pay when a service accepts several. `auto` prefers USDC on
  Solana, then Base, and falls back to $THREE.
- Pay & call auto-routes each request to the correct rail based on the 402
  challenge; the confirmation and receipt now show the token and network.
- `threewsX402.network` now defaults to auto (empty). Set a CAIP-2 id
  (`solana:…` or `eip155:…`) to force a network.

## 0.1.0

Initial release.

- Bazaar sidebar with live discovery, filters, and full-text search.
- Inspect command: decode any endpoint's 402 payment challenge.
- Pay & call paid x402 endpoints with USDC via `@three-ws/x402-fetch`, with a
  spending cap, pre-payment confirmation, and inline settlement receipts.
- Secure EVM wallet key storage in VS Code SecretStorage; wallet status bar.
- Scaffold a paid endpoint following the repo's `paidEndpoint()` pattern.
