import { MAINNET_ADDRESSES, MAINNET_EXPLORER_URL, uniswapV3PoolAbi, type HoodClient } from 'hoodchain'
import { discoverPools, sqrtPriceX96ToPrice } from 'hoodkit'
import { logger } from '../logger.js'

/**
 * ETH/USD provider: Blockscout chain stats first (one HTTP call, cached),
 * falling back to the on-chain WETH/USDG Uniswap v3 pool spot when the
 * explorer API is unavailable. Whale sizing and WETH-pool valuation both
 * depend on this number.
 */
export class EthPrice {
  private value: number | null = null
  private fetchedAt = 0
  private pool: { address: `0x${string}`; wethIs0: boolean; decimals0: number; decimals1: number } | null = null

  constructor(
    private readonly client: HoodClient,
    private readonly ttlS = 60,
  ) {}

  async get(): Promise<number | null> {
    const now = Math.floor(Date.now() / 1000)
    if (this.value !== null && now - this.fetchedAt < this.ttlS) return this.value

    const fromStats = await this.fromBlockscout()
    if (fromStats !== null) {
      this.value = fromStats
      this.fetchedAt = now
      return fromStats
    }
    const fromPool = await this.fromPool()
    if (fromPool !== null) {
      this.value = fromPool
      this.fetchedAt = now
    }
    return fromPool ?? this.value
  }

  private async fromBlockscout(): Promise<number | null> {
    try {
      const res = await fetch(`${MAINNET_EXPLORER_URL}/api/v2/stats`, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { coin_price?: string | null }
      const price = body.coin_price ? Number(body.coin_price) : NaN
      return Number.isFinite(price) && price > 0 ? price : null
    } catch (error) {
      logger.warn({ err: String(error) }, 'blockscout stats unavailable, falling back to WETH/USDG pool')
      return null
    }
  }

  private async fromPool(): Promise<number | null> {
    try {
      if (!this.pool) {
        const pools = await discoverPools(this.client, MAINNET_ADDRESSES.weth)
        const usdgPool = pools.find(
          (p) =>
            p.token0.toLowerCase() === MAINNET_ADDRESSES.usdg.toLowerCase() ||
            p.token1.toLowerCase() === MAINNET_ADDRESSES.usdg.toLowerCase(),
        )
        if (!usdgPool) return null
        this.pool = {
          address: usdgPool.pool,
          wethIs0: usdgPool.token0.toLowerCase() === MAINNET_ADDRESSES.weth.toLowerCase(),
          decimals0: usdgPool.decimals0,
          decimals1: usdgPool.decimals1,
        }
      }
      const [sqrtPriceX96] = await this.client.public.readContract({
        address: this.pool.address,
        abi: uniswapV3PoolAbi,
        functionName: 'slot0',
      })
      const price0In1 = sqrtPriceX96ToPrice(sqrtPriceX96, this.pool.decimals0, this.pool.decimals1)
      if (price0In1 <= 0) return null
      return this.pool.wethIs0 ? price0In1 : 1 / price0In1
    } catch (error) {
      logger.warn({ err: String(error) }, 'WETH/USDG pool ETH price read failed')
      return null
    }
  }
}
