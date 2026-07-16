import { encodeFunctionData, type Address, type Hex } from 'viem'
import { erc20Abi, hoodPayRouterAbi } from './abi.js'

/**
 * Unsigned transaction builders. hood-pay NEVER holds keys: these produce
 * `{ to, data }` (plus value 0) for the buyer's own wallet - or the
 * merchant's, for refunds - to sign. Every builder is covered by a unit
 * test that pins the exact calldata.
 */

/** An unsigned call: pass to `eth_sendTransaction` / viem `sendTransaction`. */
export interface UnsignedCall {
  to: Address
  data: Hex
  value: 0n
}

/** Direct mode: plain ERC-20 `transfer(payTo, rawAmount)` on the token. */
export function buildTransferTx(token: Address, payTo: Address, rawAmount: bigint): UnsignedCall {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [payTo, rawAmount] }),
    value: 0n,
  }
}

/**
 * Router mode, step 1: `approve(router, rawAmount)` on the token. hood-pay
 * uses an explicit approve for the router allowance (never a permit
 * signature), approving the EXACT invoice amount, never unlimited.
 */
export function buildApproveTx(token: Address, router: Address, rawAmount: bigint): UnsignedCall {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, rawAmount] }),
    value: 0n,
  }
}

/** Router mode, step 2: `pay(token, payTo, rawAmount, reference)` on the router. */
export function buildRouterPayTx(
  router: Address,
  token: Address,
  payTo: Address,
  rawAmount: bigint,
  reference: Hex,
): UnsignedCall {
  return {
    to: router,
    data: encodeFunctionData({
      abi: hoodPayRouterAbi,
      functionName: 'pay',
      args: [token, payTo, rawAmount, reference],
    }),
    value: 0n,
  }
}
