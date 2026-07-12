import { formatGwei } from 'viem'
import { cached, TTL } from '../lib/cache.js'
import { SOURCE, withMeta } from '../lib/response.js'
import { mainnetClient } from '../upstreams/rpc.js'
import * as blockscout from '../upstreams/blockscout.js'
import * as defillama from '../upstreams/defillama.js'

/** Chain-level stats: height, gas, TVL, block time, ETH price. */
export async function getChain() {
  return cached('chain:stats', TTL.chain, async () => {
    const client = mainnetClient()

    const [blockHeight, gasPriceWei, stats, tvlUsd] = await Promise.all([
      client.public.getBlockNumber(),
      client.public.getGasPrice().catch(() => null),
      blockscout.getStats().catch(() => null),
      defillama.getChainTvl().catch(() => null),
    ])

    const source: string[] = [SOURCE.rpc]
    if (stats) source.push(SOURCE.blockscout)
    if (tvlUsd !== null) source.push(SOURCE.defillama)

    return withMeta(
      {
        chainId: 4663,
        network: 'mainnet' as const,
        blockHeight: blockHeight.toString(),
        avgBlockTimeMs: stats?.average_block_time ?? null,
        gas: {
          // ETH gas; wei/gwei native gas price plus Blockscout's slow/avg/fast (gwei).
          currentGwei: gasPriceWei !== null ? Number(formatGwei(gasPriceWei)) : null,
          slowGwei: stats?.gas_prices?.slow ?? null,
          averageGwei: stats?.gas_prices?.average ?? null,
          fastGwei: stats?.gas_prices?.fast ?? null,
        },
        ethPriceUsd: stats?.coin_price ? Number(stats.coin_price) : null,
        tvlUsd,
        marketCapUsd: stats?.market_cap ? Number(stats.market_cap) : null,
        totalTransactions: stats?.total_transactions ?? null,
        transactionsToday: stats?.transactions_today ?? null,
        totalAddresses: stats?.total_addresses ?? null,
        networkUtilizationPct: stats?.network_utilization_percentage ?? null,
        explorer: blockscout.addressLink('').replace(/\/address\/$/, ''),
      },
      source,
    )
  })
}

/** ETH price in USD (Blockscout), cached; used to value WETH-quoted pools. */
export async function ethPriceUsd(): Promise<number | null> {
  return cached('chain:ethusd', TTL.chain, async () => {
    const stats = await blockscout.getStats().catch(() => null)
    return stats?.coin_price ? Number(stats.coin_price) : null
  })
}
