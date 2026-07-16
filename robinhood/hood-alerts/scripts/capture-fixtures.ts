#!/usr/bin/env tsx
/**
 * Capture real Robinhood Chain (mainnet 4663) event streams into
 * tests/fixtures/*.json so the detector unit tests run against genuine
 * on-chain data, not invented samples. Re-run to refresh:
 *
 *   npm run capture-fixtures
 *
 * Everything read here is public and read-only. bigints serialize as strings
 * (see the `replacer`); the tests re-hydrate them.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ODYSSEY_ADDRESSES,
  createHoodClient,
  listPricedStockTokens,
  odysseyTradedEvent,
  watchCurveTrades,
  MAINNET_ADDRESSES,
  type CurveTrade,
} from 'hoodchain'
import { discoverPools, streamPrices, streamSwaps, type PoolInfo, type PriceTick, type SwapEvent } from 'hoodkit'
import type { Address } from 'viem'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures')

const replacer = (_key: string, value: unknown): unknown => (typeof value === 'bigint' ? value.toString() : value)

function writeFixture(name: string, data: unknown): void {
  mkdirSync(FIXTURES, { recursive: true })
  writeFileSync(join(FIXTURES, name), `${JSON.stringify(data, replacer, 2)}\n`)
  console.log(`wrote tests/fixtures/${name}`)
}

async function ethUsdFromBlockscout(): Promise<number | null> {
  try {
    const res = await fetch('https://robinhoodchain.blockscout.com/api/v2/stats', { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const body = (await res.json()) as { coin_price?: string | null }
    const p = body.coin_price ? Number(body.coin_price) : NaN
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

async function captureSwaps(client: ReturnType<typeof createHoodClient>): Promise<void> {
  const bn = await client.public.getBlockNumber()
  const stocks = listPricedStockTokens()
  const collected: Array<{ poolInfo: PoolInfo; symbol: string; token: Address; swaps: SwapEvent[] }> = []
  let total = 0
  for (const stock of stocks) {
    if (total >= 12) break
    const pools = await discoverPools(client, stock.address).catch(() => [] as PoolInfo[])
    if (pools.length === 0) continue
    const stream = await streamSwaps(client, { token: stock.address }, { fromBlock: bn - 300_000n, chunkSize: 10_000n })
    const swaps: SwapEvent[] = []
    stream.on('data', (s) => swaps.push(s))
    await new Promise((r) => setTimeout(r, 9000))
    stream.close()
    if (swaps.length > 0) {
      const info = pools.find((p) => swaps.some((s) => s.pool.toLowerCase() === p.pool.toLowerCase())) ?? pools[0]
      collected.push({ poolInfo: info as PoolInfo, symbol: stock.symbol, token: stock.address, swaps: swaps.slice(-8) })
      total += swaps.length
      console.log(`  ${stock.symbol}: ${swaps.length} swaps captured`)
    }
  }
  const ethUsd = await ethUsdFromBlockscout()
  writeFixture('swaps.json', {
    capturedAt: new Date().toISOString(),
    chainId: 4663,
    blockNumber: bn.toString(),
    weth: MAINNET_ADDRESSES.weth,
    usdg: MAINNET_ADDRESSES.usdg,
    ethUsd,
    pools: collected,
  })
}

async function capturePrices(client: ReturnType<typeof createHoodClient>): Promise<void> {
  const stocks = listPricedStockTokens()
  const symbols = stocks.map((s) => s.symbol)
  const stream = streamPrices(client, symbols)
  const ticks = new Map<string, PriceTick>()
  stream.on('data', (t) => ticks.set(t.symbol, t))
  await new Promise((r) => setTimeout(r, 8000))
  stream.close()
  const snapshot = [...ticks.values()].map((t) => ({ symbol: t.symbol, priceUsd: t.priceUsd, feed: t.feed, roundId: t.roundId.toString(), updatedAt: t.updatedAt }))
  writeFixture('prices.json', { capturedAt: new Date().toISOString(), chainId: 4663, count: snapshot.length, prices: snapshot })
}

async function captureCurveTrades(client: ReturnType<typeof createHoodClient>): Promise<void> {
  const bn = await client.public.getBlockNumber()
  const factories = [ODYSSEY_ADDRESSES.bondingCurveFactory, ODYSSEY_ADDRESSES.reflectionFactory, ODYSSEY_ADDRESSES.legacyFactory]
  const trades: CurveTrade[] = []
  // Historical scan of the Odyssey `Traded` event across recent chunks.
  const span = 400_000n
  const chunk = 20_000n
  for (let from = bn - span; from <= bn && trades.length < 8; from += chunk) {
    const to = from + chunk - 1n > bn ? bn : from + chunk - 1n
    for (const factory of factories) {
      const logs = await client.public
        .getLogs({ address: factory, event: odysseyTradedEvent, fromBlock: from, toBlock: to })
        .catch(() => [])
      for (const log of logs) {
        const a = log.args as { token?: Address; trader?: Address; isBuy?: boolean; tokenAmount?: bigint; quoteAmount?: bigint; fee?: bigint }
        if (!a.token || !a.trader || a.tokenAmount === undefined) continue
        trades.push({
          launchpad: 'odyssey',
          token: a.token,
          trader: a.trader,
          isBuy: Boolean(a.isBuy),
          tokenAmount: a.tokenAmount,
          quoteAmount: a.quoteAmount ?? 0n,
          fee: a.fee ?? 0n,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        })
        if (trades.length >= 8) break
      }
    }
  }
  // If the historical scan came up empty, listen live for a short window.
  if (trades.length === 0) {
    const stop = watchCurveTrades(client, (t) => trades.push(t))
    await new Promise((r) => setTimeout(r, 12_000))
    stop()
  }
  const ethUsd = await ethUsdFromBlockscout()
  writeFixture('curve-trades.json', {
    capturedAt: new Date().toISOString(),
    chainId: 4663,
    ethUsd,
    note: trades.length === 0 ? 'No Odyssey bonding-curve trades in the captured window; launchpad was idle.' : undefined,
    trades,
  })
}

async function main(): Promise<void> {
  const client = createHoodClient({})
  console.log('capturing real mainnet 4663 fixtures...')
  await capturePrices(client)
  await captureSwaps(client)
  await captureCurveTrades(client)
  console.log('done')
  process.exit(0)
}

main().catch((error) => {
  console.error('capture failed:', error)
  process.exit(1)
})
