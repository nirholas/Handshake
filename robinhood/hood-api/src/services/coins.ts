import { getAddress, isAddress, type Address } from 'viem'
import { getRecentLaunches, type Launch } from 'hoodchain'
import { cached, TTL } from '../lib/cache.js'
import { ApiError } from '../lib/errors.js'
import { pMap } from '../lib/pmap.js'
import { SOURCE, withMeta } from '../lib/response.js'
import { mainnetClient } from '../upstreams/rpc.js'
import { getBulkDexStats, getDexStats } from '../upstreams/dex.js'
import * as blockscout from '../upstreams/blockscout.js'
import { getChain, ethPriceUsd } from './chain.js'
import { COINS_LOOKBACK } from './launches.js'

/**
 * Memecoins launched via NOXA and The Odyssey. The universe is the set of
 * recently-launched tokens; graduation status is derived on-chain (a token
 * with a live Uniswap v3 pool has graduated/lists instantly; one without is
 * still on its bonding curve).
 */

export async function listCoins(opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 60)
  return cached(`coins:list:${limit}`, TTL.coins, async () => {
    const client = mainnetClient()
    const [chain, eth] = await Promise.all([getChain(), ethPriceUsd()])
    const latest = BigInt(chain.blockHeight)
    const msPerBlock = chain.avgBlockTimeMs ?? 100

    const launches = await getRecentLaunches(client, { lookbackBlocks: COINS_LOOKBACK, chunkSize: 900_000n })
    // Newest first, unique by token, capped.
    const seen = new Set<string>()
    const unique: Launch[] = []
    for (const l of launches.sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1))) {
      const k = l.token.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      unique.push(l)
      if (unique.length >= limit) break
    }

    const dex = await getBulkDexStats(client, unique.map((l) => l.token as Address), eth)
    const holders = await pMap(unique, 6, async (l) => {
      const c = await blockscout.getTokenCounters(l.token).catch(() => null)
      return c ? Number(c.token_holders_count) : null
    })

    const coins = unique.map((l, i) => {
      const d = dex.get(l.token.toLowerCase())
      const graduated = Boolean(d?.pool) || l.pool !== null
      const ageSeconds = latest > l.blockNumber ? Math.round((Number(latest - l.blockNumber) * msPerBlock) / 1000) : 0
      return {
        token: l.token,
        launchpad: l.launchpad,
        creator: l.creator,
        status: graduated ? ('graduated' as const) : ('bonding' as const),
        dexPriceUsd: d?.priceUsd ?? null,
        liquidityUsd: d?.liquidityUsd ?? null,
        pool: d?.pool ?? l.pool ?? null,
        feeTier: d?.feeTier ?? null,
        holders: holders[i] ?? null,
        ageSeconds,
        launchBlock: l.blockNumber.toString(),
        links: { token: blockscout.tokenLink(l.token), creator: blockscout.addressLink(l.creator) },
      }
    })

    return withMeta(
      { count: coins.length, lookbackBlocks: COINS_LOOKBACK.toString(), coins },
      [SOURCE.noxa, SOURCE.odyssey, SOURCE.uniswap, SOURCE.blockscout],
    )
  })
}

export async function getCoinDetail(addressRaw: string) {
  if (!isAddress(addressRaw)) {
    throw ApiError.badRequest(`"${addressRaw}" is not a valid contract address.`, 'invalid_address')
  }
  const address = getAddress(addressRaw)
  return cached(`coins:detail:${address.toLowerCase()}`, TTL.coinDetail, async () => {
    const client = mainnetClient()
    const [chain, eth] = await Promise.all([getChain(), ethPriceUsd()])
    const latest = BigInt(chain.blockHeight)
    const msPerBlock = chain.avgBlockTimeMs ?? 100

    const [token, counters, dex, launches] = await Promise.all([
      blockscout.getToken(address),
      blockscout.getTokenCounters(address).catch(() => null),
      getDexStats(client, address, eth).catch(() => null),
      getRecentLaunches(client, { lookbackBlocks: 1_200_000n, chunkSize: 600_000n }).catch(() => [] as Launch[]),
    ])

    const launch = launches.find((l) => l.token.toLowerCase() === address.toLowerCase()) ?? null
    const graduated = Boolean(dex?.pool) || Boolean(launch?.pool)
    const ageSeconds =
      launch && latest > launch.blockNumber
        ? Math.round((Number(latest - launch.blockNumber) * msPerBlock) / 1000)
        : null

    return withMeta(
      {
        address,
        name: token?.name ?? null,
        symbol: token?.symbol ?? null,
        decimals: token?.decimals ? Number(token.decimals) : null,
        totalSupply: token?.total_supply ?? null,
        status: graduated ? 'graduated' : launch ? 'bonding' : 'unknown',
        launch: launch
          ? {
              launchpad: launch.launchpad,
              creator: launch.creator,
              launchBlock: launch.blockNumber.toString(),
              transactionHash: launch.transactionHash,
              ageSeconds,
              tx: blockscout.txLink(launch.transactionHash),
            }
          : null,
        dex: dex
          ? {
              priceUsd: dex.priceUsd,
              pool: dex.pool,
              feeTier: dex.feeTier,
              quoteAsset: dex.quoteAsset,
              liquidityUsd: dex.liquidityUsd,
            }
          : null,
        holders: counters ? Number(counters.token_holders_count) : null,
        transfersCount: counters ? Number(counters.transfers_count) : null,
        links: {
          token: blockscout.tokenLink(address),
          pool: dex?.pool ? blockscout.addressLink(dex.pool) : null,
        },
      },
      [SOURCE.blockscout, SOURCE.uniswap, SOURCE.rpc],
    )
  })
}
