import type { Address } from 'viem'
import type { StockQuote, SwapQuote } from 'hoodchain'
import type { SpotPrice } from '../../../src/framework/market.js'

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address

function swapQuote(amountOut: bigint): SwapQuote {
  return {
    route: { fees: [3000], path: [], encodedPath: '0x' },
    amountIn: 0n,
    amountOut,
    gasEstimate: 120_000n,
  }
}

/**
 * A scriptable stand-in for {@link Market} built for deterministic strategy
 * unit tests. Every price it returns is either lifted verbatim from a real
 * captured snapshot (`tests/snapshots/latest.json`) or an explicit, documented
 * offset from one — never an invented number. Cast to `Market` at the call
 * site; only the subset of the real class's surface the strategies actually
 * call is implemented.
 */
export class FakeMarket {
  usdg = USDG
  weth = WETH
  usdgDecimals = 6

  buyRoutes = new Map<string, bigint | null>() // key: `${token}` -> amountOut or null (no route)
  sellRoutes = new Map<string, bigint | null>()
  spotPrices = new Map<string, number | null>() // key: token address
  chainlinkPrices = new Map<string, StockQuote | null>()
  dexPrices = new Map<string, number | null>()
  ethUsdValue = 1800

  multicallResults: readonly unknown[] = []

  client = {
    acknowledgeStockTokenEligibility: false,
    public: {
      multicall: async () => this.multicallResults,
    },
  }

  async ethUsd(): Promise<number | null> {
    return this.ethUsdValue
  }

  async spotPrice(token: Address): Promise<SpotPrice | null> {
    const price = this.spotPrices.get(token.toLowerCase())
    if (price === undefined || price === null) return null
    return { token, priceUsd: price, via: 'usdg', ts: Date.now() }
  }

  async quoteBuy(_quoteToken: Address, token: Address, _amountIn: bigint): Promise<SwapQuote | null> {
    const out = this.buyRoutes.get(token.toLowerCase())
    if (out === undefined || out === null) return null
    return swapQuote(out)
  }

  async quoteSell(token: Address, _quoteToken: Address, _amount: bigint): Promise<SwapQuote | null> {
    const out = this.sellRoutes.get(token.toLowerCase())
    if (out === undefined || out === null) return null
    return swapQuote(out)
  }

  async stockChainlinkPrice(symbol: string): Promise<StockQuote | null> {
    return this.chainlinkPrices.get(symbol) ?? null
  }

  async stockDexPrice(tokenAddress: Address, _referenceUsd: number): Promise<number | null> {
    return this.dexPrices.get(tokenAddress.toLowerCase()) ?? null
  }
}
