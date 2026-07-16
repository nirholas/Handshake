import { formatUnits, type Address, type Hash } from 'viem'
import type { CurveTrade } from 'hoodchain'
import type { PoolInfo, SwapEvent } from 'hoodkit'
import type { WhaleEvent } from '../events.js'

/**
 * Pure whale classifiers, unit-tested against captured real trades.
 * The live wiring (log cursors) lives in detectors/live.ts.
 */

/** Classify an Odyssey bonding-curve trade. Quote is native ETH (wei). */
export function classifyCurveTrade(
  trade: Pick<CurveTrade, 'token' | 'trader' | 'isBuy' | 'quoteAmount' | 'blockNumber' | 'transactionHash'>,
  ethUsd: number,
  floorUsd: number,
  atS: number,
): WhaleEvent | null {
  if (!Number.isFinite(ethUsd) || ethUsd <= 0) return null
  const usd = Number(formatUnits(trade.quoteAmount, 18)) * ethUsd
  if (usd < floorUsd) return null
  return {
    type: 'whale',
    source: 'odyssey-curve',
    token: trade.token,
    symbol: null,
    side: trade.isBuy ? 'buy' : 'sell',
    usd,
    trader: trade.trader,
    blockNumber: trade.blockNumber,
    transactionHash: trade.transactionHash,
    at: atS,
  }
}

/**
 * Classify a Uniswap v3 swap on a pool whose quote side is WETH or USDG.
 * `base` is the non-quote token (the coin being traded).
 */
export function classifySwap(
  swap: Pick<SwapEvent, 'amount0' | 'amount1' | 'volume0' | 'volume1' | 'recipient' | 'blockNumber' | 'transactionHash'>,
  info: Pick<PoolInfo, 'token0' | 'token1'>,
  quote: { weth: Address; usdg: Address },
  ethUsd: number,
  floorUsd: number,
  atS: number,
): WhaleEvent | null {
  const t0 = info.token0.toLowerCase()
  const t1 = info.token1.toLowerCase()
  const weth = quote.weth.toLowerCase()
  const usdg = quote.usdg.toLowerCase()

  let quoteSide: 0 | 1 | null = null
  let quoteAsset: 'WETH' | 'USDG' | null = null
  if (t1 === weth || t1 === usdg) {
    quoteSide = 1
    quoteAsset = t1 === weth ? 'WETH' : 'USDG'
  } else if (t0 === weth || t0 === usdg) {
    quoteSide = 0
    quoteAsset = t0 === weth ? 'WETH' : 'USDG'
  }
  if (quoteSide === null || quoteAsset === null) return null
  if (quoteAsset === 'WETH' && (!Number.isFinite(ethUsd) || ethUsd <= 0)) return null

  const quoteVolume = quoteSide === 0 ? swap.volume0 : swap.volume1
  const usd = quoteAsset === 'USDG' ? quoteVolume : quoteVolume * ethUsd
  if (usd < floorUsd) return null

  const base = (quoteSide === 0 ? info.token1 : info.token0) as Address
  // The trader bought the base token when the pool paid the base side out.
  const baseAmount = quoteSide === 0 ? swap.amount1 : swap.amount0
  return {
    type: 'whale',
    source: 'uniswap-v3',
    token: base,
    symbol: null,
    side: baseAmount < 0n ? 'buy' : 'sell',
    usd,
    trader: swap.recipient,
    blockNumber: swap.blockNumber,
    transactionHash: swap.transactionHash as Hash,
    at: atS,
  }
}
