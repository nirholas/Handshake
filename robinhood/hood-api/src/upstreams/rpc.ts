import { createHoodClient, type HoodClient } from 'hoodchain'
import { resolvedMainnetRpcUrl } from '../lib/env.js'

/**
 * Shared read-only hoodchain clients. One mainnet client (chain 4663) for all
 * market reads; a lazily-created testnet client for the few endpoints that
 * accept `?network=testnet`. No account is attached — this service never signs.
 */

let mainnet: HoodClient | undefined
let testnet: HoodClient | undefined

export function mainnetClient(): HoodClient {
  if (!mainnet) {
    mainnet = createHoodClient({ chain: 'mainnet', rpcUrl: resolvedMainnetRpcUrl() })
  }
  return mainnet
}

export function testnetClient(): HoodClient {
  if (!testnet) testnet = createHoodClient({ chain: 'testnet' })
  return testnet
}

export function clientFor(network: 'mainnet' | 'testnet'): HoodClient {
  return network === 'testnet' ? testnetClient() : mainnetClient()
}
