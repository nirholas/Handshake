/**
 * Batch many independent reads into the fewest possible Multicall3 round-trips.
 *
 * Run: npx tsx examples/batch-plan.ts
 */
import { createHoodClient, listStockTokens, erc20Abi } from 'hoodchain'
import { plan } from '../src/index.js'

const hood = createHoodClient()
const tokens = listStockTokens()

console.log(`Reading totalSupply() for all ${tokens.length} Stock Tokens in one plan()...\n`)

const start = performance.now()
const results = await plan<bigint>(
  hood,
  tokens.map((t) => ({ address: t.address, abi: erc20Abi, functionName: 'totalSupply' })),
)
const elapsedMs = performance.now() - start

results.forEach((r, i) => {
  const token = tokens[i]!
  if (r.status === 'success') {
    console.log(`${token.symbol.padEnd(6)} totalSupply = ${(Number(r.result) / 1e18).toLocaleString()} tokens`)
  } else {
    console.log(`${token.symbol.padEnd(6)} FAILED: ${r.error.message}`)
  }
})

const ok = results.filter((r) => r.status === 'success').length
console.log(`\n${ok}/${tokens.length} reads succeeded in ${elapsedMs.toFixed(0)}ms across a handful of multicall round-trips.`)
