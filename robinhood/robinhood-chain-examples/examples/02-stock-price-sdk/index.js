/**
 * 02 — The same read as example 01, in three lines of hoodchain.
 *
 * The SDK bundles the full 95-token registry and the Chainlink decode, so you
 * never hand-maintain an address table. Reads only — no wallet, no key.
 *
 * Run: node index.js [SYMBOL...]   (default: AAPL TSLA NVDA)
 */
import { createHoodClient, getQuote } from 'hoodchain'

const symbols = process.argv.slice(2).map((s) => s.toUpperCase())
const wanted = symbols.length ? symbols : ['AAPL', 'TSLA', 'NVDA']

const hood = createHoodClient() // mainnet 4663, public RPC, multicall batching on

for (const symbol of wanted) {
  try {
    const q = await getQuote(hood, symbol)
    console.log(`${symbol.padEnd(6)} $${q.priceUsd.toFixed(2).padStart(9)}   feed ${q.feed}   age ${(q.ageSeconds / 3600).toFixed(1)}h`)
  } catch (err) {
    // The SDK throws typed errors: UnknownSymbolError, FeedNotFoundError, StaleFeedError.
    console.log(`${symbol.padEnd(6)} —  ${err.constructor.name}: ${err.message}`)
  }
}
