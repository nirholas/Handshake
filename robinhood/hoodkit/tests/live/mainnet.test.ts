/**
 * Live integration tests — real reads/streams against Robinhood Chain mainnet
 * (public RPC, no key needed). Run with `npm run test:live`.
 *
 * Target: the WETH/WEN Uniswap v3 pool (0.3% tier), a NOXA-launched memecoin
 * ("Wen Lambo") that is one of the most actively-traded pools on the chain at
 * the time this suite was written — verified live via Blockscout before
 * selecting it (recent SwapRouter02 transactions land every 1-2 seconds).
 * Re-verify liveliness if this suite goes stale: any actively-traded NOXA/
 * Odyssey-graduated pool works as a drop-in replacement.
 */
import { describe, expect, it } from 'vitest'
import { createHoodClient } from 'hoodchain'
import { unlinkSync } from 'node:fs'
import {
  streamSwaps,
  streamPrices,
  loadPoolInfo,
  createIndexer,
  createHoodCache,
  plan,
} from '../../src/index.js'

const hood = createHoodClient()

const WEN_TOKEN = '0xA80eb66b3E0CF66ccB46f8b8C9e7ff5803eEb820' as const
const WEN_WETH_POOL = '0x3F98045d6bc0fEF56bf69E85F1efA7F5100e7c48' as const
/** Exact deployment block of the WEN token, resolved via `eth_getTransactionReceipt`
 * on its creation tx (Blockscout `creation_transaction_hash`) — the correct
 * starting point for a holder-count-accurate full backfill. */
const WEN_DEPLOY_BLOCK = 4_774_733n

describe('live: chain identity', () => {
  it('the public RPC is chain 4663', async () => {
    expect(hood.chain.id).toBe(4663)
    expect(await hood.public.getChainId()).toBe(4663)
  })
})

describe('live: streamSwaps — 60s of real mainnet swaps on a busy pool', () => {
  it('receives real Swap events on the WETH/WEN pool within 60 seconds', async () => {
    const info = await loadPoolInfo(hood, WEN_WETH_POOL)
    expect(info.token0.toLowerCase()).toBe('0x0bd7d308f8e1639fab988df18a8011f41eacad73') // WETH
    expect(info.token1.toLowerCase()).toBe(WEN_TOKEN.toLowerCase())

    const stream = await streamSwaps(hood, { pool: WEN_WETH_POOL }, { pollingIntervalMs: 1500 })
    const events: number[] = []
    let volumeToken = 0
    stream.on('data', (swap) => {
      events.push(Number(swap.blockNumber))
      volumeToken += swap.volume1 // WEN is token1
    })

    await new Promise((resolve) => setTimeout(resolve, 60_000))
    stream.close()

    // eslint-disable-next-line no-console
    console.log(`[live] streamSwaps: ${events.length} real Swap events in 60s on ${WEN_WETH_POOL}, ~${volumeToken.toFixed(0)} WEN volume`)
    expect(events.length).toBeGreaterThan(0)
    expect(stream.dropped).toBe(0) // 60s of a ~1-swap/15s pool never approaches the default buffer
  }, 90_000)
})

describe('live: streamPrices — real Chainlink feed ticks', () => {
  it('gets a real AAPL price tick from the live feed', async () => {
    const stream = streamPrices(hood, ['AAPL'], { pollingIntervalMs: 2000 })
    const tick = await new Promise<{ priceUsd: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no price tick within 15s')), 15_000)
      stream.on('data', (t) => {
        clearTimeout(timeout)
        resolve(t)
      })
    })
    stream.close()
    expect(tick.priceUsd).toBeGreaterThan(50)
    expect(tick.priceUsd).toBeLessThan(2000)
  }, 20_000)
})

describe('live: createHoodCache — coalescing over a real feed read', () => {
  it('collapses 20 concurrent live getQuote calls into 1 upstream fetch', async () => {
    const cache = createHoodCache(hood)
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.getQuote('AAPL')))
    expect(cache.stats.misses).toBe(1)
    expect(cache.stats.coalesced).toBe(19)
    for (const r of results) expect(r.priceUsd).toBeGreaterThan(0)
  }, 20_000)
})

describe('live: batch plan() — real multicall against mainnet', () => {
  it('reads WEN balanceOf for several real holders in one multicall', async () => {
    const holders = [
      '0x03c1F47384f5B135C61dbb285A0DE2EC6C24B366',
      '0x99328671ac28a6e1c2B7c321f77ad0fFa796D370',
      '0x3dc06F9D6bc88cc383BBdba79C746C8fa70A9A3a',
    ] as const
    const erc20Abi = [
      { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    ] as const
    const results = await plan<bigint>(
      hood,
      holders.map((h) => ({ address: WEN_TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [h] })),
    )
    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.status).toBe('success')
      if (r.status === 'success') expect(r.result).toBeGreaterThan(0n)
    }
  }, 20_000)
})

describe('live: Indexer — full holder-history backfill vs Blockscout', () => {
  it(
    'matches Blockscout holder count within documented tolerance, and builds real OHLCV candles',
    async () => {
      const dbPath = `/tmp/hoodkit-live-wen-${Date.now()}.sqlite`
      const indexer = await createIndexer({
        client: hood,
        path: dbPath,
        tokens: [WEN_TOKEN],
        chunkSize: 50_000n,
      })
      try {
        const head = await hood.public.getBlockNumber()
        // Full transfer history is required for an accurate absolute holder
        // count (a partial window only ever under-counts). Swap history is
        // bounded to the last ~50k blocks (~1.8h) — plenty for real OHLCV
        // candles without re-scanning the pool's entire multi-day trade log.
        const result = await indexer.sync({ fromBlock: WEN_DEPLOY_BLOCK, swapFromBlock: head - 50_000n })

        // eslint-disable-next-line no-console
        console.log(
          `[live] indexer sync: ${result.transfersIndexed} transfers, ${result.swapsIndexed} swaps, ` +
            `${result.timestampsFetched} block timestamps fetched (head ${result.head})`,
        )
        expect(result.transfersIndexed).toBeGreaterThan(0)

        const ourHolders = indexer.holderCount(WEN_TOKEN)
        const blockscout = (await fetch(
          `https://robinhoodchain.blockscout.com/api/v2/tokens/${WEN_TOKEN}/counters`,
        ).then((r) => r.json())) as { token_holders_count: string }
        const theirHolders = Number(blockscout.token_holders_count)

        // eslint-disable-next-line no-console
        console.log(`[live] holder count: hoodkit indexer=${ourHolders}, Blockscout=${theirHolders}`)

        // Tolerance: both counts are live snapshots taken seconds apart on a
        // token with active trading, so a handful of holders can cross the
        // zero-balance line between the two reads. 2% (min 5) covers normal
        // drift while still catching a broken balance calculation.
        const tolerance = Math.max(5, Math.ceil(theirHolders * 0.02))
        expect(Math.abs(ourHolders - theirHolders)).toBeLessThanOrEqual(tolerance)

        const candles = indexer.candles(WEN_TOKEN, '5m')
        // eslint-disable-next-line no-console
        console.log(`[live] built ${candles.length} real 5m candles from indexed swaps`)
        if (result.swapsIndexed > 0) {
          expect(candles.length).toBeGreaterThan(0)
          for (const c of candles) {
            expect(c.high).toBeGreaterThanOrEqual(c.low)
            expect(c.volume).toBeGreaterThanOrEqual(0)
          }
        }

        const vol = indexer.volume24h(WEN_TOKEN, Number(BigInt((await hood.public.getBlock({ blockNumber: head })).timestamp)))
        expect(vol).toBeGreaterThanOrEqual(0)
      } finally {
        indexer.close()
        try {
          unlinkSync(dbPath)
          unlinkSync(`${dbPath}-wal`)
          unlinkSync(`${dbPath}-shm`)
        } catch {
          // best-effort cleanup of SQLite sidecar files
        }
      }
    },
    120_000,
  )
})
