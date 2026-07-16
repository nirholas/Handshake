import { MAINNET_ADDRESSES, TESTNET_ADDRESSES, USDG_DECIMALS } from 'hoodchain'
import type { Address } from 'viem'

/**
 * Network identity for hood-pay. Everything chain-specific the checkout and
 * the verifier need lives here, derived from the `hoodchain` SDK's verified
 * address book (never retyped by hand).
 */

/** Network selector: `'mainnet'` = chain 4663, `'testnet'` = chain 46630. */
export type HoodPayNetwork = 'mainnet' | 'testnet'

/** A payment token: address + decimals + display symbol. */
export interface PayToken {
  address: Address
  symbol: string
  decimals: number
}

/** Resolved chain parameters for one network. */
export interface NetworkInfo {
  network: HoodPayNetwork
  chainId: number
  rpcUrl: string
  explorerUrl: string
  /** USDG on this network (the default payment token). */
  usdg: PayToken
}

const MAINNET: NetworkInfo = {
  network: 'mainnet',
  chainId: 4663,
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  usdg: { address: MAINNET_ADDRESSES.usdg, symbol: 'USDG', decimals: USDG_DECIMALS },
}

const TESTNET: NetworkInfo = {
  network: 'testnet',
  chainId: 46630,
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
  explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
  usdg: { address: TESTNET_ADDRESSES.usdg, symbol: 'USDG', decimals: USDG_DECIMALS },
}

/** Resolve the {@link NetworkInfo} for a network name. */
export function networkInfo(network: HoodPayNetwork = 'mainnet'): NetworkInfo {
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new RangeError(`Unknown hood-pay network "${String(network)}" (use "mainnet" or "testnet")`)
  }
  return network === 'testnet' ? TESTNET : MAINNET
}

/** Blockscout transaction URL on the given network. */
export function explorerTxUrl(network: HoodPayNetwork, hash: string): string {
  return `${networkInfo(network).explorerUrl}/tx/${hash}`
}

/** Blockscout address URL on the given network. */
export function explorerAddressUrl(network: HoodPayNetwork, address: string): string {
  return `${networkInfo(network).explorerUrl}/address/${address}`
}
