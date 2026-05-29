# @three-ws/solana-agent

Solana agent SDK for three.ws — keypair and browser wallets, SOL/SPL transfers, Jupiter swaps, staking, and the x402 "exact" payment scheme. Dual ESM/CJS, fully typed.

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

## Errors

Typed error classes (exported from the root) for boundary handling: `SolanaAgentError`, `TransactionRejectedError`, `WalletNotConnectedError`, `WalletCapabilityError`, `MissingTokenAccountError`, `SwapError`, `SimulationError`, `ConfirmationTimeoutError`.

## Build & test

```
npm run build       # tsup -> dist (ESM + CJS + d.ts)
npm run typecheck   # tsc --noEmit
npm test            # jest
```

Source lives in `src/` (`agent.ts`, `wallet/`, `actions/`, `x402-exact/`, `solana-agent-kit/`, `tx/`, `utils/`, `errors.ts`).
