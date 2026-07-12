/**
 * Minimal standalone example: an Express resource server that charges USDG
 * for a route, settling through a remote hood402 facilitator.
 *
 * Run with `npm run demo:server` after starting a facilitator (see
 * `facilitator/README.md`), then:
 *
 *   curl -i http://localhost:8787/premium
 *   # -> 402 Payment Required, with an `accepts` array describing the price
 *
 * A hood402 client (see `hood402/client`) completes the payment automatically.
 */
import express from 'express'
import { paywall } from '../src/server/index.js'

const PORT = Number(process.env['DEMO_PORT'] ?? 8787)
const FACILITATOR_URL = process.env['FACILITATOR_URL'] ?? 'http://localhost:4021'
const PAY_TO = process.env['DEMO_PAY_TO']

if (!PAY_TO) {
  console.error('Set DEMO_PAY_TO to the address that should receive payments.')
  process.exit(1)
}

const app = express()

app.get(
  '/premium',
  paywall({
    price: '0.01',
    payTo: PAY_TO as `0x${string}`,
    network: 'robinhood-testnet',
    description: 'hood402 demo — premium market snapshot',
    facilitator: FACILITATOR_URL,
  }),
  (_req, res) => {
    res.json({
      snapshot: 'this is the paid resource — you only see this after a settled USDG payment',
      generatedAt: new Date().toISOString(),
    })
  },
)

app.listen(PORT, () => {
  console.log(`hood402 demo server listening on :${PORT}`)
  console.log(`  GET http://localhost:${PORT}/premium  ($0.01 USDG, robinhood-testnet)`)
  console.log(`  facilitator: ${FACILITATOR_URL}`)
})
