import { type Address } from 'viem'
import { getRecentLaunches, type Launch, type LaunchpadName } from 'hoodchain'
import { cached, TTL } from '../lib/cache.js'
import { SOURCE, withMeta } from '../lib/response.js'
import { mainnetClient } from '../upstreams/rpc.js'
import * as blockscout from '../upstreams/blockscout.js'
import { getChain } from './chain.js'

/** Default lookback for launch scans (~1h at 100ms blocks). */
const DEFAULT_LOOKBACK = 30_000n
/** Extended lookback for the coin universe (~7h). */
export const COINS_LOOKBACK = 200_000n

export interface EnrichedLaunch {
  launchpad: LaunchpadName
  token: Address
  creator: Address
  pool: Address | null
  launchBlock: string
  ageSeconds: number | null
  transactionHash: string
  links: { token: string; creator: string; tx: string }
}

async function ageFromBlock(launchBlock: bigint): Promise<number | null> {
  const chain = await getChain()
  const latest = BigInt(chain.blockHeight)
  const msPerBlock = chain.avgBlockTimeMs ?? 100
  if (latest <= launchBlock) return 0
  return Math.round((Number(latest - launchBlock) * msPerBlock) / 1000)
}

export function enrich(l: Launch, latest: bigint, msPerBlock: number): EnrichedLaunch {
  const ageSeconds = latest > l.blockNumber ? Math.round((Number(latest - l.blockNumber) * msPerBlock) / 1000) : 0
  return {
    launchpad: l.launchpad,
    token: l.token,
    creator: l.creator,
    pool: l.pool,
    launchBlock: l.blockNumber.toString(),
    ageSeconds,
    transactionHash: l.transactionHash,
    links: {
      token: blockscout.tokenLink(l.token),
      creator: blockscout.addressLink(l.creator),
      tx: blockscout.txLink(l.transactionHash),
    },
  }
}

/** Recent + live launchpad activity (NOXA, The Odyssey). */
export async function getLaunches(opts: { lookbackBlocks?: bigint; launchpad?: LaunchpadName; limit?: number } = {}) {
  const lookback = opts.lookbackBlocks ?? DEFAULT_LOOKBACK
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const key = `launches:${lookback}:${opts.launchpad ?? 'all'}:${limit}`
  return cached(key, TTL.launches, async () => {
    const client = mainnetClient()
    const chain = await getChain()
    const latest = BigInt(chain.blockHeight)
    const msPerBlock = chain.avgBlockTimeMs ?? 100

    const launches = await getRecentLaunches(client, {
      lookbackBlocks: lookback,
      launchpad: opts.launchpad,
      chunkSize: 900_000n, // public RPC's eth_getLogs range cap sits ~1.2M blocks; stay well under it
    })
    const sorted = launches.sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1)).slice(0, limit)
    const rows = sorted.map((l) => enrich(l, latest, msPerBlock))

    return withMeta(
      {
        count: rows.length,
        lookbackBlocks: lookback.toString(),
        launchpads: opts.launchpad ? [opts.launchpad] : ['noxa', 'odyssey'],
        launches: rows,
      },
      [SOURCE.noxa, SOURCE.odyssey, SOURCE.rpc],
    )
  })
}

export { ageFromBlock }
