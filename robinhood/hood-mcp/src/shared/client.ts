/**
 * Build a hoodchain client from environment configuration, shared by both
 * servers. The data server calls {@link readOnlyClient}; the trading server
 * calls {@link walletClientFromEnv}.
 */

import { createHoodClient } from 'hoodchain'
import type { HoodClient, HoodNetwork } from 'hoodchain'
import { privateKeyToAccount } from 'viem/accounts'

/** Resolve the target network from `HOOD_MCP_NETWORK` (default mainnet). */
export function resolveNetwork(env: NodeJS.ProcessEnv = process.env): HoodNetwork {
  const raw = (env.HOOD_MCP_NETWORK ?? 'mainnet').toLowerCase()
  if (raw === 'testnet') return 'testnet'
  if (raw === 'mainnet') return 'mainnet'
  throw new Error(`HOOD_MCP_NETWORK must be "mainnet" or "testnet" (got "${raw}")`)
}

/**
 * Build the RPC URL: an Alchemy endpoint when `ALCHEMY_KEY` is set (faster,
 * private, higher limits), otherwise the SDK's public-RPC default.
 */
function rpcUrl(network: HoodNetwork, env: NodeJS.ProcessEnv): string | undefined {
  const key = env.ALCHEMY_KEY
  if (!key) return undefined
  return network === 'testnet'
    ? `https://robinhood-testnet.g.alchemy.com/v2/${key}`
    : `https://robinhood-mainnet.g.alchemy.com/v2/${key}`
}

/** A read-only client — no wallet, no key required. */
export function readOnlyClient(env: NodeJS.ProcessEnv = process.env): HoodClient {
  const network = resolveNetwork(env)
  return createHoodClient({ chain: network, rpcUrl: rpcUrl(network, env) })
}

/**
 * A wallet-backed client from `ROBINHOOD_CHAIN_PRIVATE_KEY`. Throws with a
 * precise message if the key is missing or malformed.
 */
export function walletClientFromEnv(env: NodeJS.ProcessEnv = process.env): HoodClient {
  const network = resolveNetwork(env)
  const key = env.ROBINHOOD_CHAIN_PRIVATE_KEY
  if (!key) {
    throw new Error('ROBINHOOD_CHAIN_PRIVATE_KEY is not set — the trading server needs a wallet key.')
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('ROBINHOOD_CHAIN_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string (66 chars).')
  }
  const account = privateKeyToAccount(key as `0x${string}`)
  return createHoodClient({
    chain: network,
    rpcUrl: rpcUrl(network, env),
    account,
    acknowledgeStockTokenEligibility: env.HOOD_MCP_ACKNOWLEDGE_ELIGIBILITY === '1',
  })
}
