import type { HoodNetwork } from 'hoodchain'

const EXPLORER_BASE: Record<HoodNetwork, string> = {
  mainnet: 'https://robinhoodchain.blockscout.com',
  testnet: 'https://explorer.testnet.chain.robinhood.com',
}

export function explorerTokenUrl(network: HoodNetwork, address: string): string {
  return `${EXPLORER_BASE[network]}/token/${address}`
}

export function explorerAddressUrl(network: HoodNetwork, address: string): string {
  return `${EXPLORER_BASE[network]}/address/${address}`
}

export function explorerTxUrl(network: HoodNetwork, hash: string): string {
  return `${EXPLORER_BASE[network]}/tx/${hash}`
}

/** Blockscout API base for contract verification submission and lookups. */
export function explorerApiUrl(network: HoodNetwork): string {
  return `${EXPLORER_BASE[network]}/api`
}
