import type { Address, PublicClient } from 'viem'
import { erc8056Abi, INTERFACE_IDS } from './abi.js'

/** Thrown by {@link readUiMultiplier} when `token` does not implement ERC-8056. */
export class Erc8056NotImplementedError extends Error {
  override readonly name = 'Erc8056NotImplementedError'
  readonly token: Address

  constructor(token: Address) {
    super(
      `${token} does not implement ERC-8056: uiMultiplier() reverted or returned no data. ` +
        'Use supportsErc8056() to gate reads, or treat the token as multiplier 1e18 only if ' +
        'you know it is not a scaled asset.',
    )
    this.token = token
  }
}

/** Result of {@link detectErc8056}. */
export interface Erc8056Support {
  /** `true` when the token answers `uiMultiplier()` with a uint256. */
  supported: boolean
  /**
   * `true` when support was confirmed via ERC-165
   * `supportsInterface(0xa60bf13d)` (the spec REQUIRES ERC-165). `false`
   * with `supported: true` means the token exposes `uiMultiplier()` without
   * ERC-165 - usable, but not spec-compliant.
   */
  viaErc165: boolean
  /** Optional-extension flags (each `false` when ERC-165 is unavailable). */
  extensions: {
    /** `IScaledUIAmountNewUIMultiplier` (`newUIMultiplier`/`effectiveAt`), `0x4bd27648`. */
    pendingMultiplier: boolean
    /** `IScaledUIAmountConversion` (`toUIAmount`/`fromUIAmount`), `0x57854fc3`. */
    conversion: boolean
    /** `IScaledUIAmountBalances` (`balanceOfUI`/`totalSupplyUI`), `0xd890fd71`. */
    balances: boolean
  }
}

/**
 * `true` when `token` implements ERC-8056. Never throws: a plain ERC-20
 * (no ERC-165, no `uiMultiplier`) resolves to `false`.
 *
 * Detection order follows the spec's integration guidance: try ERC-165
 * `supportsInterface(0xa60bf13d)` first (compliant contracts MUST implement
 * it), then fall back to probing `uiMultiplier()` directly for
 * non-compliant partial implementers.
 */
export async function supportsErc8056(client: PublicClient, token: Address): Promise<boolean> {
  const { supported } = await detectErc8056(client, token)
  return supported
}

/**
 * Full ERC-8056 capability report for `token`: core support, whether ERC-165
 * confirmed it, and which optional extensions are declared.
 *
 * Ground truth on Robinhood Chain (read live during development): every
 * canonical Stock Token reports core + pendingMultiplier + balances `true`
 * and conversion `false`.
 */
export async function detectErc8056(client: PublicClient, token: Address): Promise<Erc8056Support> {
  const [core, pending, conversion, balances] = await Promise.all(
    [
      INTERFACE_IDS.scaledUiAmount,
      INTERFACE_IDS.newUiMultiplier,
      INTERFACE_IDS.conversion,
      INTERFACE_IDS.balances,
    ].map((id) => readSupportsInterface(client, token, id)),
  )

  if (core === true) {
    return {
      supported: true,
      viaErc165: true,
      extensions: {
        pendingMultiplier: pending === true,
        conversion: conversion === true,
        balances: balances === true,
      },
    }
  }

  // No ERC-165 (or it denies support): probe uiMultiplier() directly so
  // partial implementers still work.
  const probed = await probeUiMultiplier(client, token)
  return {
    supported: probed !== null,
    viaErc165: false,
    extensions: { pendingMultiplier: false, conversion: false, balances: false },
  }
}

async function readSupportsInterface(
  client: PublicClient,
  token: Address,
  interfaceId: string,
): Promise<boolean | null> {
  try {
    return await client.readContract({
      address: token,
      abi: erc8056Abi,
      functionName: 'supportsInterface',
      args: [interfaceId as `0x${string}`],
    })
  } catch {
    return null
  }
}

async function probeUiMultiplier(client: PublicClient, token: Address): Promise<bigint | null> {
  try {
    const value = await client.readContract({
      address: token,
      abi: erc8056Abi,
      functionName: 'uiMultiplier',
    })
    return value > 0n ? value : null
  } catch {
    return null
  }
}

/**
 * Read `uiMultiplier()`: underlying shares per token, 18-decimal fixed point
 * (`1000000000000000000n` = 1.0).
 *
 * @throws {@link Erc8056NotImplementedError} when the call reverts or
 * returns no data - i.e. `token` is not an ERC-8056 implementer. Gate with
 * {@link supportsErc8056} where a non-implementer is an expected input.
 *
 * @example
 * ```ts
 * const multiplier = await readUiMultiplier(client, WEEK)
 * // 2006182524271844660n on 2026-07-15: 1 WEEK token = 2.0062 shares
 * ```
 */
export async function readUiMultiplier(client: PublicClient, token: Address): Promise<bigint> {
  const value = await probeUiMultiplier(client, token)
  if (value === null) throw new Erc8056NotImplementedError(token)
  return value
}

/** Result of {@link readMultiplierState}. */
export interface MultiplierState {
  /** The active `uiMultiplier()`. */
  current: bigint
  /** Raw `newUIMultiplier()` (equals a past-applied value when nothing is pending). */
  newMultiplier: bigint
  /** Raw `effectiveAt()` unix seconds (`0n` when never scheduled). */
  effectiveAt: bigint
  /**
   * A scheduled, not-yet-effective change, or `null`. Robinhood's
   * implementation keeps `newUIMultiplier`/`effectiveAt` populated with the
   * LAST APPLIED update after it takes effect (observed on-chain: SGOV's
   * `effectiveAt` stays at 1783541672 after activation), so "pending" means
   * `effectiveAt` is in the future AND the values differ.
   */
  pending: { multiplier: bigint; effectiveAt: Date } | null
}

/**
 * Read the full multiplier state, including any scheduled corporate action
 * (`IScaledUIAmountNewUIMultiplier` extension).
 *
 * @throws {@link Erc8056NotImplementedError} when `token` does not implement
 * ERC-8056 at all. Tokens that implement the core interface but not the
 * pending extension yield `pending: null` with `newMultiplier === current`.
 */
export async function readMultiplierState(client: PublicClient, token: Address): Promise<MultiplierState> {
  const current = await readUiMultiplier(client, token)

  let newMultiplier = current
  let effectiveAt = 0n
  try {
    ;[newMultiplier, effectiveAt] = await Promise.all([
      client.readContract({ address: token, abi: erc8056Abi, functionName: 'newUIMultiplier' }),
      client.readContract({ address: token, abi: erc8056Abi, functionName: 'effectiveAt' }),
    ])
  } catch {
    // Core-only implementer: pending extension absent.
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const isPending = effectiveAt > nowSeconds && newMultiplier !== current
  return {
    current,
    newMultiplier,
    effectiveAt,
    pending: isPending
      ? { multiplier: newMultiplier, effectiveAt: new Date(Number(effectiveAt) * 1000) }
      : null,
  }
}

/** One decoded `UIMultiplierUpdated` corporate-action event. */
export interface MultiplierUpdate {
  /** The multiplier before the change (18-decimal fixed point). */
  oldMultiplier: bigint
  /** The multiplier the change activates (18-decimal fixed point). */
  newMultiplier: bigint
  /** When the new multiplier takes effect. */
  effectiveAt: Date
  blockNumber: bigint
  transactionHash: `0x${string}`
}

/**
 * Watch `token` for corporate actions: invokes `onUpdate` for every
 * `UIMultiplierUpdated` event (spec: MUST be emitted whenever the multiplier
 * changes; all parameters non-indexed; topic0
 * `0x2205df45...b055` - a real instance is SGOV's 2026-07-08 dividend
 * reinvestment at block 4629631, tx `0x79292bc8...fbfb`).
 *
 * Uses viem's polling event watcher, so it works against plain HTTP
 * transports like the public Robinhood Chain RPC. Returns the unwatch
 * function.
 */
export function watchMultiplier(
  client: PublicClient,
  token: Address,
  onUpdate: (update: MultiplierUpdate) => void,
  options: { onError?: (error: Error) => void; pollingInterval?: number } = {},
): () => void {
  return client.watchContractEvent({
    address: token,
    abi: erc8056Abi,
    eventName: 'UIMultiplierUpdated',
    ...(options.pollingInterval !== undefined ? { pollingInterval: options.pollingInterval } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    onLogs: (logs) => {
      for (const log of logs) {
        const { oldMultiplier, newMultiplier, effectiveAtTimestamp } = log.args
        if (
          oldMultiplier === undefined ||
          newMultiplier === undefined ||
          effectiveAtTimestamp === undefined ||
          log.blockNumber === null ||
          log.transactionHash === null
        ) {
          continue // pending log from an unconfirmed block; the confirmed one follows
        }
        onUpdate({
          oldMultiplier,
          newMultiplier,
          effectiveAt: new Date(Number(effectiveAtTimestamp) * 1000),
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        })
      }
    },
  })
}
