import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { NETWORKS, requireNetwork, type HoodNetwork } from 'hood402'

export interface NetworkRuntime {
  net: HoodNetwork
  publicClient: PublicClient
  walletClient: WalletClient
}

export interface FacilitatorConfig {
  port: number
  ledgerPath: string
  signerAddress: `0x${string}`
  runtimes: Map<string, NetworkRuntime>
}

function rpcFor(net: HoodNetwork): string {
  const key = net.testnet ? 'ROBINHOOD_TESTNET_RPC_URL' : 'ROBINHOOD_RPC_URL'
  return process.env[key] ?? net.rpcUrl
}

/** Load configuration from the environment, building a viem runtime per network. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const pk = env['FACILITATOR_PRIVATE_KEY']
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(
      'hood402-facilitator: FACILITATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key',
    )
  }
  const account = privateKeyToAccount(pk as `0x${string}`)

  const requested = (env['FACILITATOR_NETWORKS'] ?? 'robinhood,robinhood-testnet')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const runtimes = new Map<string, NetworkRuntime>()
  for (const id of requested) {
    const net = requireNetwork(id)
    if (runtimes.has(net.id)) continue
    const rpc = rpcFor(net)
    const publicClient = createPublicClient({ chain: net.chain, transport: http(rpc) })
    const walletClient = createWalletClient({ account, chain: net.chain, transport: http(rpc) })
    runtimes.set(net.id, { net, publicClient, walletClient })
  }
  if (runtimes.size === 0) {
    throw new Error('hood402-facilitator: no networks configured (set FACILITATOR_NETWORKS)')
  }

  return {
    port: Number(env['PORT'] ?? 4021),
    ledgerPath: env['LEDGER_PATH'] ?? './data/hood402-ledger.sqlite',
    signerAddress: account.address,
    runtimes,
  }
}

/** All networks the facilitator can settle on, for `/supported`. */
export function supportedNetworks(): readonly HoodNetwork[] {
  return NETWORKS
}
