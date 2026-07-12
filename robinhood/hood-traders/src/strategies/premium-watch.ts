import { getStockToken, parseUsdg } from 'hoodchain'
import type {
  Strategy,
  StrategyMeta,
  StrategyTickContext,
} from '../framework/strategy.js'
import type { Alert, Decision, Intent } from '../framework/types.js'

/** Tunables for {@link PremiumWatch}. */
export interface PremiumWatchParams {
  /** Symbols to watch. Defaults to a handful of the most liquid priced Stock Tokens. */
  symbols: string[];
  /** Premium/discount (bps, |dex - oracle| / oracle) that triggers an alert. */
  alertThresholdBps: number
  /** Premium/discount (bps) that triggers a convergence TRADE — only reachable in trade-eligible config. */
  tradeThresholdBps: number
  /** USDG spent per convergence trade, when trading is enabled. */
  tradeSizeUsdg: number
  /** Exit once the premium reverts to within this many bps of fair. */
  exitThresholdBps: number
  /** Hard time exit for a convergence position regardless of premium. */
  maxHoldSeconds: number
  /**
   * Convergence TRADING is opt-in and requires BOTH this flag AND
   * `market.client.acknowledgeStockTokenEligibility === true` (the operator's
   * non-US-person affirmation, per `_shared.md`). Missing either keeps the
   * strategy strictly alerts-only, which is the default and the recommended mode.
   */
  enableTrading: boolean
}

const DEFAULT_SYMBOLS = ['AAPL', 'TSLA', 'NVDA', 'AMZN', 'MSFT']

const DEFAULTS: PremiumWatchParams = {
  symbols: DEFAULT_SYMBOLS,
  alertThresholdBps: 50,
  tradeThresholdBps: 150,
  tradeSizeUsdg: 20,
  exitThresholdBps: 20,
  maxHoldSeconds: 2 * 60 * 60,
  enableTrading: false,
}

/**
 * premium-watch — tracks the spread between each Stock Token's Chainlink
 * oracle price and its live Uniswap v3 DEX price, and alerts on premium/discount.
 * Trades the convergence ONLY when explicitly enabled AND the operator has
 * affirmed Stock Token eligibility — otherwise it is alerts-only, which is the
 * default and the recommended mode for anyone who hasn't cleared the legal gate
 * in `_shared.md`.
 *
 * EDGE HYPOTHESIS: Stock Token pools are much thinner than the underlying
 * equity market, so DEX price can drift from the Chainlink oracle (itself fed
 * by the real market) when flow is one-sided. If the drift is a liquidity
 * artifact rather than new information, buying the discount / shorting the
 * premium (here: buying the discount and later selling back at fair, since the
 * SDK has no short primitive) captures the reversion as the pool re-equilibrates
 * via arbitrage or the next informed trade.
 *
 * FAILURE MODES: a premium can be RIGHT — the DEX price can be reacting to
 * information the Chainlink heartbeat (up to 24h) hasn't caught up to yet, in
 * which case "fading" it loses money on purpose. Stock Token pools are thin;
 * the $10 probe used to read `stockDexPrice` may not reflect the price your
 * actual trade size gets, and the trade itself moves the price you're trying to
 * arbitrage. Only long convergence is possible (no shorting), so premiums
 * (DEX rich) are alert-only even when trading is enabled — asymmetric coverage
 * by construction. Chainlink staleness (weekends, feed outages) can make a
 * quote look like a discount when it is just old.
 */
export class PremiumWatch implements Strategy {
  readonly id = 'premium-watch'
  readonly title = 'Premium Watch'
  readonly quote = 'usdg' as const
  private readonly p: PremiumWatchParams

  constructor(params: Partial<PremiumWatchParams> = {}) {
    this.p = { ...DEFAULTS, ...params }
  }

  get meta(): StrategyMeta {
    return {
      edge:
        'Track Chainlink-vs-DEX spread on Stock Tokens and, only in eligible+opted-in configuration, buy discounts ' +
        'expecting reversion as the thin pool re-equilibrates. Default mode is alerts-only.',
      failureModes: [
        'A premium/discount can be correct — DEX price may reflect information the ≤24h Chainlink heartbeat has not caught up to; fading it then loses on purpose.',
        'Stock Token pools are thin; the probe price does not reflect real trade-size slippage, and the trade itself moves the spread being arbitraged.',
        'No shorting primitive exists, so only discounts (DEX cheap) are ever tradeable — premiums are alert-only by construction, not by choice.',
        'Chainlink staleness (weekend gap, feed outage) can masquerade as a discount when the oracle, not the pool, is stale.',
        'Trading requires an explicit eligibility affirmation (Stock Tokens cannot be sold to US/CA/UK/CH persons) — default is alerts-only until the operator opts in.',
      ],
      params: { ...this.p, enableTrading: this.p.enableTrading },
    }
  }

  async tick(ctx: StrategyTickContext): Promise<Decision> {
    const intents: Intent[] = []
    const alerts: Alert[] = []
    const tradingLive = this.p.enableTrading && ctx.market.client.acknowledgeStockTokenEligibility

    if (this.p.enableTrading && !ctx.market.client.acknowledgeStockTokenEligibility) {
      alerts.push({
        level: 'warn',
        message:
          'premium-watch: enableTrading=true but the client has not acknowledged Stock Token eligibility — staying alerts-only',
      })
    }

    // ── exits: convergence positions revert or time out ────────────────────────
    for (const pos of ctx.positions) {
      const symbol = pos.tokenSymbol
      const spread = await this.readSpread(ctx, symbol)
      const ageSec = (ctx.now - pos.openedAt) / 1000
      let exitReason: string | null = null
      if (spread && Math.abs(spread.bps) <= this.p.exitThresholdBps) {
        exitReason = `converged: spread ${spread.bps.toFixed(0)}bps within exit band`
      } else if (ageSec >= this.p.maxHoldSeconds) {
        exitReason = `time-exit ${Math.round(ageSec)}s held`
      }
      if (exitReason) {
        intents.push({
          side: 'sell',
          token: pos.token,
          tokenSymbol: symbol,
          amountIn: pos.amount,
          quoteToken: pos.quoteToken,
          quoteSymbol: pos.quoteSymbol,
          reason: exitReason,
        })
      }
    }

    // ── observe + (maybe) enter ─────────────────────────────────────────────────
    for (const symbol of this.p.symbols) {
      const spread = await this.readSpread(ctx, symbol)
      if (!spread) continue

      const direction = spread.bps > 0 ? 'premium (DEX rich)' : 'discount (DEX cheap)'
      if (Math.abs(spread.bps) >= this.p.alertThresholdBps) {
        alerts.push({
          level: 'warn',
          message: `${symbol} ${direction}: oracle $${spread.oracleUsd.toFixed(2)} vs DEX $${spread.dexUsd.toFixed(2)} (${spread.bps.toFixed(0)}bps)`,
          meta: { symbol, oracleUsd: spread.oracleUsd, dexUsd: spread.dexUsd, bps: spread.bps },
        })
      }

      const alreadyHeld = ctx.positions.some((p) => p.tokenSymbol === symbol)
      const isDiscount = spread.bps <= -this.p.tradeThresholdBps
      if (tradingLive && isDiscount && !alreadyHeld) {
        const token = getStockToken(symbol)
        intents.push({
          side: 'buy',
          token: token.address,
          tokenSymbol: symbol,
          amountIn: parseUsdg(String(this.p.tradeSizeUsdg)),
          quoteToken: ctx.quoteToken,
          quoteSymbol: ctx.quoteSymbol,
          reason: `convergence entry: ${symbol} discount ${spread.bps.toFixed(0)}bps (oracle $${spread.oracleUsd.toFixed(2)} vs DEX $${spread.dexUsd.toFixed(2)})`,
          meta: { symbol, oracleUsd: spread.oracleUsd, dexUsd: spread.dexUsd, bps: spread.bps },
        })
      } else if (isDiscount && !tradingLive) {
        alerts.push({
          level: 'info',
          message: `${symbol} discount ${spread.bps.toFixed(0)}bps clears trade threshold but trading is disabled/ineligible — alert only`,
        })
      }
    }

    return { intents, alerts }
  }

  private async readSpread(
    ctx: StrategyTickContext,
    symbol: string,
  ): Promise<{ oracleUsd: number; dexUsd: number; bps: number } | null> {
    const oracle = await ctx.market.stockChainlinkPrice(symbol)
    if (!oracle) return null
    const token = getStockToken(symbol)
    const dexUsd = await ctx.market.stockDexPrice(token.address, oracle.priceUsd)
    if (dexUsd === null) return null
    const bps = ((dexUsd - oracle.priceUsd) / oracle.priceUsd) * 10_000
    return { oracleUsd: oracle.priceUsd, dexUsd, bps }
  }
}
