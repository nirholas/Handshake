/**
 * Minimal ABI fragments for the USDG facet on Robinhood Chain.
 *
 * USDG (Paxos Global Dollar) is a facet/diamond stablecoin. The EIP-3009
 * surface (`transferWithAuthorization`, `authorizationState`) is registered to
 * a facet — verified on-chain via `getFacet(bytes4)` returning a non-zero
 * implementation for selectors `0xe3ee160e` and `0xe94a0102` on both mainnet
 * (chain 4663) and testnet (46630). See `scripts/verify-usdg.mjs` to reproduce.
 *
 * The `transferWithAuthorization` selector on USDG is the split `(v, r, s)`
 * form (`0xe3ee160e`), the same form used by Circle's USDC — so any standard
 * x402 `exact` facilitator settles USDG without modification.
 */

/** EIP-3009 `transferWithAuthorization` (v, r, s form) — selector 0xe3ee160e. */
export const eip3009Abi = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/** ERC-20 reads used during verification. */
export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const
