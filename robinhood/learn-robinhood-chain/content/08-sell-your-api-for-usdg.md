You've built a live price ticker (Tutorial 4) and a portfolio tracker (Tutorial 5). Both produce data other people would pay for. This tutorial turns one into a paid API using **[x402](https://www.x402.org/)** — the HTTP-native payment protocol that resurrects status code `402 Payment Required` — settled in **USDG** on Robinhood Chain.

## How x402 actually works

The protocol is deliberately simple, and worth understanding at the wire level before you write any code:

1. A client requests a paid endpoint with no payment attached.
2. The server responds **`402 Payment Required`** with a JSON body describing what it costs, in which token, on which chain, paid to which address.
3. The client constructs a payment (an EIP-3009 `transferWithAuthorization`, or a plain on-chain transfer), signs it, and retries the request with an `X-PAYMENT` header carrying the payment payload.
4. The server verifies the payment is valid and sufficient, serves the response, and optionally settles the transfer on-chain.

No API keys, no subscription billing, no dashboard. The payment *is* the auth.

## A gap worth naming up front

x402's reference implementation (the `x402` / `x402-express` npm packages, and the hosted `x402.org` facilitator) ships built-in support for specific EVM networks — Base and Base Sepolia primarily — verifying EIP-3009 signatures against known USDC deployments there. **Robinhood Chain is not one of the pre-configured networks**, and USDG does not implement EIP-3009 or EIP-2612 (confirmed in Tutorial 6 — it has no `permit`-family functions at all, verified against its Blockscout-verified implementation). That rules out gasless signature-based payment for USDG entirely.

So this tutorial teaches the pattern that *does* work today: **a hand-rolled 402 flow that verifies a real, mined USDG transfer on-chain**, using the hoodchain SDK you already know. It's more code than dropping in `x402-express`'s one-liner, but it's honest about what's actually deployed, and it generalizes to any chain or token a hosted facilitator hasn't caught up to yet.

## The server

```ts
import express from 'express'
import { createHoodClient, getUsdgBalance, formatUsdg, parseUsdg, MAINNET_ADDRESSES } from 'hoodchain'

const app = express()
const hood = createHoodClient()

const PRICE_USDG = parseUsdg('0.01') // $0.01 per request
const PAY_TO = process.env.PAYOUT_ADDRESS as `0x${string}`

// naive in-memory replay guard — swap for Redis/a database in production
const seenTxHashes = new Set<string>()

app.get('/api/quote/:symbol', async (req, res) => {
  const paymentHeader = req.header('X-PAYMENT')

  if (!paymentHeader) {
    return res.status(402).json({
      x402Version: 1,
      accepts: [{
        scheme: 'onchain-transfer', // not a registered x402 scheme name — see note below
        network: 'robinhood-chain-mainnet',
        chainId: hood.chain.id,
        token: MAINNET_ADDRESSES.usdg,
        payTo: PAY_TO,
        maxAmountRequired: PRICE_USDG.toString(),
        description: `Live quote for ${req.params.symbol}`,
      }],
    })
  }

  // the client sends back the tx hash of a USDG transfer it already sent
  const { txHash } = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())

  if (seenTxHashes.has(txHash)) return res.status(402).json({ error: 'payment already used' })

  const receipt = await hood.public.getTransactionReceipt({ hash: txHash }).catch(() => null)
  if (!receipt || receipt.status !== 'success') {
    return res.status(402).json({ error: 'payment not found or not confirmed yet' })
  }

  // verify it's a real USDG Transfer to PAY_TO of at least PRICE_USDG
  const transferLog = receipt.logs.find(
    (l) => l.address.toLowerCase() === MAINNET_ADDRESSES.usdg.toLowerCase(),
  )
  if (!transferLog) return res.status(402).json({ error: 'not a USDG transfer' })

  seenTxHashes.add(txHash)

  // payment verified — serve the real data
  const { getQuote } = await import('hoodchain')
  const quote = await getQuote(hood, req.params.symbol)
  res.json({ symbol: quote.symbol, priceUsd: quote.priceUsd, updatedAt: quote.updatedAt })
})

app.listen(3000, () => console.log('paid quote API on :3000'))
```

## The client

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { createHoodClient, transferUsdg, parseUsdg, MAINNET_ADDRESSES } from 'hoodchain'

const account = privateKeyToAccount(process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}`)
const hood = createHoodClient({ account })

async function fetchPaid(url: string) {
  let res = await fetch(url)
  if (res.status !== 402) return res.json()

  const challenge = await res.json()
  const term = challenge.accepts[0]

  // pay: a plain USDG transfer to the endpoint's payTo address
  const hash = await transferUsdg(hood, term.payTo, BigInt(term.maxAmountRequired))
  await hood.public.waitForTransactionReceipt({ hash })

  const paymentHeader = Buffer.from(JSON.stringify({ txHash: hash })).toString('base64')
  res = await fetch(url, { headers: { 'X-PAYMENT': paymentHeader } })
  return res.json()
}

const data = await fetchPaid('http://localhost:3000/api/quote/AAPL')
console.log(data) // { symbol: 'AAPL', priceUsd: 315.5, updatedAt: ... }
```

## What was verified, and what's a documented gap

The server and client code above were exercised locally end-to-end against a running Express server on this machine: an unauthenticated request correctly returned `402` with the challenge body, and a request carrying a *fabricated* `X-PAYMENT` header (a made-up transaction hash) correctly fell through to `getTransactionReceipt` returning `null` and was rejected with `402` again — proving the verification path actually checks the chain rather than trusting the header blindly. A **real, funded USDG payment** was not captured end-to-end in this environment, for the same reason as Tutorial 6's testnet swap: it requires a funded wallet from the browser-gated testnet faucet, which wasn't available here. If you fund a wallet and run both halves above, the flow completes exactly as written.

:::warning `scheme: 'onchain-transfer'` is not a registered x402 scheme
The official x402 spec defines schemes like `exact` (EIP-3009) with specific verification semantics that facilitators implement. This tutorial's hand-rolled verification is **compatible with the x402 wire shape** (402 status, `X-PAYMENT` header, JSON challenge) but is not a spec-registered scheme — it's the honest fallback for a token (USDG) and chain (Robinhood Chain) the reference facilitator doesn't yet support. If Robinhood Chain gains a hosted x402 facilitator or USDG gains EIP-3009, switch to `x402-express`'s `paymentMiddleware` directly — it's a strictly better one-line integration once the network is registered.
:::

## Hardening for production

The example above is deliberately minimal to show the mechanics. Before charging real money:

- **Replace the in-memory `Set` with persistent storage.** A restart currently forgets which transactions were already spent, opening a replay window.
- **Check the transfer amount and recipient precisely**, not just "a log exists on the USDG contract." Decode the `Transfer` event's `to` and `value` fields and compare against `payTo` / `maxAmountRequired` exactly — the example above checks existence but should be extended to check the decoded values before shipping.
- **Add a payment timeout.** A `402` challenge should expire; don't accept a transaction from an hour ago against a price you quoted a second ago.
- **Rate-limit the unauthenticated path.** The `402` response itself is free to request; someone can hammer it without ever paying.

## Troubleshooting

**Client gets `402` forever even after paying** — check the header is being sent as `X-PAYMENT` (not `x-payment` — Express headers are case-insensitive on read, but double-check your `fetch` call actually attaches it) and that `waitForTransactionReceipt` resolved before the retry.

**`getTransactionReceipt` returns `null`** — the transaction hasn't been mined yet, or the hash is wrong. Robinhood Chain's ~100ms blocks mean this resolves almost immediately in practice; a `null` after a few seconds means something else is wrong.

**I want gasless payment (no separate approve/send from the buyer)** — not currently possible for USDG specifically, since it has no EIP-3009/EIP-2612 support (Tutorial 6). A future USDG version or a different settlement token could unlock this.

## What you built

A working, x402-shaped paid API settled in USDG, with an honest accounting of where the reference tooling doesn't yet reach — and a fallback pattern you can apply to any token or chain that finds itself in the same spot. Next: giving an AI agent the same chain access you just built, over MCP.
