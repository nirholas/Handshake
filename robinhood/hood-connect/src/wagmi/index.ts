/**
 * hood-connect/wagmi: ready-made wagmi v2 configuration for Robinhood
 * Chain. For teams already on wagmi; the core kit (`hood-connect`) does not
 * require wagmi or React.
 *
 * Chains come straight from viem's official definitions (`robinhood`,
 * `robinhoodTestnet`), and wagmi's built-in EIP-6963 multi-injected-provider
 * discovery is left on, so every installed wallet shows up as a connector.
 *
 * @packageDocumentation
 */

import { createConfig, http, type Config } from 'wagmi'
import { robinhood, robinhoodTestnet } from 'viem/chains'

export { robinhood, robinhoodTestnet }

/** Options for {@link hoodWagmiConfig}. */
export interface HoodWagmiConfigOptions {
  /** Also register the testnet (chain 46630). Default false. */
  includeTestnet?: boolean
  /** Custom mainnet RPC URL (e.g. an Alchemy endpoint). Defaults to the public RPC. */
  rpcUrl?: string
  /** Custom testnet RPC URL. Defaults to the public testnet RPC. */
  testnetRpcUrl?: string
}

/**
 * Build a wagmi `Config` wired for Robinhood Chain.
 *
 * ```ts
 * import { WagmiProvider } from 'wagmi'
 * import { hoodWagmiConfig } from 'hood-connect/wagmi'
 *
 * const config = hoodWagmiConfig()
 * // <WagmiProvider config={config}>...</WagmiProvider>
 * ```
 */
export function hoodWagmiConfig(options: HoodWagmiConfigOptions = {}): Config {
  const mainnetTransport = options.rpcUrl ? http(options.rpcUrl) : http()
  if (options.includeTestnet) {
    return createConfig({
      chains: [robinhood, robinhoodTestnet],
      transports: {
        [robinhood.id]: mainnetTransport,
        [robinhoodTestnet.id]: options.testnetRpcUrl ? http(options.testnetRpcUrl) : http(),
      },
    })
  }
  return createConfig({
    chains: [robinhood],
    transports: { [robinhood.id]: mainnetTransport },
  })
}
