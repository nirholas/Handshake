import { z } from 'zod'
import { createHoodClient, type HoodClient, type HoodNetwork } from 'hoodchain'
import { privateKeyToAccount } from 'viem/accounts'

const hexPrivateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex private key')

/** Zod schema for a fully-specified launch config (the CLI/API's `coin.json` shape). */
export const launchConfigSchema = z.object({
  name: z.string().min(1).max(64),
  symbol: z
    .string()
    .min(1)
    .max(12)
    .transform((s) => s.replace(/^\$/, '').toUpperCase()),
  description: z.string().max(2000).default(''),
  logoUri: z.string().min(1).optional(),
  socials: z
    .object({
      telegram: z.string().optional(),
      twitter: z.string().optional(),
      discord: z.string().optional(),
      website: z.string().optional(),
      farcaster: z.string().optional(),
    })
    .default({}),
  initialBuyEth: z.coerce.number().min(0).default(0),
  rail: z.enum(['noxa', 'odyssey', 'direct']),
  odysseyVariant: z.enum(['instant', 'bonding']).default('instant'),
  direct: z
    .object({
      totalSupply: z.coerce.bigint().default(1_000_000_000n),
      feeTier: z.coerce.number().default(10_000),
      seedEth: z.coerce.number().min(0),
      lpSupplyBps: z.coerce.number().min(1).max(10_000).default(10_000),
      lpDisposition: z.enum(['burn', 'lock', 'keep']).default('burn'),
    })
    .optional(),
})

export type LaunchConfigInput = z.input<typeof launchConfigSchema>
export type LaunchConfig = z.output<typeof launchConfigSchema>

/** Environment-driven operator config shared by the CLI, API, and autonomous mode. */
export interface OperatorConfig {
  network: HoodNetwork
  live: boolean
  privateKey?: `0x${string}` | undefined
  maxLaunchesPerDay: number
  maxSeedUsdgEquivalent: number
  acknowledgeLaunchResponsibility: boolean
}

export function loadOperatorConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig {
  const network: HoodNetwork = env.ROBINHOOD_CHAIN_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  const live = env.LIVE === '1'
  let privateKey: `0x${string}` | undefined
  if (env.ROBINHOOD_CHAIN_PRIVATE_KEY) {
    privateKey = hexPrivateKey.parse(env.ROBINHOOD_CHAIN_PRIVATE_KEY) as `0x${string}`
  }
  return {
    network,
    live,
    privateKey,
    maxLaunchesPerDay: Number(env.MAX_LAUNCHES_PER_DAY ?? 3),
    maxSeedUsdgEquivalent: Number(env.MAX_SEED_USDG ?? 50),
    acknowledgeLaunchResponsibility:
      env.ACKNOWLEDGE_LAUNCH_RESPONSIBILITY === '1' || env.ACKNOWLEDGE_LAUNCH_RESPONSIBILITY === 'true',
  }
}

/** Build a connected `HoodClient` from operator config. Read-only when `live` is false or no key is set. */
export function clientFromOperatorConfig(config: OperatorConfig): HoodClient {
  const account = config.live && config.privateKey ? privateKeyToAccount(config.privateKey) : undefined
  return createHoodClient({
    chain: config.network,
    ...(account ? { account } : {}),
    // Stock Tokens are out of scope for hood-launcher (it launches new
    // memecoins, never acquires existing Stock Tokens), so this flag never
    // gates anything the launcher does — kept false intentionally.
    acknowledgeStockTokenEligibility: false,
  })
}
