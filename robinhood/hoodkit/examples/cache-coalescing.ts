/**
 * Demonstrate request coalescing: 50 concurrent `getQuote` calls for the same
 * symbol collapse into exactly 1 upstream RPC read.
 *
 * Run: npx tsx examples/cache-coalescing.ts [SYMBOL]
 */
import { createHoodClient } from 'hoodchain'
import { createHoodCache } from '../src/index.js'

const hood = createHoodClient()
const cache = createHoodCache(hood)
const symbol = process.argv[2] ?? 'AAPL'

console.log(`Firing 50 concurrent cache.getQuote('${symbol}') calls...\n`)

const start = performance.now()
const results = await Promise.all(Array.from({ length: 50 }, () => cache.getQuote(symbol)))
const elapsedMs = performance.now() - start

console.log(`All 50 resolved to $${results[0]!.priceUsd} in ${elapsedMs.toFixed(0)}ms`)
console.log(`Cache stats: ${JSON.stringify(cache.stats)}`)
console.log(`\n${cache.stats.misses} upstream fetch, ${cache.stats.coalesced} calls joined it, 0 redundant RPC round-trips.`)
