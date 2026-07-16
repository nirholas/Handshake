import {
  MAINNET_ADDRESSES,
  MAINNET_EXPLORER_URL,
  erc20Abi,
  listPricedStockTokens,
  uniswapV3PoolAbi,
  watchCurveTrades,
  watchGraduations,
  type HoodClient,
} from 'hoodchain'
import { discoverPools, sqrtPriceX96ToPrice, streamLaunches, streamPrices, streamSwaps, type PoolInfo, type Stream, type SwapEvent } from 'hoodkit'
import type { Address } from 'viem'
import { logger } from '../../logger.js'
import type { DetectorConfig } from '../../config.js'
import type { AlertEvent } from '../events.js'
import { EthPrice } from '../eth-price.js'
import { TokenMetaCache } from '../token-meta.js'
import { HolderMilestones } from './holders.js'
import { LiquidityMonitor } from './liquidity.js'
import { PremiumLadder } from './premium-ladder.js'
import { PriceMoveTracker } from './prices.js'
import { classifyCurveTrade, classifySwap } from './whale-classify.js'

const nowS = (): number => Math.floor(Date.now() / 1000)

interface StockPool {
  symbol: string
  token: Address
  pool: Address
  stockIs0: boolean
  decimals0: number
  decimals1: number
  quoteAsset: 'USDG' | 'WETH'
}

/**
 * The live detector set: every stream and poller that turns raw Robinhood
 * Chain state into {@link AlertEvent}s. One instance feeds the whole engine;
 * subscriber fan-out happens downstream.
 */
export class LiveDetectors {
  readonly ethPrice: EthPrice
  readonly meta: TokenMetaCache
  private readonly priceTracker: PriceMoveTracker
  private readonly premiumLadder = new PremiumLadder()
  private readonly holderMilestones = new HolderMilestones()
  private readonly liquidity: LiquidityMonitor

  private stops: Array<() => void> = []
  private timers: Array<ReturnType<typeof setInterval>> = []
  private swapStreams = new Map<string, Stream<SwapEvent>>()
  private watchedTokens = new Set<string>()
  /** Auto-tracked pools (from launches/graduations) expire; watched pools do not. */
  private poolExpiry = new Map<string, number | null>()
  private stockPools: StockPool[] = []
  private lastFeedUsd = new Map<string, number>()
  private running = false
  /** Diagnostics for /healthz. */
  lastEventAt: number | null = null
  eventCounts: Record<string, number> = {}

  constructor(
    private readonly client: HoodClient,
    private readonly cfg: DetectorConfig,
    private readonly emit: (event: AlertEvent) => void,
  ) {
    this.ethPrice = new EthPrice(client)
    this.meta = new TokenMetaCache(client)
    this.priceTracker = new PriceMoveTracker(cfg.priceWindowS, 1)
    this.liquidity = new LiquidityMonitor(1800, Math.min(cfg.rugDefaultPct, 20))
  }

  private push(event: AlertEvent): void {
    this.lastEventAt = nowS()
    this.eventCounts[event.type] = (this.eventCounts[event.type] ?? 0) + 1
    this.emit(event)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.startLaunches()
    this.startGraduations()
    this.startCurveWhales()
    this.startPrices()
    await this.refreshStockPools().catch((error) => logger.warn({ err: String(error) }, 'initial stock pool discovery failed'))
    this.timers.push(setInterval(() => void this.refreshStockPools().catch(() => undefined), 3_600_000))
    this.timers.push(setInterval(() => void this.pollPremiums().catch((e) => logger.warn({ err: String(e) }, 'premium poll failed')), this.cfg.premiumPollS * 1000))
    this.timers.push(setInterval(() => void this.pollLiquidity().catch((e) => logger.warn({ err: String(e) }, 'liquidity poll failed')), 60_000))
    this.timers.push(setInterval(() => void this.pollHolders().catch((e) => logger.warn({ err: String(e) }, 'holder poll failed')), 120_000))
    logger.info('live detectors started')
  }

  stop(): void {
    this.running = false
    for (const stop of this.stops) stop()
    this.stops = []
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const s of this.swapStreams.values()) s.close()
    this.swapStreams.clear()
    logger.info('live detectors stopped')
  }

  // ---- launches -----------------------------------------------------------

  private startLaunches(): void {
    const stream = streamLaunches(this.client)
    stream.on('data', (launch) => {
      void (async () => {
        const meta = await this.meta.get(launch.token)
        this.push({
          type: 'launch',
          launchpad: launch.launchpad,
          token: launch.token,
          symbol: meta.symbol,
          name: meta.name,
          creator: launch.creator,
          pool: launch.pool,
          blockNumber: launch.blockNumber,
          transactionHash: launch.transactionHash,
          at: nowS(),
        })
        // NOXA lists instantly on a v3 pool: rug-watch it for 24h.
        if (launch.pool) await this.autoTrackPool(launch.pool, launch.token)
      })().catch((error) => logger.warn({ err: String(error) }, 'launch handling failed'))
    })
    stream.on('error', (error) => logger.warn({ err: String(error) }, 'launch stream error (auto-retrying)'))
    this.stops.push(() => stream.close())
  }

  // ---- graduations --------------------------------------------------------

  private startGraduations(): void {
    const unwatch = watchGraduations(this.client, (g) => {
      void (async () => {
        const meta = await this.meta.get(g.token)
        this.push({
          type: 'graduation',
          token: g.token,
          symbol: meta.symbol,
          name: meta.name,
          pool: g.pool,
          blockNumber: g.blockNumber,
          transactionHash: g.transactionHash,
          at: nowS(),
        })
        await this.autoTrackPool(g.pool, g.token)
      })().catch((error) => logger.warn({ err: String(error) }, 'graduation handling failed'))
    }, { onError: (error) => logger.warn({ err: String(error) }, 'graduation watcher error (auto-retrying)') })
    this.stops.push(unwatch)
  }

  // ---- whales: Odyssey curve (chain-wide) ---------------------------------

  private startCurveWhales(): void {
    const unwatch = watchCurveTrades(this.client, (trade) => {
      void (async () => {
        const eth = await this.ethPrice.get()
        if (eth === null) return
        const event = classifyCurveTrade(trade, eth, this.cfg.whaleFloorUsd, nowS())
        if (!event) return
        const meta = await this.meta.get(event.token)
        this.push({ ...event, symbol: meta.symbol })
      })().catch((error) => logger.warn({ err: String(error) }, 'curve trade handling failed'))
    }, { onError: (error) => logger.warn({ err: String(error) }, 'curve trade watcher error (auto-retrying)') })
    this.stops.push(unwatch)
  }

  // ---- whales: Uniswap v3 (per watched token) -----------------------------

  /** Reconcile per-token swap streams + holder/liquidity tracking with the watch list. */
  async syncWatchedTokens(tokens: Address[]): Promise<void> {
    const next = new Set(tokens.map((t) => t.toLowerCase()))
    for (const existing of [...this.swapStreams.keys()]) {
      if (!next.has(existing)) {
        this.swapStreams.get(existing)?.close()
        this.swapStreams.delete(existing)
        this.watchedTokens.delete(existing)
        this.holderMilestones.forget(existing as Address)
      }
    }
    for (const token of next) {
      if (this.swapStreams.has(token)) continue
      this.watchedTokens.add(token)
      try {
        const pools = await discoverPools(this.client, token as Address)
        for (const info of pools) {
          const quote = this.quoteAssetOf(info)
          if (quote) {
            this.liquidity.track(info.pool, token as Address, quote)
            this.poolExpiry.set(info.pool.toLowerCase(), null)
          }
        }
        if (pools.length === 0) continue
        const stream = await streamSwaps(this.client, { token: token as Address })
        stream.on('data', (swap) => {
          void this.handleWatchedSwap(swap, pools).catch((error) =>
            logger.warn({ err: String(error) }, 'watched swap handling failed'),
          )
        })
        stream.on('error', (error) => logger.warn({ err: String(error), token }, 'swap stream error (auto-retrying)'))
        this.swapStreams.set(token, stream)
      } catch (error) {
        logger.warn({ err: String(error), token }, 'failed to start swap stream for watched token')
      }
    }
  }

  private async handleWatchedSwap(swap: SwapEvent, pools: PoolInfo[]): Promise<void> {
    const info = pools.find((p) => p.pool.toLowerCase() === swap.pool.toLowerCase())
    if (!info) return
    const eth = (await this.ethPrice.get()) ?? 0
    const event = classifySwap(
      swap,
      info,
      { weth: MAINNET_ADDRESSES.weth, usdg: MAINNET_ADDRESSES.usdg },
      eth,
      this.cfg.whaleFloorUsd,
      nowS(),
    )
    if (!event) return
    const meta = await this.meta.get(event.token)
    this.push({ ...event, symbol: meta.symbol })
  }

  private quoteAssetOf(info: PoolInfo): 'USDG' | 'WETH' | null {
    const weth = MAINNET_ADDRESSES.weth.toLowerCase()
    const usdg = MAINNET_ADDRESSES.usdg.toLowerCase()
    if (info.token0.toLowerCase() === usdg || info.token1.toLowerCase() === usdg) return 'USDG'
    if (info.token0.toLowerCase() === weth || info.token1.toLowerCase() === weth) return 'WETH'
    return null
  }

  // ---- Stock Token prices (Chainlink) -------------------------------------

  private startPrices(): void {
    const stream = streamPrices(this.client)
    stream.on('data', (tick) => {
      this.lastFeedUsd.set(tick.symbol, tick.priceUsd)
      const event = this.priceTracker.update(tick.symbol, tick.priceUsd, nowS())
      if (event) this.push(event)
    })
    stream.on('error', (error) => logger.warn({ err: String(error) }, 'price stream error (auto-retrying)'))
    this.stops.push(() => stream.close())
  }

  // ---- Stock Token premium/discount (the arb signal) ----------------------

  /** Discover the deepest USDG/WETH pool per priced Stock Token (hourly). */
  private async refreshStockPools(): Promise<void> {
    const stocks = listPricedStockTokens()
    const found: StockPool[] = []
    const concurrency = 5
    for (let i = 0; i < stocks.length; i += concurrency) {
      const batch = stocks.slice(i, i + concurrency)
      const results = await Promise.all(
        batch.map(async (stock) => {
          try {
            const pools = await discoverPools(this.client, stock.address)
            const candidates = pools
              .map((p) => ({ info: p, quote: this.quoteAssetOf(p) }))
              .filter((c): c is { info: PoolInfo; quote: 'USDG' | 'WETH' } => c.quote !== null)
            if (candidates.length === 0) return null
            // Deepest = largest quote reserves.
            const balances = await this.client.public.multicall({
              contracts: candidates.map((c) => ({
                address: (c.quote === 'USDG' ? MAINNET_ADDRESSES.usdg : MAINNET_ADDRESSES.weth) as Address,
                abi: erc20Abi,
                functionName: 'balanceOf' as const,
                args: [c.info.pool] as const,
              })),
              allowFailure: true,
            })
            let best: { c: (typeof candidates)[number]; scaled: number } | null = null
            const eth = (await this.ethPrice.get()) ?? 0
            candidates.forEach((c, j) => {
              const res = balances[j]
              if (!res || res.status !== 'success') return
              const decimals = c.quote === 'USDG' ? 6 : 18
              const human = Number(res.result as bigint) / 10 ** decimals
              const usd = c.quote === 'USDG' ? human : human * eth
              if (!best || usd > best.scaled) best = { c, scaled: usd }
            })
            if (!best) return null
            const chosen = best as { c: { info: PoolInfo; quote: 'USDG' | 'WETH' }; scaled: number }
            if (chosen.scaled < 100) return null // ignore dust pools: no real arb signal
            const { info, quote } = chosen.c
            return {
              symbol: stock.symbol,
              token: stock.address,
              pool: info.pool,
              stockIs0: info.token0.toLowerCase() === stock.address.toLowerCase(),
              decimals0: info.decimals0,
              decimals1: info.decimals1,
              quoteAsset: quote,
            } satisfies StockPool
          } catch {
            return null
          }
        }),
      )
      for (const r of results) if (r) found.push(r)
    }
    this.stockPools = found
    logger.info({ pools: found.length }, 'stock premium pools discovered')
  }

  private async pollPremiums(): Promise<void> {
    if (this.stockPools.length === 0) return
    const slots = await this.client.public.multicall({
      contracts: this.stockPools.map((p) => ({
        address: p.pool,
        abi: uniswapV3PoolAbi,
        functionName: 'slot0' as const,
      })),
      allowFailure: true,
    })
    const eth = await this.ethPrice.get()
    const at = nowS()
    slots.forEach((res, i) => {
      const p = this.stockPools[i]
      if (!p || res.status !== 'success') return
      const [sqrtPriceX96] = res.result as readonly [bigint, number, number, number, number, number, boolean]
      const spot0In1 = sqrtPriceX96ToPrice(sqrtPriceX96, p.decimals0, p.decimals1)
      if (spot0In1 <= 0) return
      const stockInQuote = p.stockIs0 ? spot0In1 : 1 / spot0In1
      const dexUsd = p.quoteAsset === 'USDG' ? stockInQuote : eth !== null ? stockInQuote * eth : null
      const feedUsd = this.lastFeedUsd.get(p.symbol)
      if (dexUsd === null || feedUsd === undefined) return
      const event = this.premiumLadder.update(p.symbol, p.token, p.pool, dexUsd, feedUsd, at)
      if (event) this.push(event)
    })
  }

  // ---- liquidity pulls ----------------------------------------------------

  private async autoTrackPool(pool: Address, token: Address): Promise<void> {
    try {
      const [token0, token1] = await this.client.public.multicall({
        contracts: [
          { address: pool, abi: poolTokensAbi, functionName: 'token0' },
          { address: pool, abi: poolTokensAbi, functionName: 'token1' },
        ],
        allowFailure: false,
      })
      const weth = MAINNET_ADDRESSES.weth.toLowerCase()
      const usdg = MAINNET_ADDRESSES.usdg.toLowerCase()
      let quote: 'USDG' | 'WETH' | null = null
      if (token0.toLowerCase() === usdg || token1.toLowerCase() === usdg) quote = 'USDG'
      else if (token0.toLowerCase() === weth || token1.toLowerCase() === weth) quote = 'WETH'
      if (!quote) return
      this.liquidity.track(pool, token, quote)
      if (this.poolExpiry.get(pool.toLowerCase()) !== null) {
        this.poolExpiry.set(pool.toLowerCase(), nowS() + 24 * 3600)
      }
    } catch (error) {
      logger.warn({ err: String(error), pool }, 'auto-track pool failed')
    }
  }

  private async pollLiquidity(): Promise<void> {
    const at = nowS()
    // Prune expired auto-tracked pools.
    for (const [pool, expiry] of this.poolExpiry) {
      if (expiry !== null && expiry <= at) {
        this.liquidity.untrack(pool as Address)
        this.poolExpiry.delete(pool)
      }
    }
    const pools = this.liquidity.tracked()
    if (pools.length === 0) return
    const eth = await this.ethPrice.get()
    const reads = pools.map((pool) => {
      const quote = this.liquidity.quoteAssetOf(pool) as 'USDG' | 'WETH'
      return {
        pool,
        quote,
        contract: {
          address: (quote === 'USDG' ? MAINNET_ADDRESSES.usdg : MAINNET_ADDRESSES.weth) as Address,
          abi: erc20Abi,
          functionName: 'balanceOf' as const,
          args: [pool] as const,
        },
      }
    })
    const balances = await this.client.public.multicall({
      contracts: reads.map((r) => r.contract),
      allowFailure: true,
    })
    for (let i = 0; i < reads.length; i++) {
      const read = reads[i]
      const res = balances[i]
      if (!read || !res || res.status !== 'success') continue
      const decimals = read.quote === 'USDG' ? 6 : 18
      const human = Number(res.result as bigint) / 10 ** decimals
      const usd = read.quote === 'USDG' ? human : eth !== null ? human * eth : null
      if (usd === null) continue
      const event = this.liquidity.update(read.pool, usd, at)
      if (event) {
        const meta = event.token ? await this.meta.get(event.token) : { symbol: null, name: null }
        this.push({ ...event, symbol: meta.symbol })
      }
    }
  }

  // ---- holder milestones (Blockscout counters) ----------------------------

  private async pollHolders(): Promise<void> {
    const at = nowS()
    for (const token of this.watchedTokens) {
      try {
        const res = await fetch(`${MAINNET_EXPLORER_URL}/api/v2/tokens/${token}/counters`, {
          signal: AbortSignal.timeout(10_000),
          headers: { accept: 'application/json' },
        })
        if (!res.ok) continue
        const body = (await res.json()) as { token_holders_count?: string }
        const count = Number(body.token_holders_count ?? NaN)
        if (!Number.isFinite(count)) continue
        const event = this.holderMilestones.update(token as Address, count, at)
        if (event) {
          const meta = await this.meta.get(event.token)
          this.push({ ...event, symbol: meta.symbol })
        }
      } catch {
        // transient explorer failures are fine; next poll retries
      }
    }
  }
}

const poolTokensAbi = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const
