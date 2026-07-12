/**
 * The `maxSpendUsd` guard rail (`hood config set maxSpendUsd <n>`): a hard
 * ceiling on the USD value of a single swap or transfer. The USD-estimation
 * step is network-bound (oracle/DEX price lookups) and lives in the command
 * modules; this function is the pure decision so it is unit-testable without
 * a live RPC.
 */
import { guardError } from './errors.js'

export interface SpendCapCheck {
  /** The configured cap, or undefined when no cap is set (no-op). */
  maxSpendUsd: number | undefined
  /** Estimated USD value of the spend, or null when it could not be priced. */
  estimatedUsd: number | null
}

/**
 * Throws a GUARD error when `estimatedUsd` exceeds `maxSpendUsd`. A `null`
 * estimate (unpriceable token) never blocks — callers should surface a
 * warning instead, since refusing an unpriceable send would make the cap
 * unusable for memecoins with no oracle or liquid pool.
 */
export function checkSpendCap({ maxSpendUsd, estimatedUsd }: SpendCapCheck): void {
  if (maxSpendUsd === undefined) return
  if (estimatedUsd === null) return
  if (estimatedUsd > maxSpendUsd) {
    throw guardError(
      `This spends ~$${estimatedUsd.toFixed(2)}, which exceeds your configured cap of $${maxSpendUsd.toFixed(2)}.`,
      'Raise the cap with `hood config set maxSpendUsd <n>`, or reduce --amount.',
    )
  }
}
