# hood-connect

[![Add Robinhood Chain](https://img.shields.io/badge/Robinhood_Chain-Add_to_wallet-00c805?logo=ethereum&logoColor=white&labelColor=101418)](https://nirholas.github.io/hood-connect/add.html)
[![npm](https://img.shields.io/badge/npm-hood--connect-cb3837?logo=npm&labelColor=101418)](https://www.npmjs.com/package/hood-connect)
[![license](https://img.shields.io/badge/license-proprietary-93a1af?labelColor=101418)](./LICENSE)

The wallet + onboarding kit for Robinhood Chain dApps.

Chain 4663 is not a default network in any wallet, so every dApp on it needs the same three
things before it can do anything useful: **add network, fund via bridge, connect**. Today each
team hand-rolls that flow. hood-connect makes it one component (React) or three function calls
(framework-free core):

- **EIP-6963 multi-wallet discovery** with legacy `window.ethereum` fallback.
- **`ensureChain()`**: connect, add chain 4663 via EIP-3085 if the wallet does not know it,
  switch, verify. Typed states for every phase, typed errors for every rejection path
  (including MetaMask's nested `-32603`/`4902` wrapping).
- **Chain params provably derived from viem**: `toAddChainParams()` computes EIP-3085 parameters
  from viem's official `robinhood` / `robinhoodTestnet` definitions at runtime. Nothing is
  hand-copied, and the test suite enforces it.
- **Balance bootstrap**: `checkBootstrap()` reads live ETH + USDG balances and, for the empty
  wallet every new user has on 4663, returns concrete funding options to render.
- **Funding funnel**: live bridge quotes and route execution into Robinhood Chain via the
  **LI.FI** API with **Relay** fallback (both verified live against chain 4663), plus the
  documented "withdraw from the Robinhood app" path.
- **`<HoodConnectButton />` and `<FundWallet />`** (React): the whole journey with a styled,
  themable skin; every visual state designed (no wallet, picker, connecting, adding, switching,
  wrong chain, connected, empty wallet, error).
- **`hoodWagmiConfig()`** for teams already on wagmi v2. The core requires neither wagmi nor React.

Docs site with a live connect button: **https://nirholas.github.io/hood-connect/**

## Install

```sh
npm install hood-connect
```

`viem >= 2.55.0` and [`hoodchain`](https://www.npmjs.com/package/hoodchain) (the Robinhood Chain
core SDK) are regular dependencies and install automatically. `react` (>= 18) and `wagmi` (>= 2)
are optional peers, needed only for the `hood-connect/react` and `hood-connect/wagmi` entries.

## Quickstart

### Framework-free

```ts
import { discoverWallets, ensureChain, checkBootstrap } from 'hood-connect'

const wallets = await discoverWallets()               // EIP-6963 + legacy fallback
const { address } = await ensureChain(wallets[0].provider, {
  network: 'mainnet',                                 // 4663 ('testnet' = 46630)
  onState: (s) => console.log(s.status),              // connecting | adding | switching | connected
})

const status = await checkBootstrap(address)          // live ETH + USDG read
if (!status.funded) console.log(status.fundingOptions) // bridge + Robinhood-app paths
```

### React

```tsx
import { HoodConnectButton, FundWallet } from 'hood-connect/react'

<HoodConnectButton showBalances onFund={() => openFunding()} />
<FundWallet onFunded={() => refetch()} />
```

### wagmi

```tsx
import { WagmiProvider } from 'wagmi'
import { hoodWagmiConfig } from 'hood-connect/wagmi'

const config = hoodWagmiConfig({ includeTestnet: true })
// <WagmiProvider config={config}>...</WagmiProvider>
```

### Funding funnel (core)

```ts
import { getFundingQuote, getFundingStatus } from 'hood-connect'

const quote = await getFundingQuote({
  fromChainId: 42161,                    // Arbitrum One
  fromAddress: account,
  amount: 10_000_000_000_000_000n,       // 0.01 ETH
})
// quote.tx is a ready-to-send source-chain transaction; quote.approval is
// set when bridging an ERC-20. Send with the user's wallet, then:
await getFundingStatus(quote, txHash)    // 'pending' | 'done' | 'failed'
```

## API

| Export | Entry | Purpose |
| --- | --- | --- |
| `discoverWallets` / `watchWallets` | `hood-connect` | EIP-6963 discovery (one-shot / streaming), legacy fallback |
| `ensureChain` | `hood-connect` | connect + add + switch + verify, typed `EnsureChainState`s |
| `addNetwork` / `toAddChainParams` | `hood-connect` | EIP-3085 add; params derived from any viem chain |
| `checkBootstrap` / `fundingOptionsFor` | `hood-connect` | live ETH/USDG balances + empty-wallet funding options |
| `getFundingQuote` / `getLifiQuote` / `getRelayQuote` | `hood-connect` | live bridge quotes (LI.FI primary, Relay fallback) |
| `getFundingStatus` / `listFundingChains` | `hood-connect` | bridge progress + source-chain list |
| `HoodConnectError` and subclasses | `hood-connect` | typed rejection paths (`ConnectionRejectedError`, `ChainAddRejectedError`, `ChainSwitchRejectedError`, ...) |
| `HoodConnectButton` / `FundWallet` | `hood-connect/react` | drop-in components, themable via `--hc-*` CSS variables, `unstyled` opt-out |
| `useHoodAccount` / `useEnsureChain` / `useWallets` | `hood-connect/react` | headless hooks over a shared connection store |
| `hoodWagmiConfig` | `hood-connect/wagmi` | wagmi v2 config for chain 4663 (+ optional 46630) |

Full guide with error-handling patterns: [docs/guide.html](https://nirholas.github.io/hood-connect/guide.html).

## "Add Robinhood Chain" button-as-a-service

[`docs/add.html`](https://nirholas.github.io/hood-connect/add.html) is a standalone page any
site can link or iframe so "Add to wallet" works from README badges:

```md
[![Add Robinhood Chain](https://img.shields.io/badge/Robinhood_Chain-Add_to_wallet-00c805?logo=ethereum&logoColor=white&labelColor=101418)](https://nirholas.github.io/hood-connect/add.html)
```

Testnet variant: append `?network=testnet`. Iframe variant: append `?embed=1`.

## Demo app

`examples/demo/` is a Vite + React app covering the full journey: connect, fund, read balances,
and swap 1 USDG for WETH through the [`hoodchain`](https://www.npmjs.com/package/hoodchain) SDK
(live QuoterV2 quote; execution unlocks when the wallet holds 1 USDG).

```sh
npm --prefix examples/demo install
npm run demo          # dev server on http://localhost:5173
```

## Development

```sh
npm install
npm test              # 36 unit tests: chain-param derivation, ensure-chain state
                      # machine (every rejection path), EIP-6963 discovery against
                      # a scripted provider harness, quote parsers on captured
                      # real API responses
npm run test:live     # read-only live checks: RPC chain 4663, real balance reads,
                      # real LI.FI + Relay quotes (nothing is signed or sent)
npm run build         # tsup: ESM + CJS + d.ts for ./ , ./react , ./wagmi, plus the
                      # browser bundle for docs/
npm run test:e2e      # real-browser E2E: Chromium + the real MetaMask extension
                      # (via dappwright) drives the demo app end to end.
                      # Build the demo first: npm --prefix examples/demo run build
                      # Headless machines: xvfb-run -a npm run test:e2e
```

Working against an unpublished local `hoodchain`? Until the version you need is on npm, link the
sibling checkout: `npm i ../robinhood-chain-sdk`.

## Docs site (GitHub Pages)

The static site in `docs/` works by opening `docs/index.html` locally and deploys with the
standard Pages toggle: **Settings, then Pages, then Deploy from a branch, then `main` and
`/docs`**. The landing page's connect button, block height, and USDG supply run live against
the public RPC directly on Pages. `docs/hood-connect.iife.js` is the committed browser build;
`npm run build` refreshes it.

## Publishing (owner step)

```sh
npm run build && npm test
npm publish --access public
```

## Notes

- **Read-only by default.** Nothing in the kit signs or sends a transaction except the two
  user-initiated sends: executing a funding-funnel bridge and the demo swap, both of which the
  user confirms in their own wallet.
- **Stock Tokens.** Stock Tokens are tokenized debt securities (issuer: Robinhood Assets
  (Jersey) Ltd) and may not be offered, sold, or delivered to US persons (additional limits:
  Canada, UK, Switzerland). hood-connect displays balances and moves ETH/stablecoins only; it
  never acquires Stock Tokens.
- Not affiliated with Robinhood Markets, Inc.

## License

All rights reserved. See [LICENSE](./LICENSE).

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
