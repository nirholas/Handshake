# hood-pay demo shop

A tiny, real merchant that sells one digital good for USDG on Robinhood Chain,
wiring together every hood-pay piece with no mocks: the embeddable **widget**,
the idempotent **SQLite ledger**, the reorg-safe **verifier**, and **signed
webhooks**.

## What it demonstrates

1. `POST /api/checkout` reserves a unique fingerprinted amount in the ledger
   (direct mode) and starts an on-chain watcher for that exact amount.
2. The buyer pays in the widget - a plain USDG `transfer` of `base + dust`.
3. The watcher confirms the transfer **on-chain** (never from the browser),
   records it idempotently, and fires a **signed** webhook.
4. `POST /hooks/hood-pay` (the shop's own receiver) verifies the HMAC signature
   before trusting the event, then unlocks the download.
5. The page polls `GET /api/checkout/:id` until `status = paid` and reveals the
   good.

## Run

```bash
npm install          # installs express, viem, and hood-pay (from ../.. via file:)
npm start            # http://localhost:8788  (defaults to testnet 46630)
```

Then open the printed URL, click **Buy now**, connect an EIP-6963 wallet
(MetaMask, Rabby, …), switch to Robinhood Chain when prompted, and pay the exact
fingerprinted amount. The server log prints the verified webhook and the page
reveals the good.

Requires Node >= 22.5 (the ledger uses the built-in `node:sqlite`; on Node 22
start with `node --experimental-sqlite server.js`).

## Configure

All optional - sensible testnet defaults are baked in.

| Env | Default | Purpose |
| --- | --- | --- |
| `NETWORK` | `testnet` | `mainnet` (4663) or `testnet` (46630) |
| `MERCHANT_ADDRESS` | project address | where funds land |
| `TOKEN_ADDRESS` | USDG on `NETWORK` | the ERC-20 you accept |
| `TOKEN_SYMBOL` / `TOKEN_DECIMALS` | `USDG` / `6` | display + math for the token |
| `PRICE` | `1.00` | decimal price (<= 2 dp for direct mode) |
| `PORT` | `8788` | http port |
| `WEBHOOK_SECRET` | a demo secret | HMAC secret for webhook signatures |
| `WEBHOOK_URL` | this shop's `/hooks/hood-pay` | point at your real receiver |

> Testnet has faucet Stock Tokens and test USDG. If your test wallet holds a
> faucet Stock Token rather than test USDG, set `TOKEN_ADDRESS` /
> `TOKEN_SYMBOL` / `TOKEN_DECIMALS` to that token - the router and verifier are
> token-agnostic. Stock Tokens are securities and are used here only as a
> convenient testnet ERC-20; do not resell them.

## Notes

- The shop holds **no private keys**. It only reads the chain and reserves
  invoice amounts. The buyer's wallet signs the payment.
- Refunds (overage or abandoned invoices) use the merchant's own wallet via
  `hood-pay/verify`'s refund helpers - see `../../docs/verify.html`.

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
