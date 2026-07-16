import type { Address, Chain } from 'viem'
import { numberToHex } from 'viem'
import { addNetwork, chainForNetwork, getWalletChainId, type HoodNetwork } from './chains.js'
import {
  ChainSwitchRejectedError,
  ConnectionRejectedError,
  HoodConnectError,
  isUnrecognizedChain,
  isUserRejection,
  providerErrorCode,
  providerErrorMessage,
} from './errors.js'
import type { Eip1193Provider } from './provider.js'

/**
 * `ensureChain`: connect, add Robinhood Chain if the wallet does not know
 * it, and switch to it. One call, typed states for every phase, typed
 * errors for every rejection path.
 */

/** Every observable state of the ensure-chain flow. */
export type EnsureChainState =
  | { status: 'connecting' }
  | { status: 'switching'; chainId: number }
  | { status: 'adding'; chainId: number }
  | { status: 'connected'; address: Address; chainId: number }
  | { status: 'error'; error: HoodConnectError }

/** Result of a successful {@link ensureChain}. */
export interface EnsureChainResult {
  address: Address
  chainId: number
}

/** Options for {@link ensureChain}. */
export interface EnsureChainOptions {
  /** Which Robinhood Chain network to ensure. Default `'mainnet'` (4663). */
  network?: HoodNetwork
  /** Ensure an arbitrary viem chain instead (overrides `network`). */
  chain?: Chain
  /** State observer, called on every phase transition (including errors). */
  onState?: (state: EnsureChainState) => void
}

async function requestAccounts(provider: Eip1193Provider): Promise<Address> {
  let accounts: unknown
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' })
  } catch (error) {
    if (isUserRejection(error)) throw new ConnectionRejectedError(error)
    throw new HoodConnectError(`Wallet connection failed: ${providerErrorMessage(error)}`, {
      code: providerErrorCode(error),
      cause: error,
    })
  }
  const address = Array.isArray(accounts) ? (accounts[0] as Address | undefined) : undefined
  if (!address) {
    throw new HoodConnectError('The wallet returned no accounts.')
  }
  return address
}

async function switchChain(provider: Eip1193Provider, chain: Chain): Promise<void> {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: numberToHex(chain.id) }],
    })
  } catch (error) {
    if (isUserRejection(error)) {
      throw new ChainSwitchRejectedError(`Switching to ${chain.name} was rejected in the wallet.`, {
        code: 4001,
        cause: error,
      })
    }
    throw error
  }
}

/**
 * Connect the wallet, then make sure it is on the requested Robinhood Chain
 * network: switch when the wallet already knows the chain, add it via
 * EIP-3085 when it does not (code 4902, including MetaMask's nested
 * variants), then verify the final chain ID.
 *
 * @throws {@link ConnectionRejectedError} user rejected `eth_requestAccounts`.
 * @throws {@link ChainAddRejectedError} user or wallet refused the add.
 * @throws {@link ChainSwitchRejectedError} user or wallet refused the switch,
 *   or the wallet claimed success but stayed on the wrong chain.
 */
export async function ensureChain(
  provider: Eip1193Provider,
  options: EnsureChainOptions = {},
): Promise<EnsureChainResult> {
  const chain = options.chain ?? chainForNetwork(options.network)
  const emit = options.onState ?? (() => {})

  try {
    emit({ status: 'connecting' })
    const address = await requestAccounts(provider)

    let current = await getWalletChainId(provider)

    if (current !== chain.id) {
      emit({ status: 'switching', chainId: chain.id })
      try {
        await switchChain(provider, chain)
      } catch (error) {
        if (error instanceof ChainSwitchRejectedError) throw error
        if (!isUnrecognizedChain(error)) {
          throw new ChainSwitchRejectedError(
            `The wallet could not switch to ${chain.name}: ${providerErrorMessage(error)}`,
            { code: providerErrorCode(error), cause: error },
          )
        }
        // Chain unknown to the wallet: add it (throws ChainAddRejectedError
        // on refusal), then switch again unless the wallet auto-switched.
        emit({ status: 'adding', chainId: chain.id })
        await addNetwork(provider, { chain })
        current = await getWalletChainId(provider)
        if (current !== chain.id) {
          emit({ status: 'switching', chainId: chain.id })
          try {
            await switchChain(provider, chain)
          } catch (error2) {
            if (error2 instanceof ChainSwitchRejectedError) throw error2
            throw new ChainSwitchRejectedError(
              `The wallet added ${chain.name} but could not switch to it: ${providerErrorMessage(error2)}`,
              { code: providerErrorCode(error2), cause: error2 },
            )
          }
        }
      }

      current = await getWalletChainId(provider)
      if (current !== chain.id) {
        throw new ChainSwitchRejectedError(
          `The wallet reported success but is on chain ${current}, not ${chain.id} (${chain.name}).`,
        )
      }
    }

    const result: EnsureChainResult = { address, chainId: chain.id }
    emit({ status: 'connected', ...result })
    return result
  } catch (error) {
    const wrapped =
      error instanceof HoodConnectError
        ? error
        : new HoodConnectError(providerErrorMessage(error), { code: providerErrorCode(error), cause: error })
    emit({ status: 'error', error: wrapped })
    throw wrapped
  }
}
