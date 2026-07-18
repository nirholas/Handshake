# x402 Buyer Client

To consume a paid [x402 endpoint](x402-endpoints.md) — ours or anyone's — a
caller has to perform the "402 dance": probe the URL, read the payment challenge,
sign and settle a payment, then retry with an `X-PAYMENT` header. three.ws ships a
buyer client that wraps that whole sequence in one call, with spending-cap
enforcement built in.

> Source: [`api/_lib/x402-buyer-fetch.js`](../api/_lib/x402-buyer-fetch.js),
> [`api/_lib/x402-buyer-axios.js`](../api/_lib/x402-buyer-axios.js),
> caps [`api/_lib/x402-spending-cap.js`](../api/_lib/x402-spending-cap.js).

---

## `buyerFetch(url, opts)`

```js
import { buyerFetch } from '../_lib/x402-buyer-fetch.js';

const { ok, response, payment, settled } = await buyerFetch(
  'https://three.ws/api/x402/crypto-intel',
  {
    method: 'POST',
    body: { topic: 'sol' },          // serialized to JSON when an object
    caps: {
      address: 'MyAgentWalletPubkey',
      maxPerCall: '10000',           // $0.01  (USDC atomics, 6 decimals)
      maxPerHour: '1000000',         // $1.00 / hour
      maxPerDay:  '5000000',         // $5.00 / day
    },
    preferNetwork: 'solana',         // string, or fn(accepts) => requirement
    signPayment: ({ requirement }) => signSolanaPayment(kp, requirement),
  },
);

if (!ok) {
  // { ok:false, abort:true, reason } when a cap blocks the call,
  // or { ok:false, status, error } on a protocol error.
} else {
  const data = await response.json();  // the paid result
}
```

### Options

| Field | Required | Purpose |
|---|---|---|
| `method`, `headers`, `body` | no | Standard request shape; an object `body` is JSON-encoded. |
| `caps` | recommended | Spending-cap envelope: `address` plus `maxPerCall` / `maxPerHour` / `maxPerDay` in USDC atomics. |
| `signPayment({ requirement })` | **yes** | Returns the signed payment payload for the chosen requirement. |
| `preferNetwork` | no | Pick which advertised network to pay on — a network string, or a function over the `accepts` array. |
| `fetchImpl` | no | Inject a custom `fetch` (tests, proxies). |

### Why you supply `signPayment`

Signing differs per chain — EIP-712 `transferWithAuthorization` on Base, a signed
`VersionedTransaction` on Solana, a contract call on BSC — so the caller owns it.
The client owns only the cap check, the header dance, and settlement parsing. The
callback receives the selected `requirement` from the 402 challenge and returns
the payment payload to attach.

### Spending caps

Caps are enforced as a reserve → commit / rollback transaction in
`x402-spending-cap.js`, so a call is **counted before it fires** and rolled back if
it fails — caps hold even across concurrent calls. The store is Redis-backed when
available. If a call would exceed any window, `buyerFetch` returns
`{ ok: false, abort: true, reason }` **without paying**. The platform-wide ceiling
defaults live in env (`X402_MAX_PER_CALL_ATOMIC`, `X402_MAX_PER_HOUR_ATOMIC`,
`X402_MAX_PER_DAY_ATOMIC`; see [Configuration](configuration.md)).

## Axios variant

```js
import { wrapAxiosWithPaidRequest } from '../_lib/x402-buyer-axios.js';

const client = wrapAxiosWithPaidRequest(axios.create());
const res = await client.requestPaid({ url, method: 'POST', data, caps, signPayment });
```

Same cap surface and signing contract as `buyerFetch`, exposed as an Axios
instance method for callers already using Axios.

## Receipts and builder codes

On settlement the response carries the receipt material the platform issues
(`X402_RECEIPT_SIGNING_KEY` / `OFFER_RECEIPT_*`). If a challenge declares a
builder-code extension, the client echoes it (and `X402_BUILDER_CODE_WALLET` when
set) back into the payment so attribution survives the round trip.

## Related

- [x402 protocol](x402.md) — the underlying challenge/settle mechanics.
- [x402 paid endpoints](x402-endpoints.md) — what you can buy from us.
- [Autonomous x402 loop](autonomous-x402.md) — uses this client on a schedule.
