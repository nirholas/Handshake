import type { Address, Chain } from 'viem'
import { robinhood, robinhoodTestnet } from 'viem/chains'

/**
 * Robinhood Chain network registry for the x402 `exact` rail.
 *
 * Every fact below was verified on-chain on 2026-07-12 (reproduce with
 * `npm run verify:usdg`):
 * - USDG is a facet/diamond stablecoin exposing EIP-3009
 *   `transferWithAuthorization` (`getFacet(0xe3ee160e)` → non-zero facet on both
 *   networks), 6 decimals.
 * - Its EIP-712 domain reconstructs to exactly match the on-chain
 *   `DOMAIN_SEPARATOR()`: `name="Global Dollar", version="1"`, with the chain id
 *   and the USDG proxy as `verifyingContract`.
 */
export interface HoodNetwork {
  /** Canonical x402 network identifier emitted in challenges. */
  readonly id: string
  /** EVM chain id. */
  readonly chainId: number
  /** viem chain definition (official, from `viem/chains`). */
  readonly chain: Chain
  /** Default public RPC endpoint. */
  readonly rpcUrl: string
  /** Blockscout explorer base URL. */
  readonly explorerUrl: string
  /** USDG (Paxos Global Dollar) token address on this network. */
  readonly usdg: Address
  /** USDG decimals (6 on both networks). */
  readonly usdgDecimals: number
  /** EIP-712 domain fields for USDG's `TransferWithAuthorization` signature. */
  readonly usdgDomain: { readonly name: string; readonly version: string }
  /** Whether this is a test network. */
  readonly testnet: boolean
}

export const ROBINHOOD_MAINNET: HoodNetwork = {
  id: 'robinhood',
  chainId: 4663,
  chain: robinhood,
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  usdgDecimals: 6,
  usdgDomain: { name: 'Global Dollar', version: '1' },
  testnet: false,
}

export const ROBINHOOD_TESTNET: HoodNetwork = {
  id: 'robinhood-testnet',
  chainId: 46630,
  chain: robinhoodTestnet,
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
  explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
  usdg: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
  usdgDecimals: 6,
  usdgDomain: { name: 'Global Dollar', version: '1' },
  testnet: true,
}

/**
 * Accepted aliases for each network. The middleware's `network: 'robinhood'`
 * and three.ws's `network: 'robinhood-chain'` both resolve here, so callers
 * never have to memorize the canonical id.
 */
const ALIASES: Record<string, HoodNetwork> = {
  robinhood: ROBINHOOD_MAINNET,
  'robinhood-chain': ROBINHOOD_MAINNET,
  'robinhood-mainnet': ROBINHOOD_MAINNET,
  'eip155:4663': ROBINHOOD_MAINNET,
  '4663': ROBINHOOD_MAINNET,
  'robinhood-testnet': ROBINHOOD_TESTNET,
  'robinhood-sepolia': ROBINHOOD_TESTNET,
  'eip155:46630': ROBINHOOD_TESTNET,
  '46630': ROBINHOOD_TESTNET,
}

/** Resolve a network by id/alias/chainId. Returns `undefined` if unknown. */
export function resolveNetwork(idOrChainId: string | number): HoodNetwork | undefined {
  return ALIASES[String(idOrChainId).toLowerCase()]
}

/** Resolve a network, throwing a descriptive error when unknown. */
export function requireNetwork(idOrChainId: string | number): HoodNetwork {
  const net = resolveNetwork(idOrChainId)
  if (!net) {
    throw new Error(
      `hood402: unknown network "${idOrChainId}". Supported: ${Object.keys(ALIASES).join(', ')}`,
    )
  }
  return net
}

/** Every distinct network hood402 supports. */
export const NETWORKS: readonly HoodNetwork[] = [ROBINHOOD_MAINNET, ROBINHOOD_TESTNET]
