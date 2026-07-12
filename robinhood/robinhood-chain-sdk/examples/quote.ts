/**
 * Read live Chainlink prices for Stock Tokens on Robinhood Chain mainnet.
 * No wallet or key needed — public RPC reads only.
 *
 * Run: npx tsx examples/quote.ts [SYMBOL ...]
 */
import { createHoodClient, getQuote, getMultiplier, listPricedStockTokens } from 'hoodchain'

const hood = createHoodClient()
const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['AAPL', 'TSLA', 'NVDA', 'SPY']

// Stock feeds update 24/5 — allow a week so weekend runs don't trip the staleness guard.
const maxAgeSeconds = 7 * 24 * 60 * 60

console.log(`Robinhood Chain mainnet (${hood.chain.id}) — ${listPricedStockTokens().length} priced Stock Tokens\n`)

for (const symbol of symbols) {
  const [quote, multiplier] = await Promise.all([
    getQuote(hood, symbol, { maxAgeSeconds }),
    getMultiplier(hood, symbol),
  ])
  const updated = new Date(quote.updatedAt * 1000).toISOString()
  const shares = multiplier === null ? 'n/a' : (Number(multiplier) / 1e18).toFixed(6)
  console.log(
    `${symbol.padEnd(6)} $${quote.priceUsd.toFixed(2).padStart(10)}  ` +
      `multiplier ${shares} shares/token  (feed updated ${updated})`,
  )
}
