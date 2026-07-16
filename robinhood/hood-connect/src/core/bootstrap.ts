import { createHoodClient, formatUsdg, getUsdgBalance } from 'hoodchain'
import { formatEther, type Address } from 'viem'
import { chainForNetwork, type HoodNetwork } from './chains.js'

/**
 * Balance bootstrap check: a freshly-added wallet on chain 4663 is almost
 * always empty (no wallet ships Robinhood Chain by default, so nobody
 * arrives with gas). This module detects the empty state and returns the
 * concrete funding options a dApp should surface next.
 */

/** One way to get funds onto Robinhood Chain. */
export interface FundingOption {
  id: 'bridge' | 'robinhood-app' | 'faucet' | 'chainlink-faucet'
  label: string
  description: string
  /** External URL when the option lives outside the dApp. */
  url?: string
}

/** Result of {@link checkBootstrap}. */
export interface BootstrapStatus {
  address: Address
  network: HoodNetwork
  chainId: number
  /** Native ETH balance, wei. */
  eth: bigint
  /** ETH balance formatted as a decimal string. */
  ethFormatted: string
  /** USDG balance, raw 6-decimal units. */
  usdg: bigint
  /** USDG balance formatted as a decimal string. */
  usdgFormatted: string
  /** True when the wallet holds any ETH or USDG on this network. */
  funded: boolean
  /** Ways to fund the wallet, ordered by how fast they get the user moving. */
  fundingOptions: FundingOption[]
}

/** Options for {@link checkBootstrap}. */
export interface CheckBootstrapOptions {
  /** Network to check. Default `'mainnet'`. */
  network?: HoodNetwork
  /** Custom RPC URL (e.g. an Alchemy endpoint). Defaults to the public RPC. */
  rpcUrl?: string
}

/** Funding options surfaced for an empty wallet, per network. */
export function fundingOptionsFor(network: HoodNetwork): FundingOption[] {
  if (network === 'testnet') {
    return [
      {
        id: 'faucet',
        label: 'Official testnet faucet',
        description: 'Drips testnet ETH and test Stock Tokens (TSLA, AMZN, PLTR, NFLX, AMD). Requires Google sign-in in a browser.',
        url: 'https://faucet.testnet.chain.robinhood.com/',
      },
      {
        id: 'chainlink-faucet',
        label: 'Chainlink faucet',
        description: 'Alternative testnet ETH drip from Chainlink.',
        url: 'https://faucets.chain.link/robinhood-testnet',
      },
    ]
  }
  return [
    {
      id: 'bridge',
      label: 'Bridge from another chain',
      description: 'Move ETH or USDC from any major chain to Robinhood Chain in one transaction, routed live through LI.FI with Relay fallback. Use the FundWallet component or getFundingQuote().',
    },
    {
      id: 'robinhood-app',
      label: 'Withdraw from the Robinhood app',
      description: 'Robinhood Wallet and the Robinhood app can send ETH directly to your address on Robinhood Chain. Open Crypto, pick ETH, choose Send, select the Robinhood Chain network, and paste this address.',
      url: 'https://docs.robinhood.com/chain/',
    },
  ]
}

/**
 * Read the wallet's ETH and USDG balances on Robinhood Chain (public RPC by
 * default) and report whether it needs funding. Read-only; safe to call for
 * any address.
 */
export async function checkBootstrap(
  address: Address,
  options: CheckBootstrapOptions = {},
): Promise<BootstrapStatus> {
  const network = options.network ?? 'mainnet'
  const hood = createHoodClient({
    chain: network,
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
  })

  const [eth, usdg] = await Promise.all([
    hood.public.getBalance({ address }),
    getUsdgBalance(hood, address),
  ])

  const funded = eth > 0n || usdg > 0n
  return {
    address,
    network,
    chainId: chainForNetwork(network).id,
    eth,
    ethFormatted: formatEther(eth),
    usdg,
    usdgFormatted: formatUsdg(usdg),
    funded,
    fundingOptions: funded ? [] : fundingOptionsFor(network),
  }
}
