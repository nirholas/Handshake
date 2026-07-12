import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem'
import { robinhood, robinhoodTestnet } from 'viem/chains'

/** Network selector for {@link createHoodClient}. */
export type HoodNetwork = 'mainnet' | 'testnet'

/** Configuration for {@link createHoodClient}. */
export interface HoodClientConfig {
  /**
   * Which Robinhood Chain network to target.
   * `'mainnet'` = chain 4663, `'testnet'` = chain 46630.
   * @defaultValue `'mainnet'`
   */
  chain?: HoodNetwork
  /**
   * Custom RPC URL (e.g. an Alchemy endpoint
   * `https://robinhood-mainnet.g.alchemy.com/v2/{key}`). Defaults to the
   * public RPC from viem's official chain definition.
   */
  rpcUrl?: string
  /** Fully custom viem transport. Takes precedence over `rpcUrl`. */
  transport?: Transport
  /**
   * Wallet account for write operations (swaps, transfers). Create one with
   * `privateKeyToAccount(process.env.ROBINHOOD_CHAIN_PRIVATE_KEY)` from
   * `viem/accounts`. Omit for read-only usage.
   */
  account?: Account
  /**
   * Stock Tokens are tokenized debt securities (issuer: Robinhood Assets
   * (Jersey) Ltd) and may not be offered, sold, or delivered to US persons
   * (additional limits: Canada, UK, Switzerland). Swaps that ACQUIRE a Stock
   * Token throw {@link StockTokenEligibilityError} until the operator sets
   * this flag to `true`, affirming they are eligible. Reads and sells are
   * never gated.
   * @defaultValue `false`
   */
  acknowledgeStockTokenEligibility?: boolean
}

/**
 * A connected hoodchain client: a viem public client (multicall batching on),
 * an optional wallet client, and the resolved chain.
 */
export interface HoodClient {
  /** The resolved viem chain object (`robinhood` or `robinhoodTestnet`). */
  chain: Chain
  /** Network name this client was created with. */
  network: HoodNetwork
  /** viem public client for reads. Multicall batching is enabled by default. */
  public: PublicClient
  /** viem wallet client for writes, or `null` when no account was provided. */
  wallet: WalletClient<Transport, Chain, Account> | null
  /** The wallet account, or `null` in read-only mode. */
  account: Account | null
  /** Whether the operator affirmed Stock Token acquisition eligibility. */
  acknowledgeStockTokenEligibility: boolean
}

/**
 * Create a hoodchain client.
 *
 * @example Read-only client on mainnet
 * ```ts
 * import { createHoodClient } from 'hoodchain'
 * const hood = createHoodClient()
 * const block = await hood.public.getBlockNumber()
 * ```
 *
 * @example Wallet client on testnet
 * ```ts
 * import { createHoodClient } from 'hoodchain'
 * import { privateKeyToAccount } from 'viem/accounts'
 * const hood = createHoodClient({
 *   chain: 'testnet',
 *   account: privateKeyToAccount(process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}`),
 * })
 * ```
 */
export function createHoodClient(config: HoodClientConfig = {}): HoodClient {
  const network = config.chain ?? 'mainnet'
  const chain = network === 'testnet' ? robinhoodTestnet : robinhood
  const transport = config.transport ?? http(config.rpcUrl)

  const publicClient = createPublicClient({
    chain,
    transport,
    batch: { multicall: true },
  })

  const wallet = config.account
    ? createWalletClient({ chain, transport, account: config.account })
    : null

  return {
    chain,
    network,
    public: publicClient as PublicClient,
    wallet,
    account: config.account ?? null,
    acknowledgeStockTokenEligibility: config.acknowledgeStockTokenEligibility ?? false,
  }
}
