import {
  formatUnits,
  parseAbiItem,
  parseUnits,
  type Address,
  type Hex,
} from 'viem'
import {
  MAINNET_ADDRESSES,
  V3_FEE_TIERS,
  erc20Abi,
  uniswapV3FactoryAbi,
  uniswapV3PoolAbi,
  quoteSwap,
  type HoodClient,
} from 'hoodchain'

/**
 * On-chain Uniswap v3 market data for Robinhood Chain Stock Tokens: mid price
 * (quoted vs USDG), the deepest pool, liquidity in USD, and — for the detail
 * and history endpoints — OHLCV candles and 24h volume reconstructed from
 * `Swap` events.
 *
 * GeckoTerminal has not indexed chain 4663 yet, so DEX stats are read directly
 * from the chain. Mid price and liquidity are one-shot reads (safe for list
 * endpoints); candle/volume reconstruction scans logs and is reserved for the
 * single-token detail/history endpoints, behind a cache.
 */

const USDG = MAINNET_ADDRESSES.usdg
const WETH = MAINNET_ADDRESSES.weth
const FACTORY = MAINNET_ADDRESSES.uniswapV3Factory

const swapEvent = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)

export interface DexStats {
  /** DEX mid price of one token in USD (USDG≈$1), or null when no pool has liquidity. */
  priceUsd: number | null
  /** The pool used for pricing/liquidity. */
  pool: Address | null
  /** Fee tier of that pool (e.g. 3000 = 0.3%). */
  feeTier: number | null
  /** Quote asset of the pool: 'USDG' or 'WETH'. */
  quoteAsset: 'USDG' | 'WETH' | null
  /** Total value locked in the pool, in USD. */
  liquidityUsd: number | null
}

/** All existing token/USDG and token/WETH pools across fee tiers, with reserves. */
async function discoverPools(
  client: HoodClient,
  token: Address,
): Promise<Array<{ pool: Address; fee: number; quote: 'USDG' | 'WETH'; quoteToken: Address }>> {
  const probes: Array<{ fee: number; quote: 'USDG' | 'WETH'; quoteToken: Address }> = []
  for (const fee of V3_FEE_TIERS) {
    probes.push({ fee, quote: 'USDG', quoteToken: USDG })
    probes.push({ fee, quote: 'WETH', quoteToken: WETH })
  }
  const results = await client.public.multicall({
    contracts: probes.map((p) => ({
      address: FACTORY,
      abi: uniswapV3FactoryAbi,
      functionName: 'getPool' as const,
      args: [token, p.quoteToken, p.fee] as const,
    })),
    allowFailure: true,
  })
  const pools: Array<{ pool: Address; fee: number; quote: 'USDG' | 'WETH'; quoteToken: Address }> = []
  results.forEach((r, i) => {
    if (r.status === 'success') {
      const pool = r.result as Address
      if (pool && pool !== '0x0000000000000000000000000000000000000000') {
        const p = probes[i]!
        pools.push({ pool, fee: p.fee, quote: p.quote, quoteToken: p.quoteToken })
      }
    }
  })
  return pools
}

/**
 * One-shot DEX stats for a token: deepest pool, USD mid price, liquidity USD.
 * `ethPriceUsd` values WETH-quoted pools; pass the chain's ETH price.
 */
export async function getDexStats(
  client: HoodClient,
  token: Address,
  ethPriceUsd: number | null,
): Promise<DexStats> {
  const pools = await discoverPools(client, token)
  if (pools.length === 0) return { priceUsd: null, pool: null, feeTier: null, quoteAsset: null, liquidityUsd: null }

  // Read pool reserves (token + quote balances) to pick the deepest pool and value liquidity.
  const balances = await client.public.multicall({
    contracts: pools.flatMap((p) => [
      { address: token, abi: erc20Abi, functionName: 'balanceOf' as const, args: [p.pool] as const },
      { address: p.quoteToken, abi: erc20Abi, functionName: 'balanceOf' as const, args: [p.pool] as const },
    ]),
    allowFailure: false,
  })

  let best: { pool: Address; fee: number; quote: 'USDG' | 'WETH'; quoteBalUsd: number } | null = null
  pools.forEach((p, i) => {
    const quoteBal = balances[i * 2 + 1] as bigint
    const quoteDecimals = p.quote === 'USDG' ? 6 : 18
    const quoteAmount = Number(formatUnits(quoteBal, quoteDecimals))
    const quoteBalUsd = p.quote === 'USDG' ? quoteAmount : quoteAmount * (ethPriceUsd ?? 0)
    if (!best || quoteBalUsd > best.quoteBalUsd) {
      best = { pool: p.pool, fee: p.fee, quote: p.quote, quoteBalUsd }
    }
  })
  if (!best) return { priceUsd: null, pool: null, feeTier: null, quoteAsset: null, liquidityUsd: null }
  const chosen = best as { pool: Address; fee: number; quote: 'USDG' | 'WETH'; quoteBalUsd: number }

  // Mid price: quote 1 token -> USDG directly (or via WETH), independent of which pool we chose.
  let priceUsd: number | null = null
  try {
    const q = await quoteSwap(client, { tokenIn: token, tokenOut: USDG, amountIn: parseUnits('1', 18) })
    priceUsd = Number(formatUnits(q.amountOut, 6))
  } catch {
    priceUsd = null
  }

  // Liquidity USD ≈ 2 × the quote-side reserve of the deepest pool (balanced-pool approximation).
  const liquidityUsd = chosen.quoteBalUsd > 0 ? chosen.quoteBalUsd * 2 : null

  return {
    priceUsd,
    pool: chosen.pool,
    feeTier: chosen.fee,
    quoteAsset: chosen.quote,
    liquidityUsd,
  }
}

export interface Candle {
  /** Bucket start, unix seconds. */
  t: number
  o: number
  h: number
  l: number
  c: number
  /** Volume in USD across the bucket. */
  v: number
}

export interface CandleSeries {
  pool: Address
  quoteAsset: 'USDG' | 'WETH'
  interval: string
  candles: Candle[]
  /** Sum of `v` over the returned window. */
  volumeUsd: number
  fromBlock: string
  toBlock: string
}

const INTERVAL_SECONDS: Record<string, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
}

/**
 * Reconstruct OHLCV candles from `Swap` events on the token's deepest pool.
 *
 * Robinhood Chain runs ~100ms blocks, so a day is ~860k blocks; logs are read
 * in chunks. This is intentionally the heavyweight path — call it only for a
 * single token behind a cache (detail/history endpoints), never in a list.
 */
export async function getCandles(
  client: HoodClient,
  token: Address,
  ethPriceUsd: number | null,
  opts: { interval?: string; lookbackBlocks?: bigint; chunkSize?: bigint } = {},
): Promise<CandleSeries | null> {
  const interval = opts.interval && INTERVAL_SECONDS[opts.interval] ? opts.interval : '1h'
  const bucket = INTERVAL_SECONDS[interval]!

  const pools = await discoverPools(client, token)
  if (pools.length === 0) return null

  // Choose the deepest pool by quote reserve.
  const reserves = await client.public.multicall({
    contracts: pools.map((p) => ({
      address: p.quoteToken,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [p.pool] as const,
    })),
    allowFailure: false,
  })
  let bestIdx = 0
  let bestUsd = -1
  pools.forEach((p, i) => {
    const dec = p.quote === 'USDG' ? 6 : 18
    const amt = Number(formatUnits(reserves[i] as bigint, dec))
    const usd = p.quote === 'USDG' ? amt : amt * (ethPriceUsd ?? 0)
    if (usd > bestUsd) {
      bestUsd = usd
      bestIdx = i
    }
  })
  const chosen = pools[bestIdx]!

  // token0/token1 ordering fixes the sign convention for amount0/amount1.
  const [token0] = await Promise.all([
    client.public.readContract({ address: chosen.pool, abi: uniswapV3PoolAbi, functionName: 'token0' }),
  ])
  const tokenIsToken0 = (token0 as Address).toLowerCase() === token.toLowerCase()
  const quoteDecimals = chosen.quote === 'USDG' ? 6 : 18
  const quoteToUsd = chosen.quote === 'USDG' ? 1 : (ethPriceUsd ?? 0)

  const latest = await client.public.getBlockNumber()
  const lookback = opts.lookbackBlocks ?? 900_000n // ~24h at 100ms blocks
  const chunk = opts.chunkSize ?? 45_000n
  const fromBlock = latest > lookback ? latest - lookback : 0n

  // Sample block timestamps at chunk boundaries and interpolate (avoids a
  // getBlock per swap while keeping candle bucketing accurate to a few blocks).
  const anchors = new Map<bigint, number>()
  const anchorBlocks = [fromBlock, latest]
  const anchorTs = await Promise.all(
    anchorBlocks.map((b) => client.public.getBlock({ blockNumber: b }).then((blk) => Number(blk.timestamp))),
  )
  anchorBlocks.forEach((b, i) => anchors.set(b, anchorTs[i]!))
  const t0 = anchors.get(fromBlock)!
  const t1 = anchors.get(latest)!
  const secPerBlock = latest > fromBlock ? (t1 - t0) / Number(latest - fromBlock) : 0.1
  const tsOf = (block: bigint): number => Math.round(t0 + Number(block - fromBlock) * secPerBlock)

  interface Raw {
    ts: number
    price: number
    volUsd: number
  }
  const raws: Raw[] = []
  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n
    const logs = await client.public.getLogs({
      address: chosen.pool,
      event: swapEvent,
      fromBlock: start,
      toBlock: end,
    })
    for (const log of logs) {
      const a0 = log.args.amount0 as bigint
      const a1 = log.args.amount1 as bigint
      const tokenDelta = tokenIsToken0 ? a0 : a1
      const quoteDelta = tokenIsToken0 ? a1 : a0
      const tokenAbs = tokenDelta < 0n ? -tokenDelta : tokenDelta
      const quoteAbs = quoteDelta < 0n ? -quoteDelta : quoteDelta
      if (tokenAbs === 0n || quoteAbs === 0n) continue
      const tokenAmt = Number(formatUnits(tokenAbs, 18))
      const quoteAmt = Number(formatUnits(quoteAbs, quoteDecimals))
      const priceUsd = (quoteAmt / tokenAmt) * quoteToUsd
      raws.push({ ts: tsOf(log.blockNumber), price: priceUsd, volUsd: quoteAmt * quoteToUsd })
    }
  }

  const byBucket = new Map<number, Candle>()
  for (const r of raws.sort((a, b) => a.ts - b.ts)) {
    const t = Math.floor(r.ts / bucket) * bucket
    const existing = byBucket.get(t)
    if (!existing) {
      byBucket.set(t, { t, o: r.price, h: r.price, l: r.price, c: r.price, v: r.volUsd })
    } else {
      existing.h = Math.max(existing.h, r.price)
      existing.l = Math.min(existing.l, r.price)
      existing.c = r.price
      existing.v += r.volUsd
    }
  }
  const candles = [...byBucket.values()].sort((a, b) => a.t - b.t)
  const volumeUsd = candles.reduce((s, c) => s + c.v, 0)

  return {
    pool: chosen.pool,
    quoteAsset: chosen.quote,
    interval,
    candles,
    volumeUsd,
    fromBlock: fromBlock.toString(),
    toBlock: latest.toString(),
  }
}

export function encodedPathToString(path: Hex): string {
  return path
}
