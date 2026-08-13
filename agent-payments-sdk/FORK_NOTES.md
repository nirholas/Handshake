# Fork notes — `@three-ws/agent-payments` (dir: `agent-payments-sdk/`, version 3.1.0)

This package is a **deliberate, value-added three.ws fork** of pump.fun's
`@pump-fun/agent-payments-sdk`. It is the on-chain engine behind our **agent
tokens** product — the flow where a user launches a pump.fun token for their
agent ([api/pump/[action].js](../api/pump/[action].js), action `launch-agent`) and then charges
users who pay that agent in its token, with buyback and shareholder distribution
([api/agents/payments/[action].js](../api/agents/payments/[action].js)).

It is wired as a local npm workspace (this dir is in the root `package.json`
`workspaces`, scope `@three-ws/*` like our other workspace SDKs), so in-repo
imports of `@three-ws/agent-payments` resolve to this source. The real public
`@pump-fun/agent-payments-sdk` (3.0.3) is kept as a *separate* dependency — the
documented upstream baseline for external-facing skill templates
(`pump-fun-skills/**`, which pin it in their own manifests). See "Naming" below.

## TL;DR decision

**Keep the fork. Do NOT downgrade to the published release.** Our local copy is
materially *ahead* of upstream — it already implements the USDC-quote / token-2022
/ `buy_v2`/`sell_v2` migration that the published package lacks. Pinning to the
public version would *regress* live agent-token payments. The on-chain program is
pump.fun's; when they publish program changes we port them *into* this fork,
re-applying our patches — we never replace our copy with theirs.

This package is named under our own scope (`@three-ws/agent-payments`) so the
manifest is honest — it no longer squats pump.fun's package name. See "Naming"
below.

## Evidence — local 3.1.0 vs published 3.0.3

Published `@pump-fun/agent-payments-sdk` tops out at **3.0.3** (`npm view … version`
→ `3.0.3`; there is no `3.1.0`). Comparison of `npm pack @pump-fun/agent-payments-sdk@3.0.3`
against this source:

| | Published `3.0.3` (`latest`) | This fork `3.1.0` |
|---|---|---|
| Author | Pump Fun | nirholas |
| Scope | Solana agent-payments only | Solana **+ EVM + cross-chain** |
| Ship shape | single bundle, 1 export (`.`) | 7 export subpaths |
| Runtime deps | 3 | 13 |
| Source | not published (`files: ["dist"]`, minified) | full `src/` (~14.8k LOC) |
| Quote assets | SOL only | **SOL + USDC + token-2022** |
| Bonding-curve trades | none | `PumpTradeClient` (`buy_v2`/`sell_v2`/`buyExactQuoteIn`) |

Symbols present here and **absent from published 3.0.3** (verified by grepping the
3.0.3 bundle — all returned 0):

- Protocol v2 / new accounts: `buy_v2`, `sell_v2`, `buyExactQuoteIn`,
  `userVolumeAccumulator`, `fee_config`, `sharing_config`.
- USDC / token-2022: `USDC_MINT`, `decodeBondingCurveQuoteMint`,
  `resolveTokenProgramForMint`.
- Trading: `PumpTradeClient` and its `BuyQuote`/`SellQuote`/`ExactQuoteResult`,
  `CurrencyNotSupportedError`, `JupiterUnavailableError`.
- Fee routing: `pickFeeRecipient`, `pickBuybackFeeRecipient`.

What the **published 3.0.3 core does** provide (and we keep faithful to): the
agent-payments program (`AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7`) bindings —
`PumpAgent`/`PumpAgentOffline` (`create`, `acceptPayment`,
`buildAcceptPaymentInstructions`, `distributePayments`, `withdraw`,
`extendAccount`, `updateAuthority`, `updateBuybackBps`, `buybackTrigger`,
`getBalances`, `validateInvoicePayment`), the PDA helpers, decoders, and program
constants. Both share the same program IDs (`AgenTMiC2…`, pump `6EF8rrec…`) and
the same `PumpAgent` constructor `(mint, environment?, connection?)`, so our core
is binary-compatible with the deployed program; we have simply extended it.

These extensions are **woven into the core files** (e.g. USDC/token-2022 handling
lives inside `PumpAgentOffline.ts`; `types.ts` mixes upstream param types with our
`BuyQuote`/`SellQuote`). The fork is therefore *not* cleanly separable into
"upstream core + our add-ons" — another reason a drop-in swap to 3.0.3 is unsafe.

## Why not "track upstream" (and what we add)

Switching the dependency to published `^3.0.3` would drop every extension above —
USDC/token-2022 agent payments, the v2 trade client, plus EVM (`./evm`), x402 on
both chains (`./x402`, `./solana/x402`), a2a (`./a2a`), `CrossChainPaymentClient`,
solana-agent-kit actions, and the legacy program (`./solana/legacy-agent-payments`).
All are imported by `api/` routes and SDKs today. "Tracking upstream" is not a
drop-in; it is a feature *and* protocol regression.

## Keeping the core in sync with upstream

Upstream ships no source (only a minified bundle), so sync is a periodic manual
check of the **agent-payments core** — and a *forward port*, never a replace:

```bash
# Newer release than 3.0.3?
npm view @pump-fun/agent-payments-sdk version

# Diff the published public surface against ours.
cd "$(mktemp -d)" && npm pack @pump-fun/agent-payments-sdk@latest \
  && tar xzf *.tgz && grep -E '^export' package/dist/index.d.ts
```

If pump.fun changes the program ID, PDA seeds, IDL, or account layouts, port those
into `src/solana/` (and `src/solana/idl/`), keep our USDC/token-2022/v2 patches on
top, re-run `npm run build`, and bump the local version. Leave the EVM/x402/a2a
layers untouched.

## Naming (resolved)

Previously this package squatted **`@pump-fun/agent-payments-sdk@3.1.0`** — a scope
we don't own and a version that doesn't exist on npm; it resolved only because the
workspace shadowed the registry, which misled anyone reading the manifest.

It is now named **`@three-ws/agent-payments`** (matching our other workspace SDKs:
`@three-ws/avatar`, `@three-ws/agent-ui`, …). The split is:

- **Internal runtime** (`api/**`, `src/agent-skills-*`, `scripts/`, `tests/`,
  `vite.config.js`) imports **`@three-ws/agent-payments`** — this fork, with the
  USDC/token-2022/v2 extensions. No regression.
- **External-facing** templates (`pump-fun-skills/**`, shipped to users who
  `npm install`) reference the real **`@pump-fun/agent-payments-sdk@^3.0.3`** from
  npm — correct, since external users get the public package, and those templates
  use only the core `PumpAgent`, which 3.0.3 provides.

The root `package.json` keeps the real `@pump-fun/agent-payments-sdk@^3.0.3` as the
documented upstream baseline (mirroring the pin in those external skill templates),
while `@three-ws/agent-payments` auto-links from the `workspaces` array. No
root-tree runtime code imports the public package directly today — internal callers
all use the fork via `@three-ws/agent-payments`.

## Test fixtures

`src/solana/fixtures/pump-events/*.json` are real captured pump.fun logs whose
event payloads were re-encoded (same `BorshEventCoder` layouts) so the coin is
`$three` (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`), the bonding curve is
its derived PDA, and wallets/signatures are deterministic synthetics
(`sha256("three.ws/fixture/<label>")`). Amounts, reserves, discriminators, and
program-invoke structure are untouched, so decoder coverage is unchanged.

## Consumers (repo-wide, excluding the fork itself)

Core (agent-payments program): `api/agents/payments/[action].js`,
`api/agents/pumpfun/[action].js`, `api/pump/[action].js`, `api/cron/[name].js`,
`api/_lib/pump-swap-ix.js`, `scripts/buyback-devnet-smoke.mjs`,
`pump-fun-skills/create-coin/`.
Extensions: `api/_lib/pump.js` (`PumpTradeClient`), `src/agent-skills-agent-payments.js`
(EVM/x402/full lifecycle). All resolve via the workspace symlink;
`npm run build` regenerates `dist/` (root `postinstall` rebuilds on demand via
`scripts/build-cache.mjs`).
