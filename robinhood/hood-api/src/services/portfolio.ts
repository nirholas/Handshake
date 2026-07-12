import { getAddress, isAddress, type Address } from 'viem'
import { getPortfolio } from 'hoodchain'
import { cached, TTL } from '../lib/cache.js'
import { ApiError } from '../lib/errors.js'
import { SOURCE, withMeta } from '../lib/response.js'
import { mainnetClient } from '../upstreams/rpc.js'
import * as blockscout from '../upstreams/blockscout.js'

/**
 * Multiplier-correct portfolio valuation for any address (paid).
 *
 * Two numbers per position that generic trackers get wrong:
 *  - USD value = balance × Chainlink price (the feed is already
 *    multiplier-adjusted, so the multiplier is NOT applied to value).
 *  - Share equivalent = balance × uiMultiplier ÷ 1e18 (raw balances understate
 *    holdings after splits/reinvested dividends).
 *
 * `basis` documents the valuation model. True realized/unrealized PnL requires
 * per-trade entry prices, which are not derivable from balances alone; those
 * fields are surfaced as `null` with an explicit note rather than guessed.
 */
export async function getPortfolioValuation(addressRaw: string) {
  if (!isAddress(addressRaw)) {
    throw ApiError.badRequest(`"${addressRaw}" is not a valid address.`, 'invalid_address')
  }
  const address = getAddress(addressRaw)
  return cached(`portfolio:${address.toLowerCase()}`, TTL.portfolio, async () => {
    const p = await getPortfolio(mainnetClient(), address as Address)
    return withMeta(
      {
        owner: address,
        totalUsd: p.totalUsd,
        positionCount: p.positions.length,
        unpricedSymbols: p.unpricedSymbols,
        positions: p.positions.map((pos) => ({
          symbol: pos.symbol,
          address: pos.address,
          balance: pos.balance.toString(),
          balanceTokens: pos.balanceTokens,
          uiMultiplier: (Number(pos.uiMultiplier) / 1e18).toString(),
          shareEquivalent: pos.shareEquivalent,
          priceUsd: pos.quote?.priceUsd ?? null,
          valueUsd: pos.valueUsd,
          costBasisUsd: null,
          unrealizedPnlUsd: null,
          link: blockscout.tokenLink(pos.address),
        })),
        basis: {
          valuation: 'balanceTokens * chainlinkPriceUsd (feed is multiplier-adjusted; multiplier not re-applied to value)',
          shareEquivalent: 'balance * uiMultiplier / 1e18',
          costBasis:
            'null — realized/unrealized PnL needs per-trade entry prices, which balances alone do not provide. ' +
            'Feed a trade history to compute PnL client-side using priceUsd as the current mark.',
        },
      },
      [SOURCE.registry, SOURCE.chainlink, SOURCE.rpc],
    )
  })
}
