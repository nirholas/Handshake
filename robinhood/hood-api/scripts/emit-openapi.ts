import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/app.js'

/** Regenerates `openapi.json` from the live route definitions. Run after any route change. */
const app = createApp()
const doc = app.getOpenAPI31Document({
  openapi: '3.1.0',
  info: {
    title: 'hood-api',
    version: '0.1.0',
    description:
      'Hosted market-data API for Robinhood Chain (chain ID 4663): Stock Tokens with Chainlink + DEX ' +
      'premium/discount, memecoin launchpads, multiplier-correct portfolios, cross-venue tokenized-equity ' +
      'spreads, and a real-time firehose. Free tier is IP-rate-limited; paid endpoints are metered via x402.',
    license: { name: 'MIT' },
    contact: { name: 'nirholas', url: 'https://x.com/nichxbt' },
  },
  servers: [{ url: 'https://hood-api.example.com', description: 'Production (replace with your deployment URL)' }],
})

const outPath = fileURLToPath(new URL('../openapi.json', import.meta.url))
writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n')
console.log(`wrote ${outPath}`)
