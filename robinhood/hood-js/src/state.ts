import { createHoodClient, type HoodClient, type HoodNetwork } from 'hoodchain'
import type { Account, Transport } from 'viem'

/** Options for {@link configure} (exposed as `hood.config`). */
export interface HoodConfig {
  /** Custom RPC URL. Overrides the public default and any `alchemyKey`. */
  rpcUrl?: string
  /**
   * Alchemy API key. On mainnet this builds
   * `https://robinhood-mainnet.g.alchemy.com/v2/{key}` for you. Ignored when
   * an explicit `rpcUrl` is set.
   */
  alchemyKey?: string
  /**
   * Affirm you are eligible to acquire Stock Tokens. Stock Tokens are
   * tokenized debt securities that may not be offered, sold, or delivered to
   * US persons (extra limits: Canada, UK, Switzerland). Buying one throws
   * until this is `true`. Selling and reading are never gated.
   * @defaultValue `false`
   */
  acknowledgeEligibility?: boolean
  /**
   * GeckoTerminal network slug used by {@link import('./coins').coins}.
   * @defaultValue `'robinhood'`
   */
  geckoNetwork?: string
}

interface InternalState {
  network: HoodNetwork
  rpcUrl?: string
  alchemyKey?: string
  acknowledgeEligibility: boolean
  geckoNetwork: string
}

const state: InternalState = {
  network: 'mainnet',
  acknowledgeEligibility: false,
  geckoNetwork: 'robinhood',
}

/** Cache of read-only clients, keyed by the config that produced them. */
let cachedClient: HoodClient | null = null
let cachedKey = ''

function stateKey(): string {
  return [state.network, resolveRpcUrl() ?? '', state.acknowledgeEligibility].join('|')
}

function resolveRpcUrl(): string | undefined {
  if (state.rpcUrl) return state.rpcUrl
  if (state.alchemyKey && state.network === 'mainnet') {
    return `https://robinhood-mainnet.g.alchemy.com/v2/${state.alchemyKey}`
  }
  return undefined
}

/** Merge user config into the module state and invalidate the cached client. */
export function configure(config: HoodConfig): void {
  if ('rpcUrl' in config) state.rpcUrl = config.rpcUrl
  if ('alchemyKey' in config) state.alchemyKey = config.alchemyKey
  if ('acknowledgeEligibility' in config) {
    state.acknowledgeEligibility = Boolean(config.acknowledgeEligibility)
  }
  if (config.geckoNetwork) state.geckoNetwork = config.geckoNetwork
  cachedClient = null
}

/** Switch every subsequent call to the given network and drop the cache. */
export function setNetwork(network: HoodNetwork): void {
  if (state.network !== network) {
    state.network = network
    cachedClient = null
  }
}

/** The active network name. */
export function currentNetwork(): HoodNetwork {
  return state.network
}

/** The GeckoTerminal slug for {@link import('./coins').coins}. */
export function geckoNetwork(): string {
  return state.geckoNetwork
}

/** Whether the operator affirmed Stock Token eligibility. */
export function eligibilityAcknowledged(): boolean {
  return state.acknowledgeEligibility
}

/**
 * The memoized read-only hoodchain client for the current config. Rebuilt
 * automatically whenever the network, RPC, or eligibility flag changes.
 */
export function readClient(): HoodClient {
  const key = stateKey()
  if (!cachedClient || cachedKey !== key) {
    cachedClient = createHoodClient({
      chain: state.network,
      rpcUrl: resolveRpcUrl(),
      acknowledgeStockTokenEligibility: state.acknowledgeEligibility,
    })
    cachedKey = key
  }
  return cachedClient
}

/**
 * Build a one-off write client bound to `account` (and optional custom
 * transport for injected providers). Never cached — swaps are explicit.
 */
export function writeClient(account: Account, transport?: Transport): HoodClient {
  return createHoodClient({
    chain: state.network,
    rpcUrl: resolveRpcUrl(),
    transport,
    account,
    acknowledgeStockTokenEligibility: state.acknowledgeEligibility,
  })
}
