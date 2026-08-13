<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/solana-agent</h1>

<p align="center"><strong>Solana agent SDK: keypair + browser wallets, SOL/SPL transfers, Jupiter swaps, staking, and the x402 exact payment scheme.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/solana-agent"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/solana-agent?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/solana-agent"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/solana-agent?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/solana-agent?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/solana-agent?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#entry-points">Entry points</a> ·
  <a href="#wallet-providers">Wallets</a> ·
  <a href="#x402-exact-payments">x402</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> A typed Solana SDK for AI agents. Give an agent a wallet — its own keypair for
> autonomous signing, or a browser wallet that defers signing to the user — then
> transfer SOL and SPL tokens, swap via Jupiter, stake, pay x402 invoices in USDC,
> and plug into solana-agent-kit. Dual ESM/CJS, fully typed.

## Install

```
npm install @three-ws/solana-agent @solana/web3.js
```

`@solana/web3.js` (`^1.98`) is the base it builds on; `@solana/spl-token` and `@coral-xyz/anchor` ship as direct dependencies. `zod` is an optional peer dependency.

## Entry points

The package exposes these subpath exports (each dual ESM/CJS with type declarations):

| Import | What it provides |
| --- | --- |
| `@three-ws/solana-agent` | the `SolanaAgent` class, all wallet providers, action functions, tx utilities, and error classes |
| `@three-ws/solana-agent/wallet` | the wallet providers (re-exported from the root) |
| `@three-ws/solana-agent/x402-exact` | the x402 "exact" USDC payment scheme (payer + facilitator) |
| `@three-ws/solana-agent/solana-agent-kit` | a `solana-agent-kit` plugin and tool-call `Action` definitions |
| `@three-ws/solana-agent/vanity` | provably-fair vanity wallet grinding: one-call client, receipt verifier, sealed-envelope opener |

## Quick start

`SolanaAgent` is the main entry. Use the static factories — `fromKeypair` (the agent holds the key and signs autonomously) or `fromBrowserWallet` (signing is deferred to the user's wallet).

```js
import { SolanaAgent } from '@three-ws/solana-agent';

// Agent-controlled wallet (base58 secret key, Uint8Array, or number[]).
const agent = SolanaAgent.fromKeypair(process.env.SOLANA_SECRET_KEY, 'https://api.mainnet-beta.solana.com');

console.log(agent.publicKey.toBase58());
const lamports = await agent.getBalance();
```

### Actions

`SolanaAgent` exposes the on-chain actions as instance methods:

```js
// Send native SOL (amount in SOL, not lamports). Returns the tx signature.
const sig = await agent.transferSol('<recipient>', 0.01);

// Send SPL tokens (amount in base units, as a bigint).
await agent.transferSpl('<mint>', '<recipient>', 1_000_000n);

// Jupiter swap, and a quote-only variant.
const quote = await agent.getSwapQuote({ inputMint, outputMint, amount });
await agent.swap({ inputMint, outputMint, amount });

// Token balances / accounts.
const bal = await agent.getTokenBalance('<mint>');   // null if no account for that mint
const accounts = await agent.getTokenAccounts();      // non-zero balances only

// Associated token account.
const { address, created } = await agent.getOrCreateAta({ mint: '<mint>' });

// Staking.
await agent.stakeSOL('<voteAccount>', 1);             // amount in SOL
await agent.unstakeSOL('<stakeAccount>');             // withdrawable after ~1 epoch
const stakes = await agent.getStakeAccounts();
```

The underlying functions (`transferSol`, `transferSpl`, `jupiterSwap`, `getSwapQuote`, `getTokenBalance`, `getTokenAccounts`, `getOrCreateAta`, `stakeSOL`, `unstakeSOL`, `getStakeAccounts`) and the `SOL_MINT` constant are also exported from the root for functional use.

## Wallet providers

All implement the same `WalletProvider` interface, so they are interchangeable in `new SolanaAgent({ wallet, connection })`:

- `KeypairWalletProvider` — server-side keypair. `new KeypairWalletProvider(privateKey)` accepts a base58 string, `Uint8Array`, or `number[]`.
- `BrowserWalletProvider` — server half of a split browser-signing flow (`createHandler()` mounts on your HTTP server).
- `BrowserWalletClient` — browser half; signs via a user-supplied `SignerFn` with an `ApprovalHandler`.
- `WalletAdapterProvider` — wraps a `@solana/wallet-adapter` wallet.

`isMetaAware()` plus the `TxMetadata` / `MetaAwareWallet` types support attaching memo/metadata to transactions.

## x402 exact payments

The `exact` scheme transfers a fixed USDC amount via an SPL `TransferChecked` and returns the tx signature as the proof for an x402 `X-PAYMENT` header. Compatible with x402 v2.

```js
import { payExact, buildExactPaymentPayload, USDC_MAINNET, SOLANA_MAINNET } from '@three-ws/solana-agent/x402-exact';

const requirements = {
  scheme: 'exact',
  network: SOLANA_MAINNET,        // CAIP-2 identifier
  asset: USDC_MAINNET,            // SPL mint (base58)
  amount: '1000000',              // 1 USDC, base units
  payTo: '<recipient address>',
  maxTimeoutSeconds: 60,
};

// Payer side: build + sign + send the transfer, get the proof.
const proof = await payExact(agent.wallet, agent.connection, requirements);

// Wrap it into an x402 v2 PaymentPayload for the X-PAYMENT header retry.
const payload = buildExactPaymentPayload(requirements, proof, 'https://api.example/thing');
```

Receiver / facilitator side:

```js
import { ExactFacilitator } from '@three-ws/solana-agent/x402-exact';

const facilitator = new ExactFacilitator('https://api.mainnet-beta.solana.com'); // RPC URL
const verify = await facilitator.verify(proof, requirements);  // VerifyResponse { isValid, ... }
const settle = await facilitator.settle(proof, requirements);  // SettleResponse { success, ... }
```

Types: `ExactPaymentRequirements` (`scheme`, `network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds`, `extra?`), `ExactPaymentProof` (`signature`, `network`), `VerifyResponse`, `SettleResponse`. Constants: `SOLANA_MAINNET`, `SOLANA_DEVNET`, `USDC_MAINNET`, `USDC_DEVNET`.

## solana-agent-kit plugin

For [solana-agent-kit](https://github.com/sendaifun/solana-agent-kit) v2, register the plugin:

```js
import { SolanaAgentKit } from 'solana-agent-kit';
import { SolanaAgentPlugin } from '@three-ws/solana-agent/solana-agent-kit';

const kit = new SolanaAgentKit(privateKey, rpcUrl, {});
kit.use(SolanaAgentPlugin);
```

Or drive the `Action` definitions directly against a `SolanaAgent`:

```js
import { SolanaAgent } from '@three-ws/solana-agent';
import { swapAction, allActions } from '@three-ws/solana-agent/solana-agent-kit';

const agent = SolanaAgent.fromKeypair(key, rpcUrl);
const result = await swapAction.handler(agent, { inputMint, outputMint, amount });
```

Exports here: `SolanaAgentPlugin`, `allActions`, the individual actions (`transferSolAction`, `transferSplAction`, `swapAction`, `getSwapQuoteAction`, `getBalanceAction`, `createAtaAction`, `stakeSolAction`, `unstakeSolAction`, `getStakeAccountsAction`), and the `Action` / `Plugin` / `SolanaAgentLike` types.

## AgenC coordination

The root export also bundles an adapter for the [AgenC](https://agenc.tech)
on-chain agent-coordination protocol — register agents, create and claim tasks,
and bridge identities from ERC-8004 / MPL-Core / three.ws handles into AgenC ids.

```js
import {
  createAgenCClient,
  registerAgenCAgent,
  createAgenCTask,
  claimAgenCTask,
  completeAgenCTask,
} from '@three-ws/solana-agent';
```

Also exported: `getAgenCAgent`, `deriveAgenCAgentPda`, the task lifecycle helpers
(`getAgenCTask`, `getAgenCTaskLifecycle`, `listAgenCTasksByCreator`,
`generateAgenCTaskId`, `formatTaskState`), the identity bridges
(`bridgeErc8004ToAgenCId`, `bridgeMplCoreToAgenCId`, `bridgeThreewsHandleToAgenCId`,
`getCanonicalThreewsAgenCId`), and the program-id constants
(`AGENC_DEVNET_PROGRAM_ID`, `AGENC_MAINNET_PROGRAM_ID`).

## Provably-fair vanity wallets

`grindVerifiedVanity` requests a vanity address from the three.ws
`/api/x402/vanity-verifiable` endpoint, opens the ECIES-sealed secret locally,
and independently verifies every claim in the signed receipt before handing
you the key. It throws instead of returning a key that fails verification.

```js
import { grindVerifiedVanity, verifyVanityReceipt } from '@three-ws/solana-agent/vanity';

const { address, secretKeyBase58, receipt } = await grindVerifiedVanity({
  prefix: 'abc',
  fetchImpl: paywallFetch,   // x402-capable fetch (e.g. wrapFetchWithPayment)
});

// The receipt is portable: anyone can re-verify it later.
const check = await verifyVanityReceipt(receipt);
```

Also exported: the verifier internals (`verifyVanityReceipt`, `verifyReceiptSignature`, `commitToSeed`, `deriveMasterSeed`, `candidateSeed`, `candidateAddress`, `addressMatchesPattern`, `expectedAttempts`, `fetchServiceKey`), the sealed-envelope helpers (`openSealed`, `openSealedJson`, `generateRecipientKeypair`, `SEALED_ENVELOPE_SCHEME`), and the protocol constants (`VANITY_PROTOCOL_VERSION`, `THREE_VANITY_SERVICE_KEY`, `THREE_VANITY_WELL_KNOWN`, `THREE_VANITY_ENDPOINT`).

## Errors

Typed error classes (exported from the root) for boundary handling: `SolanaAgentError`, `TransactionRejectedError`, `WalletNotConnectedError`, `WalletCapabilityError`, `MissingTokenAccountError`, `SwapError`, `SimulationError`, `ConfirmationTimeoutError`.

## Requirements

- **Node** `>= 18`.
- **Base dep:** `@solana/web3.js@^1.98`. `@solana/spl-token` and
  `@coral-xyz/anchor` ship as direct dependencies; `zod` is an optional peer dep.
- For browser signing, a `@solana/wallet-adapter` wallet or a user-supplied
  `SignerFn`.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Sibling SDK: [`@three-ws/agent-payments`](https://www.npmjs.com/package/@three-ws/agent-payments)
- Issues: https://github.com/nirholas/three.ws/issues
- License: proprietary, all rights reserved. See [LICENSE](./LICENSE).

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
