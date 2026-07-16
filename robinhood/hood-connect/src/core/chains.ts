import { numberToHex, type Chain } from 'viem'
import { robinhood, robinhoodTestnet } from 'viem/chains'
import { ChainAddRejectedError, isUserRejection, providerErrorMessage, providerErrorCode } from './errors.js'
import type { Eip1193Provider } from './provider.js'

/**
 * Chain identity. Everything here is DERIVED at runtime from viem's official
 * `robinhood` / `robinhoodTestnet` chain definitions (viem >= 2.55.0). No
 * chain parameter is ever duplicated by hand; if viem updates an RPC URL or
 * explorer, this kit follows automatically. `tests/chain-params.test.ts`
 * enforces the derivation.
 */

export { robinhood, robinhoodTestnet }

/** Network selector: `'mainnet'` = chain 4663, `'testnet'` = chain 46630. */
export type HoodNetwork = 'mainnet' | 'testnet'

/** Robinhood Chain mainnet chain ID (4663), from the viem chain definition. */
export const ROBINHOOD_CHAIN_ID: number = robinhood.id

/** Robinhood Chain testnet chain ID (46630), from the viem chain definition. */
export const ROBINHOOD_TESTNET_CHAIN_ID: number = robinhoodTestnet.id

/** Resolve a viem `Chain` for a hood-connect network name. */
export function chainForNetwork(network: HoodNetwork = 'mainnet'): Chain {
  return network === 'testnet' ? robinhoodTestnet : robinhood
}

/** EIP-3085 `wallet_addEthereumChain` parameter object. */
export interface AddEthereumChainParameter {
  chainId: `0x${string}`
  chainName: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  rpcUrls: readonly string[]
  blockExplorerUrls?: readonly string[]
}

/**
 * Build EIP-3085 parameters from a viem chain definition. Used for both
 * Robinhood Chain networks; works for any viem chain.
 */
export function toAddChainParams(chain: Chain): AddEthereumChainParameter {
  const explorer = chain.blockExplorers?.default?.url
  const params: AddEthereumChainParameter = {
    chainId: numberToHex(chain.id),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: chain.rpcUrls.default.http,
  }
  if (explorer) params.blockExplorerUrls = [explorer]
  return params
}

/** Options for {@link addNetwork}. */
export interface AddNetworkOptions {
  /** Which Robinhood Chain network to add. Default `'mainnet'`. */
  network?: HoodNetwork
  /** Add an arbitrary viem chain instead (overrides `network`). */
  chain?: Chain
}

/**
 * Prompt the wallet to add Robinhood Chain via EIP-3085
 * `wallet_addEthereumChain`, with parameters derived from viem's official
 * chain definition. Most wallets switch to the chain as part of approving
 * the add; use {@link ensureChain} for the guaranteed full flow.
 *
 * @throws {@link ChainAddRejectedError} when the user or wallet refuses.
 */
export async function addNetwork(provider: Eip1193Provider, options: AddNetworkOptions = {}): Promise<void> {
  const chain = options.chain ?? chainForNetwork(options.network)
  try {
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [toAddChainParams(chain)],
    })
  } catch (error) {
    if (isUserRejection(error)) {
      throw new ChainAddRejectedError(`Adding ${chain.name} was rejected in the wallet.`, { code: 4001, cause: error })
    }
    throw new ChainAddRejectedError(
      `The wallet could not add ${chain.name}: ${providerErrorMessage(error)}`,
      { code: providerErrorCode(error), cause: error },
    )
  }
}

/** Read the wallet's current chain ID (`eth_chainId`, hex) as a number. */
export async function getWalletChainId(provider: Eip1193Provider): Promise<number> {
  const hex = (await provider.request({ method: 'eth_chainId' })) as string
  return Number.parseInt(hex, 16)
}
