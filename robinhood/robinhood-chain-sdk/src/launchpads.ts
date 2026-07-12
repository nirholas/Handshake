import type { Address, Hash } from 'viem'
import type { HoodClient } from './client.js'

/**
 * Memecoin launchpad watchers for Robinhood Chain mainnet.
 *
 * Two launchpads operate on chain 4663 (addresses extracted from each
 * platform's official frontend bundle and confirmed against live on-chain
 * logs during SDK development — neither publishes verified source on
 * Blockscout):
 *
 * - **NOXA** (fun.noxa.fi/robinhood) — an instant launcher, not a bonding
 *   curve: one transaction deploys the ERC-20, creates a Uniswap v3 pool at
 *   the 1% tier, seeds single-sided liquidity, and permanently locks the LP
 *   NFT. There is no graduation; trading is normal Uniswap v3 swapping on
 *   the token's pool from block one.
 * - **The Odyssey** (theodyssey.fun) — a pump.fun-style native-ETH bonding
 *   curve with virtual reserves. Curve trades emit `Traded` on the factory;
 *   when the curve fills, `PoolCompleted` + `PoolMigrated` fire and
 *   liquidity moves to a locked Uniswap v3 pool.
 */

/** NOXA launchpad contracts (mainnet 4663). */
export const NOXA_ADDRESSES = {
  launchFactory: '0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB' as Address,
  locker: '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85' as Address,
  feeRouter: '0x9eFdC1A8e6E94f16A228e44f3025E1f346EE0417' as Address,
  /** First block with factory activity — lower bound for historical scans. */
  deployBlock: 61688n,
} as const

/** The Odyssey launchpad contracts (mainnet 4663). */
export const ODYSSEY_ADDRESSES = {
  /** Current bonding-curve factory. */
  bondingCurveFactory: '0xEb3FeeD2716cF0eEAda05B22e67424794e1f5a80' as Address,
  /** Variant that pays reflections in a reward token. */
  reflectionFactory: '0x6Ce85c4b7cE12903E5867652C265bCcce57f935F' as Address,
  /** Variant that skips the curve and lists instantly. */
  instantFactory: '0xD7601cEe401306fdea5833c6898181D9c770F800' as Address,
  robinLock: '0x5B41D59Fa0ce65750bc64e06D85bC999084493CD' as Address,
  /** Legacy first-generation factory (still emits historical launches). */
  legacyFactory: '0xAf9f3ce1d34909F59E88c23027f89d5807B0F915' as Address,
} as const

/** NOXA `TokenLaunched` — fired once per launch, carries the pool. */
export const noxaTokenLaunchedEvent = {
  type: 'event',
  name: 'TokenLaunched',
  inputs: [
    { name: 'token', type: 'address', indexed: true },
    { name: 'deployer', type: 'address', indexed: true },
    { name: 'dexFactory', type: 'address', indexed: true },
    { name: 'pairToken', type: 'address', indexed: false },
    { name: 'pool', type: 'address', indexed: false },
    { name: 'dexId', type: 'uint256', indexed: false },
    { name: 'launchConfigId', type: 'uint256', indexed: false },
    { name: 'positionId', type: 'uint256', indexed: false },
    { name: 'restrictionsEndBlock', type: 'uint256', indexed: false },
    { name: 'initialBuyAmount', type: 'uint256', indexed: false },
  ],
} as const

/** The Odyssey `TokenCreated` — fired when a curve opens. */
export const odysseyTokenCreatedEvent = {
  type: 'event',
  name: 'TokenCreated',
  inputs: [
    { name: 'token', type: 'address', indexed: true },
    { name: 'creator', type: 'address', indexed: true },
    { name: 'backingWallet', type: 'address', indexed: false },
    { name: 'isMarginBacked', type: 'bool', indexed: false },
    { name: 'threshold', type: 'uint256', indexed: false },
  ],
} as const

/** The Odyssey `Traded` — every curve buy/sell. */
export const odysseyTradedEvent = {
  type: 'event',
  name: 'Traded',
  inputs: [
    { name: 'token', type: 'address', indexed: true },
    { name: 'trader', type: 'address', indexed: true },
    { name: 'isBuy', type: 'bool', indexed: false },
    { name: 'tokenAmount', type: 'uint256', indexed: false },
    { name: 'quoteAmount', type: 'uint256', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
    { name: 'virtualQuote', type: 'uint256', indexed: false },
    { name: 'virtualToken', type: 'uint256', indexed: false },
  ],
} as const

/** The Odyssey `PoolMigrated` — graduation to a locked Uniswap v3 pool. */
export const odysseyPoolMigratedEvent = {
  type: 'event',
  name: 'PoolMigrated',
  inputs: [
    { name: 'token', type: 'address', indexed: true },
    { name: 'pool', type: 'address', indexed: false },
    { name: 'tokenId', type: 'uint256', indexed: false },
    { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tokenUsed', type: 'uint256', indexed: false },
    { name: 'usdcUsed', type: 'uint256', indexed: false },
  ],
} as const

/** Which launchpad a launch came from. */
export type LaunchpadName = 'noxa' | 'odyssey'

/** A decoded token launch. */
export interface Launch {
  launchpad: LaunchpadName
  /** The new token's contract address. */
  token: Address
  /** The wallet that launched it. */
  creator: Address
  /**
   * The Uniswap v3 pool. Present immediately for NOXA (instant listing);
   * `null` for Odyssey launches still on the bonding curve (appears at
   * graduation via `PoolMigrated`).
   */
  pool: Address | null
  blockNumber: bigint
  transactionHash: Hash
}

/** A decoded Odyssey bonding-curve trade. */
export interface CurveTrade {
  launchpad: 'odyssey'
  token: Address
  trader: Address
  isBuy: boolean
  /** Token amount bought/sold (18 decimals). */
  tokenAmount: bigint
  /** Native ETH paid/received (wei). */
  quoteAmount: bigint
  fee: bigint
  blockNumber: bigint
  transactionHash: Hash
}

const ODYSSEY_FACTORIES: Address[] = [
  ODYSSEY_ADDRESSES.bondingCurveFactory,
  ODYSSEY_ADDRESSES.reflectionFactory,
  ODYSSEY_ADDRESSES.instantFactory,
]

/** Options for {@link getRecentLaunches}. */
export interface GetRecentLaunchesOptions {
  /**
   * How many blocks back to scan. Robinhood Chain produces a block roughly
   * every 100–130ms, so 30 000 blocks ≈ the last hour.
   * @defaultValue `30_000n`
   */
  lookbackBlocks?: bigint
  /** Restrict to one launchpad. Defaults to both. */
  launchpad?: LaunchpadName
  /** Max blocks per `eth_getLogs` request (public-RPC friendly chunking). */
  chunkSize?: bigint
}

/**
 * Fetch recent launches from NOXA and The Odyssey via RPC logs.
 *
 * @example
 * ```ts
 * const launches = await getRecentLaunches(hood, { lookbackBlocks: 100_000n })
 * for (const l of launches) console.log(l.launchpad, l.token, l.creator)
 * ```
 */
export async function getRecentLaunches(
  client: HoodClient,
  options: GetRecentLaunchesOptions = {},
): Promise<Launch[]> {
  const latest = await client.public.getBlockNumber()
  const lookback = options.lookbackBlocks ?? 30_000n
  const chunk = options.chunkSize ?? 10_000n
  const fromBlock = latest > lookback ? latest - lookback : 0n

  const launches: Launch[] = []
  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n
    const [noxaLogs, odysseyLogs] = await Promise.all([
      options.launchpad === 'odyssey'
        ? Promise.resolve([])
        : client.public.getLogs({
            address: NOXA_ADDRESSES.launchFactory,
            event: noxaTokenLaunchedEvent,
            fromBlock: start,
            toBlock: end,
          }),
      options.launchpad === 'noxa'
        ? Promise.resolve([])
        : client.public.getLogs({
            address: ODYSSEY_FACTORIES,
            event: odysseyTokenCreatedEvent,
            fromBlock: start,
            toBlock: end,
          }),
    ])
    for (const log of noxaLogs) {
      launches.push({
        launchpad: 'noxa',
        token: log.args.token as Address,
        creator: log.args.deployer as Address,
        pool: (log.args.pool as Address) ?? null,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      })
    }
    for (const log of odysseyLogs) {
      launches.push({
        launchpad: 'odyssey',
        token: log.args.token as Address,
        creator: log.args.creator as Address,
        pool: null,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      })
    }
  }
  return launches.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1))
}

/** Options for {@link watchLaunches} / {@link watchCurveTrades}. */
export interface WatchOptions {
  /** Restrict to one launchpad. Defaults to both. */
  launchpad?: LaunchpadName
  /** Poll interval in ms for the underlying log watcher. @defaultValue `2000` */
  pollingInterval?: number
  /** Called when a watcher errors (it keeps polling afterwards). */
  onError?: (error: Error) => void
}

/**
 * Watch NOXA and The Odyssey for new token launches in real time.
 *
 * @returns An unwatch function.
 *
 * @example
 * ```ts
 * const unwatch = watchLaunches(hood, (launch) => {
 *   console.log(`${launch.launchpad}: ${launch.token} by ${launch.creator}`)
 * })
 * // later: unwatch()
 * ```
 */
export function watchLaunches(
  client: HoodClient,
  onLaunch: (launch: Launch) => void,
  options: WatchOptions = {},
): () => void {
  const unwatchers: (() => void)[] = []
  const pollingInterval = options.pollingInterval ?? 2000

  if (options.launchpad !== 'odyssey') {
    unwatchers.push(
      client.public.watchContractEvent({
        address: NOXA_ADDRESSES.launchFactory,
        abi: [noxaTokenLaunchedEvent],
        eventName: 'TokenLaunched',
        pollingInterval,
        onError: options.onError,
        onLogs: (logs) => {
          for (const log of logs) {
            onLaunch({
              launchpad: 'noxa',
              token: log.args.token as Address,
              creator: log.args.deployer as Address,
              pool: (log.args.pool as Address) ?? null,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
            })
          }
        },
      }),
    )
  }
  if (options.launchpad !== 'noxa') {
    unwatchers.push(
      client.public.watchContractEvent({
        address: ODYSSEY_FACTORIES,
        abi: [odysseyTokenCreatedEvent],
        eventName: 'TokenCreated',
        pollingInterval,
        onError: options.onError,
        onLogs: (logs) => {
          for (const log of logs) {
            onLaunch({
              launchpad: 'odyssey',
              token: log.args.token as Address,
              creator: log.args.creator as Address,
              pool: null,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
            })
          }
        },
      }),
    )
  }
  return () => unwatchers.forEach((u) => u())
}

/**
 * Watch The Odyssey's bonding curves for live buys/sells (`Traded` events).
 * NOXA has no curve — its tokens trade as normal Uniswap v3 swaps.
 *
 * @returns An unwatch function.
 */
export function watchCurveTrades(
  client: HoodClient,
  onTrade: (trade: CurveTrade) => void,
  options: Omit<WatchOptions, 'launchpad'> & { token?: Address } = {},
): () => void {
  return client.public.watchContractEvent({
    address: ODYSSEY_FACTORIES,
    abi: [odysseyTradedEvent],
    eventName: 'Traded',
    ...(options.token ? { args: { token: options.token } } : {}),
    pollingInterval: options.pollingInterval ?? 2000,
    onError: options.onError,
    onLogs: (logs) => {
      for (const log of logs) {
        onTrade({
          launchpad: 'odyssey',
          token: log.args.token as Address,
          trader: log.args.trader as Address,
          isBuy: log.args.isBuy as boolean,
          tokenAmount: log.args.tokenAmount as bigint,
          quoteAmount: log.args.quoteAmount as bigint,
          fee: log.args.fee as bigint,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        })
      }
    },
  })
}

/**
 * Watch for Odyssey graduations — the moment a curve fills and liquidity
 * migrates to a locked Uniswap v3 pool.
 *
 * @returns An unwatch function.
 */
export function watchGraduations(
  client: HoodClient,
  onGraduation: (g: { token: Address; pool: Address; blockNumber: bigint; transactionHash: Hash }) => void,
  options: Omit<WatchOptions, 'launchpad'> = {},
): () => void {
  return client.public.watchContractEvent({
    address: ODYSSEY_FACTORIES,
    abi: [odysseyPoolMigratedEvent],
    eventName: 'PoolMigrated',
    pollingInterval: options.pollingInterval ?? 2000,
    onError: options.onError,
    onLogs: (logs) => {
      for (const log of logs) {
        onGraduation({
          token: log.args.token as Address,
          pool: log.args.pool as Address,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        })
      }
    },
  })
}
