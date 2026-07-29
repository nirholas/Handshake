/**
 * 10 — Sell your API: put a USDG paywall in front of a Robinhood Chain endpoint.
 *
 * The whole paid endpoint is the `app.get(...)` call near the bottom: one
 * `paywall()` middleware from hood402, one handler that reads the chain with
 * hoodchain. Everything else in this file is startup wiring and a self-check
 * that proves the gate is live.
 *
 * The rail is x402 `exact` over EIP-3009 `transferWithAuthorization` on USDG
 * (6 decimals, no EIP-2612 permit). The payer signs an authorization; the
 * server (or a facilitator) broadcasts it and pays the gas. Any spec-compliant
 * x402 client can pay this endpoint — example 09 uses hood402's own.
 *
 * Run:
 *   npm start                       # boot on testnet, self-check, keep serving
 *   npm start -- --once             # boot, self-check, exit (what CI runs)
 *   HOOD402_NETWORK=robinhood npm start        # mainnet 4663 instead
 *   HOOD402_PAY_TO=0x... npm start             # your own settlement address
 *
 * Settlement modes (pick one, both real):
 *   FACILITATOR_URL=https://...     delegate verify+settle, hold no key here
 *   FACILITATOR_PRIVATE_KEY=0x...   self-settle: this process broadcasts and
 *                                   pays gas. Needs ETH on the chosen network.
 * With neither set, the server self-settles from a freshly generated gas key
 * that holds nothing: challenges and verification are fully real, and a paid
 * request stops honestly at "insufficient gas wallet" instead of pretending.
 */
import { createServer } from 'node:http'
import express from 'express'
import { paywall } from 'hood402/server'
import { requireNetwork } from 'hood402'
import { createHoodClient, getQuote, listStockTokens } from 'hoodchain'
import { createPublicClient, createWalletClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const once = process.argv.includes('--once')
const networkId = process.env.HOOD402_NETWORK ?? 'robinhood-testnet'
const net = requireNetwork(networkId)
const port = Number(process.env.PORT ?? 8010)
const priceUsdg = process.env.HOOD402_PRICE ?? '0.01'

// --- settlement wiring ------------------------------------------------------
const facilitatorUrl = process.env.FACILITATOR_URL
const gasKey = process.env.FACILITATOR_PRIVATE_KEY
const gasAccount = privateKeyToAccount(gasKey ?? generatePrivateKey())
const payTo = process.env.HOOD402_PAY_TO ?? gasAccount.address

const transport = http(net.rpcUrl)
const reader = createPublicClient({ chain: net.chain, transport })
const settlement = facilitatorUrl
  ? { facilitator: facilitatorUrl }
  : {
      wallet: createWalletClient({ account: gasAccount, chain: net.chain, transport }),
      account: gasAccount.address,
      reader,
    }

// --- the chain read the endpoint sells --------------------------------------
// Always mainnet 4663: that is where the Stock Token registry and the Chainlink
// feeds live. The payment RAIL is a separate choice (testnet by default here),
// which is exactly how you price real data without risking real USDG in a demo.
const hood = createHoodClient({ chain: 'mainnet' })

// --- the paid endpoint ------------------------------------------------------
const app = express()

app.get(
  '/v1/quote/:symbol',
  paywall({
    price: priceUsdg,
    payTo,
    network: networkId,
    description: 'Robinhood Chain Stock Token quote: Chainlink oracle price, feed, and freshness.',
    ...settlement,
  }),
  async (req, res) => {
    try {
      const quote = await getQuote(hood, req.params.symbol)
      res.json({
        symbol: quote.symbol,
        priceUsd: quote.priceUsd,
        feed: quote.feed,
        updatedAt: quote.updatedAt,
        ageSeconds: quote.ageSeconds,
        network: hood.network,
      })
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) })
    }
  },
)

// A free route, so the paywall is visibly scoped to what you charge for.
app.get('/v1/symbols', (_req, res) => {
  res.json({ count: listStockTokens().length, symbols: listStockTokens().map((t) => t.symbol) })
})

const server = createServer(app)
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${port}`

console.log(`hood402 paid endpoint — ${net.id} (chain ${net.chainId})`)
console.log(`  paid : GET ${base}/v1/quote/:symbol   ${priceUsdg} USDG`)
console.log(`  free : GET ${base}/v1/symbols`)
console.log(`  payTo: ${payTo}`)
console.log(
  `  settle: ${facilitatorUrl ? `facilitator ${facilitatorUrl}` : gasKey ? 'self-settle (FACILITATOR_PRIVATE_KEY)' : 'self-settle (ephemeral unfunded gas key)'}`,
)
console.log(`  USDG : ${net.usdg}`)
console.log(`  data : mainnet 4663 Chainlink feeds (reads are free and public)`)

// --- self-check: hit our own paid route unpaid and show the real challenge ---
const unpaid = await fetch(`${base}/v1/quote/AAPL`)
const challenge = await unpaid.json()
const accepts = challenge.accepts[0]
console.log(`\nGET /v1/quote/AAPL with no payment -> HTTP ${unpaid.status}`)
console.log(`  x402Version   ${challenge.x402Version}`)
console.log(`  scheme        ${accepts.scheme}`)
console.log(`  network       ${accepts.network}`)
console.log(`  asset         ${accepts.asset}  (USDG, 6 decimals)`)
console.log(`  maxAmount     ${accepts.maxAmountRequired} atomic = ${Number(accepts.maxAmountRequired) / 1e6} USDG`)
console.log(`  payTo         ${accepts.payTo}`)
console.log(`  description   ${accepts.description}`)

const free = await fetch(`${base}/v1/symbols`)
const symbols = await free.json()
console.log(`\nGET /v1/symbols (free) -> HTTP ${free.status}, ${symbols.count} Stock Tokens, no payment required`)

if (once) {
  server.close()
  console.log('\n--once: self-check done, shutting down. Drop the flag to keep serving.')
} else {
  console.log(`\nServing. Pay it with example 09, or any x402 client. Ctrl-C to stop.`)
  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
