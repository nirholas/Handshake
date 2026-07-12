/**
 * Capture a real, timestamped snapshot of live Robinhood Chain market state —
 * stock quotes, spot prices for a few known tokens, and current block — into
 * `tests/snapshots/`. Snapshots are INPUTS to deterministic strategy unit
 * tests (recorded market data, not a live mock): they let the launch-sniper /
 * momentum / premium-watch decision logic be tested against real numbers
 * without a live RPC call on every `npm test` run.
 *
 * Run: npm run snapshot
 */
import { writeFileSync } from 'node:fs'
import { createHoodClient, getQuote, listPricedStockTokens, MAINNET_ADDRESSES } from 'hoodchain'
import { quoteSwap } from 'hoodchain'
import { formatUnits, parseUnits } from 'viem'

async function main() {
  const hood = createHoodClient({ chain: 'mainnet' })
  const blockNumber = await hood.public.getBlockNumber()
  const ts = Date.now()

  const symbols = listPricedStockTokens().slice(0, 8)
  const quotes = await Promise.all(
    symbols.map(async (t) => {
      try {
        const q = await getQuote(hood, t.symbol)
        return { symbol: t.symbol, address: t.address, priceUsd: q.priceUsd, ageSeconds: q.ageSeconds, roundId: q.roundId.toString() }
      } catch (e) {
        return { symbol: t.symbol, address: t.address, error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )

  // ETH/USD reference from the live USDG/WETH pool.
  let ethUsd: number | null = null
  try {
    const probe = parseUnits('0.01', 18)
    const q = await quoteSwap(hood, { tokenIn: MAINNET_ADDRESSES.weth, tokenOut: MAINNET_ADDRESSES.usdg, amountIn: probe })
    ethUsd = Number(formatUnits(q.amountOut, 6)) / 0.01
  } catch {
    ethUsd = null
  }

  // Spot price for a handful of priced Stock Tokens via WETH route (proves the
  // Uniswap route-probing path, distinct from the Chainlink path above).
  const spotSamples = await Promise.all(
    symbols.slice(0, 3).map(async (t) => {
      try {
        const probe = parseUnits('1', 18)
        const q = await quoteSwap(hood, { tokenIn: t.address, tokenOut: MAINNET_ADDRESSES.usdg, amountIn: probe })
        return { symbol: t.symbol, address: t.address, dexPriceUsd: Number(formatUnits(q.amountOut, 6)) }
      } catch (e) {
        return { symbol: t.symbol, address: t.address, error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )

  const snapshot = {
    capturedAt: ts,
    network: 'mainnet',
    chainId: 4663,
    blockNumber: blockNumber.toString(),
    ethUsd,
    quotes,
    spotSamples,
  }

  const path = `tests/snapshots/mainnet-${ts}.json`
  writeFileSync(path, JSON.stringify(snapshot, null, 2))
  writeFileSync('tests/snapshots/latest.json', JSON.stringify(snapshot, null, 2))
  console.log(`captured snapshot at block ${blockNumber} → ${path}`)
  console.log(JSON.stringify(snapshot, null, 2))
}

main().catch((err) => {
  console.error('snapshot capture failed:', err)
  process.exit(1)
})
