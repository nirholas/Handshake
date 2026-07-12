/** Process configuration, parsed once. All fields have defaults; the free tier needs none. */

function str(name: string, fallback = ''): string {
  const v = process.env[name]
  return v && v.trim().length > 0 ? v.trim() : fallback
}

function int(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

const network = str('X402_NETWORK', 'base-sepolia')
if (network !== 'base' && network !== 'base-sepolia') {
  throw new Error(`X402_NETWORK must be "base" or "base-sepolia", got "${network}"`)
}

export const env = {
  port: int('PORT', 8787),
  publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${int('PORT', 8787)}`).replace(/\/$/, ''),

  // Upstreams
  alchemyKey: str('ALCHEMY_KEY'),
  rpcUrl: str('HOOD_RPC_URL'),
  coingeckoApiKey: str('COINGECKO_API_KEY'),

  // x402
  x402PayTo: str('X402_PAY_TO'),
  x402Network: network as 'base' | 'base-sepolia',
  x402FacilitatorUrl: str('X402_FACILITATOR_URL', 'https://x402.org/facilitator'),
  cdpApiKeyId: str('CDP_API_KEY_ID'),
  cdpApiKeySecret: str('CDP_API_KEY_SECRET'),
  firehoseSessionSecret: str('FIREHOSE_SESSION_SECRET'),
} as const

/** Resolved mainnet RPC URL: explicit override > Alchemy (if keyed) > public RPC (SDK default). */
export function resolvedMainnetRpcUrl(): string | undefined {
  if (env.rpcUrl) return env.rpcUrl
  if (env.alchemyKey) return `https://robinhood-mainnet.g.alchemy.com/v2/${env.alchemyKey}`
  return undefined // undefined => hoodchain uses viem's public RPC
}

/** Whether x402 paid endpoints are enabled (a payout address is configured). */
export function paymentsEnabled(): boolean {
  return env.x402PayTo.length > 0
}
