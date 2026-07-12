import type { HoodClient } from 'hoodchain'
import { MAINNET_ADDRESSES, TESTNET_ADDRESSES, quoteSwap, formatUsdg, NoRouteError } from 'hoodchain'
import { CapExceededError, KilledError, ResponsibilityNotAffirmedError } from '../errors.js'
import type { OperatorConfig } from './config.js'
import type { KillSwitch } from './kill-switch.js'
import type { LaunchLedger } from './ledger.js'

/**
 * Estimate the USDG-equivalent value of a native-ETH amount via a live
 * on-chain Uniswap v3 quote (WETH → USDG). Returns `null` when no route
 * exists (e.g. testnet's thin liquidity) rather than fabricating a price —
 * callers should treat `null` as "cap could not be verified, warn and let
 * the operator judge" per the CLAUDE.md no-fake-data rule.
 */
export async function estimateUsdgValue(client: HoodClient, weiAmount: bigint): Promise<number | null> {
  if (weiAmount === 0n) return 0
  const addrs = client.network === 'mainnet' ? MAINNET_ADDRESSES : TESTNET_ADDRESSES
  try {
    const quote = await quoteSwap(client, { tokenIn: addrs.weth, tokenOut: addrs.usdg, amountIn: weiAmount })
    return Number(formatUsdg(quote.amountOut))
  } catch (err) {
    if (err instanceof NoRouteError) return null
    throw err
  }
}

/**
 * Enforce every launch-time hard cap: kill switch, live-mode responsibility
 * acknowledgement, `MAX_LAUNCHES_PER_DAY`, and `MAX_SEED_USDG`. Throws the
 * specific typed error on the first violation; callers should let these
 * propagate (never swallow a cap failure).
 */
export async function enforceCaps(
  config: OperatorConfig,
  ledger: LaunchLedger,
  killSwitch: KillSwitch,
  client: HoodClient,
  seedWei: bigint,
): Promise<{ usdgEstimate: number | null }> {
  const kill = killSwitch.reasonIfEngaged()
  if (kill) throw new KilledError(kill)

  if (config.live && !config.acknowledgeLaunchResponsibility) {
    throw new ResponsibilityNotAffirmedError()
  }

  const launchedToday = ledger.countLaunchedInWindow(24)
  if (launchedToday >= config.maxLaunchesPerDay) {
    throw new CapExceededError(
      'MAX_LAUNCHES_PER_DAY',
      `${launchedToday}/${config.maxLaunchesPerDay} launches already recorded in the last 24h`,
    )
  }

  const usdgEstimate = await estimateUsdgValue(client, seedWei)
  if (usdgEstimate !== null && usdgEstimate > config.maxSeedUsdgEquivalent) {
    throw new CapExceededError(
      'MAX_SEED_USDG',
      `seed ≈ $${usdgEstimate.toFixed(2)} USDG exceeds cap $${config.maxSeedUsdgEquivalent}`,
    )
  }

  return { usdgEstimate }
}
