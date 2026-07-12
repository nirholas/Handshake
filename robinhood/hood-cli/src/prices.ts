/**
 * Pricing helpers shared by `price` and `stocks`: the Chainlink oracle price,
 * the realised Uniswap v3 price (sell one token → USDG), and the premium the
 * DEX trades at over the oracle.
 */
import { formatUnits, parseUnits, type Address } from 'viem'
import {
  getQuote,
  quoteSwap,
  MAINNET_ADDRESSES,
  TESTNET_ADDRESSES,
  USDG_DECIMALS,
  type HoodClient,
  type StockQuote,
} from 'hoodchain'

export interface PriceRow {
  symbol: string
  address: Address
  /** Chainlink oracle price per token (USD), or null when no fresh feed. */
  oracleUsd: number | null
  /** Age of the oracle answer (seconds), or null. */
  oracleAgeSeconds: number | null
  /** Realised DEX price for selling one token into USDG (USD), or null. */
  dexUsd: number | null
  /** (dex − oracle) / oracle, or null when either side is missing. */
  premium: number | null
}

function usdgAddress(client: HoodClient): Address {
  return client.network === 'testnet' ? TESTNET_ADDRESSES.usdg : MAINNET_ADDRESSES.usdg
}

/**
 * The realised on-DEX price of one whole token in USDG, via a QuoterV2
 * simulation. Returns null when no route with liquidity exists.
 */
export async function getDexPriceUsd(
  client: HoodClient,
  token: Address,
  decimals = 18,
): Promise<number | null> {
  const usdg = usdgAddress(client)
  if (token.toLowerCase() === usdg.toLowerCase()) return 1
  try {
    const quote = await quoteSwap(client, {
      tokenIn: token,
      tokenOut: usdg,
      amountIn: parseUnits('1', decimals),
    })
    return Number(formatUnits(quote.amountOut, USDG_DECIMALS))
  } catch {
    return null
  }
}

/** Chainlink quote, tolerant of a missing/stale feed (returns null). */
export async function getOracleQuote(
  client: HoodClient,
  symbol: string,
  maxAgeSeconds?: number,
): Promise<StockQuote | null> {
  try {
    return await getQuote(client, symbol, maxAgeSeconds ? { maxAgeSeconds } : {})
  } catch {
    return null
  }
}

/** Assemble a full price row (oracle + DEX + premium) for one symbol. */
export async function getPriceRow(
  client: HoodClient,
  symbol: string,
  address: Address,
  options: { maxAgeSeconds?: number; withDex?: boolean; decimals?: number } = {},
): Promise<PriceRow> {
  const [oracle, dexUsd] = await Promise.all([
    getOracleQuote(client, symbol, options.maxAgeSeconds),
    options.withDex === false ? Promise.resolve(null) : getDexPriceUsd(client, address, options.decimals),
  ])
  const oracleUsd = oracle?.priceUsd ?? null
  const premium = oracleUsd && dexUsd ? (dexUsd - oracleUsd) / oracleUsd : null
  return {
    symbol,
    address,
    oracleUsd,
    oracleAgeSeconds: oracle?.ageSeconds ?? null,
    dexUsd,
    premium,
  }
}
