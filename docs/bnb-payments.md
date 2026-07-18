# BNB Chain payments — MPP + gasless sends

three.ws lets AI agents pay for API calls with stablecoins, no account or API
key needed. This page is for developers wiring an agent to pay (or charge) over
BNB Chain. Our catalog has always run **x402** (the CDP wire format) on Solana,
the home chain, and Base. It now also speaks **MPP** (BNB Chain's Machine
Payments Protocol), so agents from the BNB ecosystem can pay our endpoints, and
our agents can pay theirs. BNB Chain is an additional surface, not a
replacement for the Solana rails. This page explains both halves plus the
gasless-send rail underneath, for a reader with zero prior context.

Everything here is real code against real endpoints. Where a capability needs a
credential we don't ship (a facilitator merchant key, a funded testnet wallet),
that is called out honestly — nothing is faked.

---

## 1. What MPP is, and how it relates to x402

MPP is BNB Chain's answer to x402. Its `b402` layer (Binance OnchainPay) is
**x402 v2, byte-for-byte** — the same `402 Payment Required` challenge, the same
base64 `X-PAYMENT` request header, the same `X-PAYMENT-RESPONSE` receipt header,
and the same EIP-3009 `transferWithAuthorization` credential our Base x402 path
already signs. The only real differences are:

| | x402 (our existing path) | MPP / b402 (new) |
|---|---|---|
| Networks | Solana, Base (`eip155:8453`) | BNB Chain (`eip155:56`, testnet `eip155:97`) |
| Settlement | our Solana/Base facilitator | the b402 facilitator (Binance OnchainPay) |
| Credential | EIP-3009 (Base), signed tx (Solana) | EIP-3009 (`buildEip3009Payment`) |

Because the wire format is shared, a single endpoint can advertise **both** and a
single buyer can pay **either** — see the [bridge spec](../specs/x402-mpp-bridge.md)
for the exact header-precedence and credential-mapping contract.

The code lives in `api/_lib/bnb/`:

- `mpp-server.js` — accept MPP payments (the merchant side).
- `mpp-buyer.js` — pay MPP endpoints (the buyer side).
- `megafuel.js` — send BNB Chain transactions with zero gas (the rail below).
- `chains.js` — chain metadata + a resilient RPC client shared by all three.

---

## 2. Pay one of our endpoints with MPP (buyer POV)

Our pilot endpoint, the **$THREE Town Oracle** (`GET /api/x402/three-intel`),
accepts MPP additively: pay it on BNB Chain and it settles through b402; pay it on
Solana/Base and the original x402 path is untouched.

A minimal buyer, using any x402/b402 client. The flow is the standard 402 dance:

```js
import { privateKeyToAccount } from 'viem/accounts';
import { buildEip3009Payment, encodeXPayment } from '@bnb-chain/mpp/b402';

const account = privateKeyToAccount(process.env.BNB_TESTNET_DEPLOYER_KEY);
const url = 'https://three.ws/api/x402/three-intel';

// 1. Probe — get the 402 menu.
const probe = await fetch(url);
const challenge = await probe.json();           // { x402Version: 2, accepts: [...] }

// 2. Pick the BNB Chain (eip155:97) eip3009 offer.
const requirement = challenge.accepts.find(
  (a) => a.network === 'eip155:97' && a.extra?.assetTransferMethod === 'eip3009',
);

// 3. Sign the EIP-3009 credential and retry with the X-PAYMENT header.
const payment = await buildEip3009Payment({ account, requirements: requirement, resourceUrl: url });
const paid = await fetch(url, { headers: { 'X-PAYMENT': encodeXPayment(payment) } });
console.log(await paid.json());                 // the oracle signal
console.log(paid.headers.get('x-payment-response')); // the settlement receipt
```

## 3. Our agents paying any MPP endpoint (`mpp-buyer.js`)

Use `mppFetch` — it wraps the whole 402 → sign → retry loop, enforces a **hard
spend cap**, and matches the ergonomics of our existing `buyerFetch`:

```js
import { mppFetch } from '../api/_lib/bnb/mpp-buyer.js';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.BNB_TESTNET_DEPLOYER_KEY);

const res = await mppFetch('https://three.ws/api/x402/three-intel', { method: 'GET' }, {
  account,
  maxSpend: '20000',     // atomic units — a quote above this is REFUSED, unpaid
  network: 'eip155:97',  // BSC testnet (default target)
});

if (res.ok) {
  console.log(res.result);      // the endpoint's JSON body
  console.log(res.settlement);  // decoded X-PAYMENT-RESPONSE
} else if (res.abort) {
  console.log('did not pay:', res.code, res.reason); // e.g. over_budget
}
```

`maxSpend` is enforced **before any signature** — an over-quote returns
`{ ok:false, abort:true, code:'over_budget' }` with zero network payment. The same
symbol is re-exported from `api/_lib/x402-buyer-fetch.js`, so an agent that
already imports the x402 buyer gets the MPP buyer from the same module.

## 4. Gasless sends via MegaFuel (`megafuel.js`)

BNB Chain can sponsor gas at the block-building layer (BEP-414 paymaster +
BEP-322 atomic bundles), so a **plain private-key EOA** can send a transaction
that pays **zero gas** — no smart account, no EIP-7702 delegation. This is
mechanically impossible on Ethereum L1 / Base. The production implementation is
NodeReal's **MegaFuel**.

```js
import { sendGasless } from '../api/_lib/bnb/megafuel.js';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.BNB_TESTNET_DEPLOYER_KEY);

const { hash, mode } = await sendGasless('bscTestnet', {
  account,
  tx: { to: '0x000000000000000000000000000000000000dEaD', value: 0n },
});
// mode === 'sponsored'  → MegaFuel paid the gas (tx signed with gasPrice 0)
// mode === 'self-pay'   → no sponsor policy / MegaFuel down → normal gas, still sent
```

### Honest caveats (do not oversell these)

- **MegaFuel is operated by one company** (NodeReal), and BEP-414 is still a
  *Draft* spec. `sendGasless` therefore **always** carries a self-pay fallback:
  if the sponsor declines or the endpoint is down, the same send goes through
  with normal gas rather than failing. The gasless path is an optimization, not a
  guarantee.
- Sponsorship needs a **provisioned sponsor policy** whitelisting your sender.
  Without one, `pm_isSponsorable` returns `false` and every send self-pays — the
  feature still works end-to-end. Provision a policy at
  [dashboard.nodereal.io](https://dashboard.nodereal.io) (MegaFuel product).
- BNB Chain's ~0.45s blocks are **verified live**; "20,000 TPS" and a chain-level
  "AI agent framework" are roadmap promises we do **not** claim.

### Configuration

| Env var | Purpose | Required? |
|---|---|---|
| `X402_PAY_TO_BSC` (alias `MPP_PAY_TO_BSC`) | Merchant payout address for MPP receipts | to advertise MPP |
| `B402_BASE_URL` / `B402_CLIENT_ID` / `B402_ACCESS_TOKEN` / `B402_PRIVATE_KEY` | b402 facilitator merchant creds (RSA "Tesla" signing) | to settle MPP on-chain |
| `NODEREAL_MEGAFUEL_KEY` | MegaFuel policy-management only (not the send path) | optional |
| `BNB_TESTNET_DEPLOYER_KEY` | Funded tBNB sender for live proofs | for live sends |

Without the `B402_*` merchant credentials, `mpp-server.js` still **verifies**
incoming credentials off-chain (recover payer, pin requirements, replay-guard)
and reports `mpp_not_configured` for the on-chain settle — it never fabricates a
receipt.

---

See also: the wire contract in [`specs/x402-mpp-bridge.md`](../specs/x402-mpp-bridge.md),
and the [BNB Chain campaign context](../prompts/bnb-chain/00-CONTEXT.md) for the
full verified-facts list.

## Related

- [x402 on three.ws](/docs/x402) - the payment protocol our Solana/Base catalog runs
- [The vault](/docs/bnb-vault) - encrypted 3D models gated by an on-chain BNB Chain purchase
- [x402 Bazaar](/docs/mcp-x402-bazaar) - discovering paid services by capability and price
