import { formatUnits, parseUnits, type Address, type Hash } from 'viem'
import { erc20Abi } from './abis.js'
import { MAINNET_ADDRESSES, TESTNET_ADDRESSES, USDG_DECIMALS } from './addresses.js'
import type { HoodClient } from './client.js'
import { NoAccountError } from './errors.js'

/**
 * USDG — Paxos Global Dollar, Robinhood Chain's dollar stablecoin.
 *
 * Facts verified on Blockscout during SDK development:
 * - Mainnet address `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (ERC-1967
 *   proxy onto Paxos' verified `USDG` implementation), **6 decimals**.
 * - USDG does **not** implement EIP-2612 `permit` — the verified
 *   implementation ABI has no `permit`, `nonces`, or EIP-2612 surface, so
 *   gasless approvals are not possible; use a normal `approve`.
 */

/** USDG contract address for the client's network. */
export function usdgAddress(client: HoodClient): Address {
  return client.network === 'testnet' ? TESTNET_ADDRESSES.usdg : MAINNET_ADDRESSES.usdg
}

/** Format a raw 6-decimal USDG amount as a decimal string. */
export function formatUsdg(amount: bigint): string {
  return formatUnits(amount, USDG_DECIMALS)
}

/** Parse a decimal string (e.g. `"12.50"`) into a raw 6-decimal USDG amount. */
export function parseUsdg(amount: string): bigint {
  return parseUnits(amount, USDG_DECIMALS)
}

/** USDG balance of `owner` (raw, 6 decimals — use {@link formatUsdg} to display). */
export async function getUsdgBalance(client: HoodClient, owner: Address): Promise<bigint> {
  return client.public.readContract({
    address: usdgAddress(client),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })
}

/** USDG total supply on the client's network (raw, 6 decimals). */
export async function getUsdgTotalSupply(client: HoodClient): Promise<bigint> {
  return client.public.readContract({
    address: usdgAddress(client),
    abi: erc20Abi,
    functionName: 'totalSupply',
  })
}

/**
 * Transfer USDG. Requires a wallet account on the client.
 * @returns The transaction hash. Await confirmation with
 * `client.public.waitForTransactionReceipt({ hash })`.
 */
export async function transferUsdg(client: HoodClient, to: Address, amount: bigint): Promise<Hash> {
  if (!client.wallet) throw new NoAccountError('transferUsdg')
  return client.wallet.writeContract({
    address: usdgAddress(client),
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
  })
}

/**
 * Approve `spender` for `amount` USDG. Requires a wallet account.
 *
 * USDG has no EIP-2612 `permit` (verified on the Blockscout-verified
 * implementation), so on-chain `approve` is the only allowance mechanism.
 */
export async function approveUsdg(client: HoodClient, spender: Address, amount: bigint): Promise<Hash> {
  if (!client.wallet) throw new NoAccountError('approveUsdg')
  return client.wallet.writeContract({
    address: usdgAddress(client),
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  })
}

/** Current USDG allowance from `owner` to `spender` (raw, 6 decimals). */
export async function getUsdgAllowance(
  client: HoodClient,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return client.public.readContract({
    address: usdgAddress(client),
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })
}
