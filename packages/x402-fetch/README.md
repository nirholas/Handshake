# @three-ws/x402-fetch

A drop-in `fetch` that silently answers [x402](https://x402.org) payment
challenges. Wrap a wallet once, then call any paid [three.ws](https://three.ws)
(or CDP-x402 / agentic.market) endpoint as if it were free.

```bash
npm install @three-ws/x402-fetch
```

- **Zero production dependencies.** The secp256k1 / keccak256 / EIP-712 signing
  stack is inlined — no `viem`, `ethers`, or `@wagmi/core` pulled into your bundle.
- **Works in the browser and Node.** MetaMask / EIP-1193 providers, the three.ws
  agent SDK wallet, or a raw private key all work.
- **Safe by default.** A `maxPaymentUsd` guard refuses to auto-pay more than you
  authorize. Descriptive errors instead of silent failures.
- **USDC on Base.** Signs EIP-3009 `transferWithAuthorization` — the same payload
  MetaMask's `eth_signTypedData_v4` produces, byte-for-byte.

## Quick start

```js
import { withX402 } from '@three-ws/x402-fetch';

// Browser: pass the injected wallet provider.
const pay = withX402(window.ethereum, { maxPaymentUsd: 0.1 });

const res = await pay('https://three.ws/api/mcp', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});

const data = await res.json(); // paid + unlocked, transparently
```

On a `402 Payment Required`, the wrapper parses the challenge, selects the USDC-on-Base
requirement, signs the authorization, and retries with the `X-PAYMENT` header — all
before your `await` resolves. Non-402 responses pass through untouched.

## Wallet forms

**Browser (MetaMask / any EIP-1193 provider):**

```js
withX402(window.ethereum);
```

**Node.js (private key):**

```js
import { withX402 } from '@three-ws/x402-fetch';
import { privateKeyToWallet } from '@three-ws/x402-fetch/wallet';

const pay = withX402(privateKeyToWallet(process.env.WALLET_PRIVATE_KEY));
```

**Pre-built signer (three.ws agent SDK / viem account):**

```js
withX402({ address, signTypedData });
```

## Options

```js
withX402(wallet, {
	maxPaymentUsd: 1.0, // refuse to auto-pay more than this per request (default 0.10)
	onPayment: ({ amount, to, requestUrl }) => console.log(`paying $${amount} to ${to}`),
	timeout: 30000, // ms to wait for payment authorization (default 15000)
	network: 'eip155:8453', // prefer a specific CAIP-2 network from accepts[]
});
```

`maxPaymentUsd` is a hard guard: a challenge above the limit throws rather than
paying, so a misconfigured or hostile server can never silently overcharge you.

## Compatibility alias

For parity with the upstream `x402-fetch` package, `wrapFetchWithPayment` is
exported with the fetch-first signature:

```js
import { wrapFetchWithPayment } from '@three-ws/x402-fetch';
const pay = wrapFetchWithPayment(fetch, wallet);
```

## Errors

| Message | Meaning |
| --- | --- |
| `no supported network/asset was found in accepts[]` | The server only offered networks/assets this wrapper can't sign (it signs USDC on Base / EVM EIP-3009). |
| `payment of $X exceeds maxPaymentUsd limit` | The challenge asked for more than your authorized ceiling. |
| `user rejected payment` | The wallet user cancelled the signature. |
| `payment submitted but server still returned 402` | The retry was still gated — usually an amount/recipient mismatch. |

## Examples

Runnable scripts live in [`examples/`](./examples): a zero-spend 402 discovery probe and a real env-gated paid call against the live three.ws Market Data API.

## License

Apache-2.0. See [LICENSE](./LICENSE).
