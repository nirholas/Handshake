# 14 — Wallet & onboarding kit: `hood-connect`

Read `prompts/robinhood-chain/_shared.md` first. Wave 2: requires core SDK
(`file:../robinhood-chain-sdk`).

## Mission
Build `robinhood/hood-connect/` — the wallet + onboarding kit for Robinhood Chain dApps.
Chain 4663 is NOT a default network in any wallet; every dApp there needs "add network →
fund via bridge → connect" and today each developer hand-rolls it. This kit makes it one
component. Confirmed ecosystem gap (no wagmi connector kit / wallet UI kit exists). npm
`hood-connect` (fallbacks: `hoodconnect`, `@hoodkit/connect`).

## Deliverables

1. **`hood-connect/core`** (framework-free) —
   - `addNetwork(provider)` — EIP-3085 `wallet_addEthereumChain` for 4663/46630 with the
     official params (from viem chain defs), plus EIP-6963 multi-wallet discovery.
   - `ensureChain(provider)` — connect → add-if-missing → switch, one call, typed states.
   - Balance bootstrap check: detects an empty wallet on 4663 and returns funding options.
2. **`hood-connect/react`** — `<HoodConnectButton />` (the whole flow in one component:
   discover wallets → connect → switch/add chain → show address + ETH/USDG balances),
   `useHoodAccount()`, `useEnsureChain()`. Headless hooks + a styled default skin matching the
   `_shared.md` design bar; every visual state designed (disconnected, wrong-chain, adding,
   connected, error, no-wallet-installed with install links).
3. **Funding funnel** — `<FundWallet />`: live bridge routing via the LI.FI SDK/API (Robinhood
   Chain is supported — verify current route support against their API during the build, fall
   back to Relay if LI.FI lacks a route) so users move ETH/USDC from any chain to 4663 without
   leaving the dApp; plus a "from Robinhood app" path documenting Robinhood Wallet withdrawal.
   Real quotes, real route execution (test on a small real transfer if funds are available;
   otherwise verify to the quote/route step and say so).
4. **"Add Robinhood Chain" button-as-a-service** — a tiny embeddable snippet (`docs/add.html`,
   linkable on Pages) any site can iframe/link so "Add to wallet" works from README badges.
   Include the markdown badge snippet in the README.
5. **Demo app** — `examples/demo/` (Vite): connect, fund, read balance, swap 1 USDG via the
   core SDK — the full onboarding journey, exercised in a real browser during the build.

## Requirements
- Wagmi optionality: ship a wagmi v2 config export (`hood-connect/wagmi`) for teams already on
  wagmi, but core must not require wagmi or React.
- Vitest: chain-param correctness (assert against viem defs, not copies), state machines for
  ensureChain (each wallet-rejection path), EIP-6963 discovery with a scripted mock provider
  (test-only harness, clearly not shipped code).
- Real-browser verification of the demo app with at least one real wallet extension (document
  which; headless + extension via Playwright is acceptable).
- `docs/` static site per `_shared.md`: landing = the live connect button working on Pages
  (connectable by any visitor with a wallet), integration guide (vanilla/React/wagmi), funding
  funnel docs, the add-network badge gallery.

## Done checklist
- [ ] Demo journey completed in a real browser (evidence in report; tx hash if funding/swap ran).
- [ ] Connect button works ON the Pages docs site itself.
- [ ] Chain params provably derived from viem (test), never duplicated by hand.
- [ ] `npm pack` clean for all entry points; README badge snippet renders.
