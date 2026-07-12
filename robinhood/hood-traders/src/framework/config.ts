import type { HoodNetwork } from 'hoodchain'
import type { Mode, RiskLimits } from './types.js'

/** Fleet-wide configuration resolved from the environment. */
export interface FleetConfig {
  network: HoodNetwork
  rpcUrl: string | undefined
  mode: Mode
  /** Set true only when HOOD_TRADERS_LIVE=1 AND a key is present. */
  hasWallet: boolean
  privateKey: `0x${string}` | undefined
  stockTokenEligible: boolean
  fleetMaxDailySpendUsdg: number
  dashboardPort: number
  killFile: string
  /** Path to the SQLite journal. */
  dbPath: string
  defaultLimits: RiskLimits
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Env ${name}="${raw}" is not a non-negative number`)
  }
  return n
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'
}

/**
 * Resolve fleet configuration from the environment.
 *
 * Live mode is deliberately hard to enable by accident: it requires BOTH
 * `HOOD_TRADERS_LIVE=1` and a `ROBINHOOD_CHAIN_PRIVATE_KEY`. Missing either one
 * falls back to paper mode rather than erroring, so a mis-set flag can never
 * silently spend real funds.
 */
export function loadFleetConfig(env: NodeJS.ProcessEnv = process.env): FleetConfig {
  const network = (env.HOOD_NETWORK === 'testnet' ? 'testnet' : 'mainnet') as HoodNetwork
  const wantLive = bool('HOOD_TRADERS_LIVE', false)
  const privateKey = env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}` | undefined
  const hasKey = typeof privateKey === 'string' && /^0x[0-9a-fA-F]{64}$/.test(privateKey)
  const mode: Mode = wantLive && hasKey ? 'live' : 'paper'

  return {
    network,
    rpcUrl: env.HOOD_RPC_URL || undefined,
    mode,
    hasWallet: hasKey,
    privateKey: hasKey ? privateKey : undefined,
    stockTokenEligible: bool('HOOD_STOCK_TOKEN_ELIGIBLE', false),
    fleetMaxDailySpendUsdg: num('FLEET_MAX_DAILY_SPEND_USDG', 250),
    dashboardPort: num('DASHBOARD_PORT', 4670),
    killFile: env.KILL_FILE || './KILL',
    dbPath: env.HOOD_TRADERS_DB || './data/hood-traders.db',
    defaultLimits: {
      maxPositionUsdg: num('AGENT_MAX_POSITION_USDG', 50),
      maxDailySpendUsdg: num('AGENT_MAX_DAILY_SPEND_USDG', 100),
      maxSlippageBps: num('AGENT_MAX_SLIPPAGE_BPS', 100),
      cooldownSeconds: num('AGENT_COOLDOWN_SECONDS', 60),
    },
  }
}
