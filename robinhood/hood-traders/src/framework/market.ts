import {
  createHoodClient,
  getQuote,
  quoteSwap,
  swapAddresses,
  listPricedStockTokens,
  MAINNET_ADDRESSES,
  TESTNET_ADDRESSES,
  USDG_DECIMALS,
  type HoodClient,
  type StockQuote,
  type SwapQuote,
} from 'hoodchain'
import { formatUnits, parseUnits, type Account, type Address } from 'viem'
import type { FleetConfig } from './config.js'

/** A memecoin/token spot price sourced from live Uniswap v3 liquidity. */
export interface SpotPrice {
  token: Address
  /** USD value of one whole token, derived from a probe quote against USDG (direct or via WETH). */
  priceUsd: number
  /** Quote token the probe routed through. */
  via: 'usdg' | 'weth'
  ts: number
}

/**
 * The market adapter. Everything the observe/simulate steps need, sourced from
 * live Robinhood Chain state through the `hoodchain` SDK — Chainlink stock
 * feeds, Uniswap v3 quotes (which ARE `eth_call` simulations against real
 * pools), and an ETH/USD reference derived from the on-chain USDG/WETH pool.
 *
 * No price here is fabricated: a token with no liquidity resolves to `null`, and
 * strategies must handle that rather than trade a made-up number.
 */
export class Market {
  readonly client: HoodClient
  readonly usdg: Address
  readonly weth: Address
  readonly usdgDecimals = USDG_DECIMALS
  private ethUsdCache: { value: number; ts: number } | null = null

  constructor(config: FleetConfig, account?: Account) {
    this.client = createHoodClient({
      chain: config.network,
      rpcUrl: config.rpcUrl,
      account,
      acknowledgeStockTokenEligibility: config.stockTokenEligible,
    })
    const addrs = config.network === 'testnet' ? TESTNET_ADDRESSES : MAINNET_ADDRESSES
    this.usdg = addrs.usdg
    this.weth = config.network === 'testnet' ? TESTNET_ADDRESSES.weth : MAINNET_ADDRESSES.weth
  }

  /** Latest block number — a cheap liveness/observe heartbeat. */
  blockNumber(): Promise<bigint> {
    return this.client.public.getBlockNumber()
  }

  /**
   * ETH price in USD from the on-chain USDG/WETH pool (quote 0.01 WETH → USDG).
   * Cached for 30s — it moves slowly relative to a trading tick and every call
   * is a real RPC round trip. Returns `null` if no USDG/WETH pool answers.
   */
  async ethUsd(maxAgeMs = 30_000, now = Date.now()): Promise<number | null> {
    if (this.ethUsdCache && now - this.ethUsdCache.ts < maxAgeMs) return this.ethUsdCache.value
    try {
      const probe = parseUnits('0.01', 18)
      const q = await quoteSwap(this.client, { tokenIn: this.weth, tokenOut: this.usdg, amountIn: probe })
      const usd = Number(formatUnits(q.amountOut, this.usdgDecimals)) / 0.01
      this.ethUsdCache = { value: usd, ts: now }
      return usd
    } catch {
      return null
    }
  }

  /**
   * Spot USD price of one whole `token` from live liquidity. Probes token→USDG
   * directly, then token→WETH→USDG, using a 1-token probe. Returns `null` when
   * neither route has liquidity.
   */
  async spotPrice(token: Address, tokenDecimals = 18, now = Date.now()): Promise<SpotPrice | null> {
    const probe = parseUnits('1', tokenDecimals)
    // direct → USDG
    try {
      const q = await quoteSwap(this.client, { tokenIn: token, tokenOut: this.usdg, amountIn: probe })
      return { token, priceUsd: Number(formatUnits(q.amountOut, this.usdgDecimals)), via: 'usdg', ts: now }
    } catch {
      /* fall through to WETH route */
    }
    try {
      const q = await quoteSwap(this.client, { tokenIn: token, tokenOut: this.weth, amountIn: probe })
      const eth = await this.ethUsd(30_000, now)
      if (eth === null) return null
      const priceEth = Number(formatUnits(q.amountOut, 18))
      return { token, priceUsd: priceEth * eth, via: 'weth', ts: now }
    } catch {
      return null
    }
  }

  /**
   * Quote a buy: how much `token` `amountIn` of `quoteToken` acquires, at live
   * liquidity. This is the simulate step — a QuoterV2 `eth_call`, no state
   * change. Returns `null` when no route fills.
   */
  async quoteBuy(quoteToken: Address, token: Address, amountIn: bigint): Promise<SwapQuote | null> {
    try {
      return await quoteSwap(this.client, { tokenIn: quoteToken, tokenOut: token, amountIn })
    } catch {
      return null
    }
  }

  /** Quote a sell: proceeds in `quoteToken` from selling `amount` of `token`. */
  async quoteSell(token: Address, quoteToken: Address, amount: bigint): Promise<SwapQuote | null> {
    try {
      return await quoteSwap(this.client, { tokenIn: token, tokenOut: quoteToken, amountIn: amount })
    } catch {
      return null
    }
  }

  /** Chainlink price for a Stock Token (already multiplier-adjusted). */
  async stockChainlinkPrice(symbol: string): Promise<StockQuote | null> {
    try {
      return await getQuote(this.client, symbol)
    } catch {
      return null
    }
  }

  /**
   * DEX price of a Stock Token in USD from the USDG pool — the number the
   * premium-watch strategy compares against the Chainlink oracle. Probes with a
   * $10-equivalent order sized off the oracle price to keep impact realistic.
   */
  async stockDexPrice(tokenAddress: Address, referenceUsd: number): Promise<number | null> {
    if (referenceUsd <= 0) return null
    // Buy ~$10 of the token with USDG and back out the implied price.
    const usdgIn = parseUnits('10', this.usdgDecimals)
    const q = await this.quoteBuy(this.usdg, tokenAddress, usdgIn)
    if (!q) return null
    const tokensOut = Number(formatUnits(q.amountOut, 18))
    if (tokensOut <= 0) return null
    return 10 / tokensOut
  }

  /** Priced Stock Tokens from the registry (those with a Chainlink feed). */
  pricedStockTokens() {
    return listPricedStockTokens()
  }

  /** Router/quoter/weth/usdg set for the active network. */
  addresses() {
    return swapAddresses(this.client)
  }
}
