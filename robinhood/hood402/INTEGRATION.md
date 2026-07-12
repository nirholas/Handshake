# Integrating hood402 into three.ws's x402 catalog

This describes exactly how to add `network: robinhood-chain` as an accepted rail in
three.ws's existing x402 catalog (`api/_lib/x402-spec.js` + `api/_lib/x402-paid-endpoint.js`),
using this package. **No changes were made to three.ws in this prompt** — this is the plan
for the agent that does that work.

## The two protocol mismatches to reconcile first

three.ws's catalog and hood402 both implement `exact`/EIP-3009, but they encode it
differently on the wire. An integration has to bridge these, not paper over them:

| | three.ws (`x402-spec.js`) | hood402 |
|---|---|---|
| `x402Version` | `2` (`X402_VERSION = 2`, line 81) | `1` |
| Network id | CAIP-2 (`eip155:8453`, `eip155:56`, `solana:5eykt4...`) | Plain string (`robinhood`, `robinhood-testnet`) |
| Price field | `amount` (v2; per `paymentRequirements()`, line 169) | `maxAmountRequired` (v1) |
| Envelope shape | `resource`/`description`/`mimeType` top-level, not per-`accepts` entry | Per-`accepts` entry (v1) |
| Headers | `X-PAYMENT` / `X-PAYMENT-RESPONSE` (+ a `PAYMENT-REQUIRED` mirror for older clients) | `X-PAYMENT` / `X-PAYMENT-RESPONSE` — **same headers, no change needed here** |

The header names already match — that's the easy part. The version number, network id
format, and price field name don't, and three.ws's own facilitator-capability probe
(`x402-spec.js` ~line 716) hard-checks `(k.x402Version ?? 1) === X402_VERSION` — a v1
facilitator's `/supported` response fails that check as written. **This is exactly the kind
of per-network special-case three.ws's code already has a seam for**: see
`DIRECT_NETWORKS = new Set([NETWORK_BSC_MAINNET])` (line 120) and the `selfFacilitatorEnabled()`
/ `selfFacilitatorUrl()` pair — BSC already gets bespoke handling instead of going through
the generic v2 facilitator path. Robinhood Chain should get the same treatment: a small,
explicit special case, not a generic-path retrofit.

## Recommended integration: hood402 as a library, not a second service

three.ws runs one Cloud Run container serving all of `api/**` (see the root `CLAUDE.md`
stack notes). Rather than deploying a separate `hood402-facilitator` process, **import
hood402's `verifyPayment`/`settlePayment`/`buildRequirements` directly** and call them from
a new `api/_lib/x402-robinhood.js` — this is the same shape as three.ws's existing
`selfFacilitatorEnabled()` self-settle path, just using hood402's implementation instead of
reimplementing EIP-3009 verification a second time.

```bash
npm install hood402 viem
```

```js
// api/_lib/x402-robinhood.js — new file, not a modification of x402-spec.js
import {
  buildRequirements,
  verifyPayment,
  settlePayment,
  requireNetwork,
} from 'hood402';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { env } from './env.js';

const net = requireNetwork(env.ROBINHOOD_CHAIN_NETWORK ?? 'robinhood'); // or 'robinhood-testnet'
const transport = http(env.ROBINHOOD_CHAIN_RPC_URL ?? net.rpcUrl);
const reader = createPublicClient({ chain: net.chain, transport });

const account = privateKeyToAccount(env.ROBINHOOD_FACILITATOR_PRIVATE_KEY);
const wallet = createWalletClient({ account, chain: net.chain, transport });

export function robinhoodRequirements(resourceUrl, amountAtomic) {
  return buildRequirements({
    price: { atomic: String(amountAtomic) },
    payTo: env.X402_PAY_TO_ROBINHOOD,
    resource: resourceUrl,
    network: net.id,
  });
}

export async function verifyRobinhoodPayment(paymentPayload, requirements) {
  return verifyPayment({ payload: paymentPayload, requirements, reader });
}

export async function settleRobinhoodPayment(paymentPayload, requirements) {
  return settlePayment({
    payload: paymentPayload,
    requirements,
    wallet,
    account: account.address,
    reader,
  });
}
```

Then in `x402-spec.js`, add a Robinhood Chain branch alongside the existing Base/BSC/Solana
ones — modeled directly on the `env.X402_PAY_TO_BASE` block (line 208) and the
`DIRECT_NETWORKS` special case (line 120):

- Add `NETWORK_ROBINHOOD_MAINNET = 'eip155:4663'` and `NETWORK_ROBINHOOD_TESTNET = 'eip155:46630'`
  next to the existing `NETWORK_*` constants (hood402's `networks.ts` already recognizes
  both of these CAIP-2 strings as aliases for its own `'robinhood'`/`'robinhood-testnet'`
  ids, so passing either form into `buildRequirements`/`requireNetwork` works).
- Add Robinhood Chain to `DIRECT_NETWORKS` (or an equivalent new set) so the generic v2
  facilitator-probe path (`/supported` with the `x402Version === 2` check) is skipped for
  it — verification and settlement route to `verifyRobinhoodPayment`/`settleRobinhoodPayment`
  above instead, exactly like BSC's direct-settlement path.
- In `paymentRequirements()`, push a Robinhood Chain accept entry when
  `env.X402_PAY_TO_ROBINHOOD` is set, translating the v2 `amount` into hood402's
  `maxAmountRequired` via `robinhoodRequirements(resourceUrl, amount).maxAmountRequired`
  rather than duplicating the price-atomics math.
- In the incoming-payment dispatch (wherever `x402-spec.js` currently branches on
  `paymentPayload.network` to route Base vs. BSC vs. Solana verification), add a branch
  for `NETWORK_ROBINHOOD_MAINNET`/`NETWORK_ROBINHOOD_TESTNET` calling
  `verifyRobinhoodPayment`/`settleRobinhoodPayment`.

## Alternative: point at a standalone hood402-facilitator

If isolating the Robinhood Chain gas key from the main API container is preferred, deploy
[`facilitator/`](./facilitator) as its own Cloud Run service instead (see
`facilitator/README.md`) and call its HTTP `/verify` + `/settle` endpoints from
`x402-robinhood.js` in place of the direct `verifyPayment`/`settlePayment` calls — same
`DIRECT_NETWORKS` wiring in `x402-spec.js`, just with an HTTP hop instead of an in-process
call. Use hood402's own `FacilitatorClient` for this:

```js
import { FacilitatorClient } from 'hood402';
const facilitator = new FacilitatorClient({ url: env.ROBINHOOD_FACILITATOR_URL });
// facilitator.verify(paymentPayload, requirements) / facilitator.settle(...)
```

This still bypasses the generic v2 `/supported`-probe path (`DIRECT_NETWORKS`) since the
facilitator's `/supported` reports `x402Version: 1`.

## Environment variables to add

| Variable | Where it's read | Purpose |
|---|---|---|
| `X402_PAY_TO_ROBINHOOD` | `x402-spec.js`, `payTo` on the accept entry | The address that receives USDG payments. |
| `ROBINHOOD_CHAIN_NETWORK` | `x402-robinhood.js` | `robinhood` (mainnet 4663) or `robinhood-testnet` (46630). |
| `ROBINHOOD_CHAIN_RPC_URL` | `x402-robinhood.js` | Optional RPC override (defaults to the public endpoint). |
| `ROBINHOOD_FACILITATOR_PRIVATE_KEY` | `x402-robinhood.js` (library mode only) | The gas wallet that broadcasts settlement. Never holds user funds. |
| `ROBINHOOD_FACILITATOR_URL` | `x402-robinhood.js` (standalone-facilitator mode only) | Base URL of a deployed `hood402-facilitator`. |

## Settlement wallet

Either mode needs one funded EVM key with a small amount of ETH on Robinhood Chain for
gas (USDG settlement itself is gasless for the *payer* — EIP-3009 — but the relayer/
facilitator still pays gas to broadcast). Store it the same way three.ws stores its other
chain keys: a Secret Manager-backed env var on the Cloud Run service, never in code or
`.env` files with real values (`.gitignore` already covers `.env*` — see the root
`CLAUDE.md` "Known traps" section for the existing env-var handling conventions on this
project).

## What this buys three.ws

Once wired, `network: robinhood-chain` becomes a normal entry in the existing
`paymentRequirements()` `accepts[]` array — any agent that already knows how to pay a
three.ws x402 endpoint (Base, BSC, Solana) sees a fourth option with no client-side changes
needed on their end for the ones that already speak generic v1 `exact`/EIP-3009 (most
x402 SDKs do, since it's the original scheme). Agents using hood402's own client, or any
other v1-speaking x402 client, can pay a three.ws endpoint in USDG directly.
