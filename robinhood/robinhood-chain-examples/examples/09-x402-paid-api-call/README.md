# 09 · Pay for an API call

A metered endpoint answers an unpaid request with HTTP 402 and a
machine-readable price. This example is the client side of that exchange,
step by step: decode the challenge, sign an EIP-3009 USDG authorization for
exactly the quoted amount, retry with the `X-PAYMENT` header, and read the
settlement receipt off `X-PAYMENT-RESPONSE`. Nothing is hidden inside a
wrapper.

The endpoint being paid is a `hood-api`-shaped quote route (`/v1/quote/:symbol`)
gated by [`hood402`](https://www.npmjs.com/package/hood402)'s `paywall()`. By
default this file starts one locally so the example is standalone. It is the
buy side of [example 10](../10-x402-sell-your-api), which is the sell side.

**What it proves:** x402 on Robinhood Chain runs on USDG, which has 6 decimals
and **no** EIP-2612 `permit`, so the gasless path is EIP-3009
`transferWithAuthorization`. The payer signs; the resource server or a
facilitator broadcasts and pays the gas.

## Prerequisites

- Node ≥ 20.
- **No key needed to see the full flow.** Without
  `ROBINHOOD_CHAIN_PRIVATE_KEY` a fresh keypair is generated: the 402, the
  signature, and the on-chain verification are all still real, the payer just
  genuinely holds 0 USDG, so the server correctly reports
  `insufficient_funds`.
- To settle for real, fund a testnet wallet with USDG and set
  `ROBINHOOD_CHAIN_PRIVATE_KEY`. Faucet:
  <https://faucet.testnet.chain.robinhood.com/>

## Run

```bash
npm install
npm start                                          # local endpoint, testnet rail
node index.js --url https://api.example.com/v1/quote/AAPL
HOOD_API_URL=http://localhost:8787 node index.js   # paywall a real hood-api
ROBINHOOD_CHAIN_PRIVATE_KEY=0x... node index.js    # pay for real
```

## Expected output

```
x402 paid API call - robinhood-testnet (chain 46630)
  payer  0x387D8c3A54e1aE791a6025B2BA9Db2bED45da432  (ephemeral: no ROBINHOOD_CHAIN_PRIVATE_KEY set)
  USDG   0x7E955252E15c84f5768B83c41a71F9eba181802F  6 decimals, EIP-3009 rail
  seller 0xcc2210aff3F61eFe8EFC14236fe10ddd718C2271  (local endpoint, self-settling)
  source hoodchain getQuote on mainnet 4663
  target http://127.0.0.1:38751/v1/quote/AAPL

1. GET without payment
   HTTP 402 · x402Version 1
   price    0.01 USDG
   payTo    0xcc2210aff3F61eFe8EFC14236fe10ddd718C2271
   asset    0x7E955252E15c84f5768B83c41a71F9eba181802F
   expires  60s after payment

2. Sign an EIP-3009 authorization for exactly that amount
   from       0x387D8c3A54e1aE791a6025B2BA9Db2bED45da432
   to         0xcc2210aff3F61eFe8EFC14236fe10ddd718C2271
   value      10000 atomic (0.01 USDG)
   validAfter 1785451436   validBefore 1785451741
   nonce      0xe9c5b80b60e8857976241657997e63624ebf09f09d98d306545ef3cdbbbe824c
   signature  0xeb78586ebe14d4016a76…9474671b

3. Retry with the X-PAYMENT header
   HTTP 402
   error      The payer does not hold enough USDG to cover the payment.
```

That third step is the honest ending for an unfunded payer, and it is the
interesting one: the server verified a real signature against a real balance
and refused to settle a payment that would revert. Fund the payer and step 3
returns the quote plus a settlement tx hash instead.

## The shape of the challenge

Everything the client needs to pay arrives in the 402 body: the scheme, the
network, the asset contract, the maximum amount, and where to send it. That is
what makes x402 machine-payable. No account, no API key, and no prior
relationship, just a price an agent can read and satisfy.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
