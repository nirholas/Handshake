import { formatUnits, type Address, type Hash } from 'viem'
import {
  erc20Abi,
  aggregatorV3Abi,
  getStockToken,
  getStockTokenByAddress,
  listPricedStockTokens,
  listStockTokens,
  MAINNET_ADDRESSES,
  TESTNET_ADDRESSES,
  NOXA_ADDRESSES,
  ODYSSEY_ADDRESSES,
  noxaTokenLaunchedEvent,
  odysseyTokenCreatedEvent,
  type HoodClient,
  type Launch,
} from 'hoodchain'
import { Stream, type StreamOptions } from './stream.js'
import { runLogCursor } from './log-cursor.js'
import { decodeSwapLog, discoverPools, loadPoolInfo, uniswapV3SwapEvent, type PoolInfo, type SwapEvent } from './uniswap.js'

export { Stream } from './stream.js'
export type { OverflowPolicy, StreamOptions } from './stream.js'
export { runLogCursor } from './log-cursor.js'
export type { LogCursorOptions, LogSource } from './log-cursor.js'
export {
  discoverPools,
  loadPoolInfo,
  decodeSwapLog,
  sqrtPriceX96ToPrice,
  uniswapV3SwapEvent,
  uniswapV3PoolMetaAbi,
} from './uniswap.js'
export type { PoolInfo, SwapEvent } from './uniswap.js'

const ODYSSEY_FACTORIES: Address[] = [
  ODYSSEY_ADDRESSES.bondingCurveFactory,
  ODYSSEY_ADDRESSES.reflectionFactory,
  ODYSSEY_ADDRESSES.instantFactory,
]

/** ERC-20 `Transfer` event (explicit — the SDK's `erc20Abi` member order is not a contract). */
const transferEvent = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const

/** A price update for one Stock Token, emitted only when the Chainlink round changes. */
export interface PriceTick {
  symbol: string
  feed: Address
  /** Price of one token in USD (already multiplier-adjusted by Chainlink). */
  priceUsd: number
  roundId: bigint
  updatedAt: number
  /** Age of the answer in seconds at emit time. */
  ageSeconds: number
}

/** Common polling knobs for the stream helpers. */
export interface StreamPollOptions extends StreamOptions {
  /** Poll interval in ms. */
  pollingIntervalMs?: number
}

/**
 * Stream live Stock Token prices. Polls every feed in one multicall on an
 * interval and emits a {@link PriceTick} only when a symbol's Chainlink round
 * advances — so consumers see genuine price changes, not redundant re-reads.
 *
 * @param symbols Tickers to watch, or `undefined` for every priced Stock Token.
 *
 * @example
 * ```ts
 * const prices = streamPrices(hood, ['AAPL', 'TSLA', 'NVDA'])
 * for await (const tick of prices) console.log(tick.symbol, tick.priceUsd)
 * ```
 */
export function streamPrices(
  client: HoodClient,
  symbols?: string[],
  options: StreamPollOptions = {},
): Stream<PriceTick> {
  const tokens = (symbols ? symbols.map((s) => getStockToken(s)) : listPricedStockTokens()).filter((t) => t.feed)
  const pollingIntervalMs = options.pollingIntervalMs ?? 4000
  const lastRound = new Map<string, bigint>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const stream = new Stream<PriceTick>({
    overflow: options.overflow ?? 'latest',
    highWaterMark: options.highWaterMark,
    onClose: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  })

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const results = await client.public.multicall({
        contracts: tokens.map((t) => ({
          address: t.feed as Address,
          abi: aggregatorV3Abi,
          functionName: 'latestRoundData' as const,
        })),
        allowFailure: true,
      })
      const now = Math.floor(Date.now() / 1000)
      results.forEach((res, i) => {
        const token = tokens[i]
        if (!token || res.status !== 'success') return
        const [roundId, answer, , updatedAt] = res.result as readonly [bigint, bigint, bigint, bigint, bigint]
        if (answer <= 0n || updatedAt === 0n) return
        if (lastRound.get(token.symbol) === roundId) return
        lastRound.set(token.symbol, roundId)
        stream.push({
          symbol: token.symbol,
          feed: token.feed as Address,
          priceUsd: Number(formatUnits(answer, token.feedDecimals ?? 8)),
          roundId,
          updatedAt: Number(updatedAt),
          ageSeconds: Math.max(0, now - Number(updatedAt)),
        })
      })
    } catch (error) {
      stream.fail(error instanceof Error ? error : new Error(String(error)))
    } finally {
      if (!stopped) timer = setTimeout(tick, pollingIntervalMs)
    }
  }
  void tick()
  return stream
}

/** Options for {@link streamSwaps}. */
export interface StreamSwapsOptions extends StreamOptions {
  /** Poll interval in ms. @defaultValue `1500` */
  pollingIntervalMs?: number
  /** Backfill from this block before streaming live. Omit for live-only. */
  fromBlock?: bigint
  /** Max blocks per `eth_getLogs`. @defaultValue `5000n` */
  chunkSize?: bigint
  /** Confirmations before a block is considered final. @defaultValue `1n` */
  confirmations?: bigint
}

/**
 * Stream Uniswap v3 swaps for a specific pool, or for every WETH/USDG pool of a
 * token. Backed by the gap-fill log cursor: a dropped RPC connection or blip
 * re-reads the missed block range instead of silently losing swaps.
 *
 * @example Watch every swap touching a token
 * ```ts
 * const swaps = await streamSwaps(hood, { token: '0x…' })
 * swaps.on('data', (s) => console.log(s.buysToken0 ? 'BUY' : 'SELL', s.price))
 * ```
 */
export async function streamSwaps(
  client: HoodClient,
  target: { pool: Address } | { token: Address },
  options: StreamSwapsOptions = {},
): Promise<Stream<SwapEvent>> {
  const pools: PoolInfo[] =
    'pool' in target ? [await loadPoolInfo(client, target.pool)] : await discoverPools(client, target.token)

  const stops: Array<() => void> = []
  const stream = new Stream<SwapEvent>({
    overflow: options.overflow ?? 'drop-oldest',
    highWaterMark: options.highWaterMark,
    onClose: () => stops.forEach((stop) => stop()),
  })

  for (const info of pools) {
    stops.push(
      runLogCursor<Awaited<ReturnType<typeof client.public.getLogs>>[number], SwapEvent>({
        source: client.public,
        stream,
        fromBlock: options.fromBlock,
        pollingIntervalMs: options.pollingIntervalMs ?? 1500,
        chunkSize: options.chunkSize,
        confirmations: options.confirmations,
        getLogs: (from, to) =>
          client.public.getLogs({ address: info.pool, event: uniswapV3SwapEvent, fromBlock: from, toBlock: to }),
        decode: (log) => decodeSwapLog(log, info),
        onError: (err) => stream.fail(err),
      }),
    )
  }
  return stream
}

/**
 * Stream new token launches from NOXA and The Odyssey, gap-filled. Optionally
 * backfill history with `fromBlock`.
 *
 * @example
 * ```ts
 * const launches = streamLaunches(hood)
 * for await (const l of launches) console.log(l.launchpad, l.token)
 * ```
 */
export function streamLaunches(client: HoodClient, options: StreamSwapsOptions = {}): Stream<Launch> {
  const stops: Array<() => void> = []
  const stream = new Stream<Launch>({
    overflow: options.overflow ?? 'drop-oldest',
    highWaterMark: options.highWaterMark,
    onClose: () => stops.forEach((stop) => stop()),
  })
  const shared = {
    pollingIntervalMs: options.pollingIntervalMs ?? 2500,
    chunkSize: options.chunkSize,
    confirmations: options.confirmations,
    fromBlock: options.fromBlock,
    onError: (err: Error) => stream.fail(err),
    source: client.public,
    stream,
  }

  stops.push(
    runLogCursor({
      ...shared,
      getLogs: (from, to) =>
        client.public.getLogs({
          address: NOXA_ADDRESSES.launchFactory,
          event: noxaTokenLaunchedEvent,
          fromBlock: from,
          toBlock: to,
        }),
      decode: (log): Launch => ({
        launchpad: 'noxa',
        token: log.args.token as Address,
        creator: log.args.deployer as Address,
        pool: (log.args.pool as Address) ?? null,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      }),
    }),
  )
  stops.push(
    runLogCursor({
      ...shared,
      getLogs: (from, to) =>
        client.public.getLogs({
          address: ODYSSEY_FACTORIES,
          event: odysseyTokenCreatedEvent,
          fromBlock: from,
          toBlock: to,
        }),
      decode: (log): Launch => ({
        launchpad: 'odyssey',
        token: log.args.token as Address,
        creator: log.args.creator as Address,
        pool: null,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      }),
    }),
  )
  return stream
}

/** A live portfolio change: the transfer that triggered it and the re-read balance. */
export interface PortfolioUpdate {
  /** The Stock Token (or USDG) whose balance changed. */
  token: Address
  /** Registry symbol, or `null` for non-registry tokens (e.g. USDG). */
  symbol: string | null
  /** New raw balance after the transfer. */
  balance: bigint
  /** New balance in human units. */
  balanceFormatted: number
  /** The transfer that triggered the re-read. */
  transfer: { from: Address; to: Address; value: bigint; blockNumber: bigint; transactionHash: Hash }
}

/**
 * Stream balance changes for `address` across every Stock Token (and USDG).
 * Watches inbound and outbound `Transfer` logs (gap-filled) and re-reads the
 * affected token's balance, emitting a {@link PortfolioUpdate} per change.
 */
export function streamPortfolio(
  client: HoodClient,
  address: Address,
  options: StreamSwapsOptions = {},
): Stream<PortfolioUpdate> {
  const usdg = client.network === 'testnet' ? TESTNET_ADDRESSES.usdg : MAINNET_ADDRESSES.usdg
  const watched: Address[] = [...listStockTokens().map((t) => t.address), usdg]
  const stops: Array<() => void> = []
  const stream = new Stream<PortfolioUpdate>({
    overflow: options.overflow ?? 'drop-oldest',
    highWaterMark: options.highWaterMark,
    onClose: () => stops.forEach((stop) => stop()),
  })

  stops.push(
    runLogCursor<{ token: Address; from: Address; to: Address; value: bigint; blockNumber: bigint; transactionHash: Hash }, PortfolioUpdate>(
      {
        source: client.public,
        stream,
        fromBlock: options.fromBlock,
        pollingIntervalMs: options.pollingIntervalMs ?? 3000,
        chunkSize: options.chunkSize,
        confirmations: options.confirmations,
        onError: (err) => stream.fail(err),
        getLogs: async (from, to) => {
          // OR semantics (from==addr | to==addr) require two indexed-topic queries.
          const [outbound, inbound] = await Promise.all([
            client.public.getLogs({ address: watched, event: transferEvent, args: { from: address }, fromBlock: from, toBlock: to }),
            client.public.getLogs({ address: watched, event: transferEvent, args: { to: address }, fromBlock: from, toBlock: to }),
          ])
          const seen = new Set<string>()
          const merged: Array<{ token: Address; from: Address; to: Address; value: bigint; blockNumber: bigint; transactionHash: Hash }> = []
          for (const log of [...outbound, ...inbound]) {
            const key = `${log.transactionHash}:${log.logIndex}`
            if (seen.has(key)) continue
            seen.add(key)
            const a = log.args as { from?: Address; to?: Address; value?: bigint }
            if (!a.from || !a.to || a.value === undefined) continue
            merged.push({
              token: log.address as Address,
              from: a.from,
              to: a.to,
              value: a.value,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
            })
          }
          return merged
        },
        decode: (t) => {
          // decode runs sync; enqueue an async balance read that pushes the update.
          void (async () => {
            try {
              const registryToken = getStockTokenByAddress(t.token)
              const decimals = registryToken?.decimals ?? (t.token.toLowerCase() === usdg.toLowerCase() ? 6 : 18)
              const balance = await client.public.readContract({
                address: t.token,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [address],
              })
              stream.push({
                token: t.token,
                symbol: registryToken?.symbol ?? (t.token.toLowerCase() === usdg.toLowerCase() ? 'USDG' : null),
                balance,
                balanceFormatted: Number(formatUnits(balance, decimals)),
                transfer: { from: t.from, to: t.to, value: t.value, blockNumber: t.blockNumber, transactionHash: t.transactionHash },
              })
            } catch (error) {
              stream.fail(error instanceof Error ? error : new Error(String(error)))
            }
          })()
          return null // the async read pushes; nothing to emit synchronously
        },
      },
    ),
  )
  return stream
}
