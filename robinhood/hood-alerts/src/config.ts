import type { Address } from 'viem'

/** Runtime configuration, resolved once from the environment at startup. */
export interface Config {
  /** Custom RPC URL, or undefined for viem's public default. */
  rpcUrl: string | undefined
  /** SQLite database file path. */
  dbPath: string
  /** HTTP port for /healthz + premium endpoints. */
  port: number
  /** Public base URL of this instance (payment challenges, bot replies). */
  publicUrl: string
  /** Telegram bot token, or null to disable the transport. */
  telegramToken: string | null
  /** Discord bot token + application id, or null to disable the transport. */
  discordToken: string | null
  discordAppId: string | null
  /**
   * X (Twitter) delivery mode, or undefined to disable the transport.
   * `official` posts through the real X API v2 (OAuth1, paid tier). `xactions`
   * posts through a self-hosted https://github.com/nirholas/XActions instance
   * (free, cookie-session automation, ToS risk). Set at most one.
   */
  xMode: 'official' | 'xactions' | undefined
  /** official mode: X API v2 OAuth1 user-context credentials (developer.x.com). */
  xApiKey: string | null
  xApiSecret: string | null
  xAccessToken: string | null
  xAccessSecret: string | null
  /** xactions mode: base URL and bearer token of a self-hosted xactions instance. */
  xactionsUrl: string | null
  xactionsToken: string | null
  /**
   * Topics the X broadcast auto-posts, resolved the same way a `watch`
   * command would parse them. X has no inbound bot, so this is fixed at
   * startup instead of user-driven.
   */
  xTopics: string[]
  /** Premium rail. Only `hood402` is implemented end-to-end. */
  premiumRail: 'hood402'
  /** Receiving address for premium payments (null = purchases disabled). */
  payTo: Address | null
  /** hood402 facilitator base URL (settlement mode A). */
  facilitatorUrl: string | null
  /** Gas key for self-settlement (settlement mode B). */
  settlerKey: `0x${string}` | null
  /** Premium price in USDG (human string) and entitlement duration in days. */
  premiumPriceUsdg: string
  premiumDays: number
  detectors: DetectorConfig
}

/** Tunable detector thresholds. */
export interface DetectorConfig {
  /** Engine-side floor for whale trade emission (USD). */
  whaleFloorUsd: number
  /** Default per-subscription whale threshold (USD). */
  whaleDefaultUsd: number
  /** Rolling window for price-move detection (seconds). */
  priceWindowS: number
  /** Default price-move threshold (percent). */
  priceDefaultPct: number
  /** Stock premium/discount poll interval (seconds). */
  premiumPollS: number
  /** Default premium/discount threshold (percent). */
  premiumDefaultPct: number
  /** Default liquidity-pull threshold (percent of quote reserves). */
  rugDefaultPct: number
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`)
  }
  return value
}

function str(name: string): string | null {
  const raw = process.env[name]
  return raw === undefined || raw.trim() === '' ? null : raw.trim()
}

/** Load and validate configuration from the environment. */
export function loadConfig(): Config {
  const rail = str('HOOD_ALERTS_PREMIUM_RAIL') ?? 'hood402'
  if (rail !== 'hood402') {
    throw new Error(
      `HOOD_ALERTS_PREMIUM_RAIL="${rail}" is not implemented. Only "hood402" (USDG on ` +
        'Robinhood Chain) settles end-to-end in this build; see README "Premium rails" ' +
        'for wiring an x402 USDC facilitator instead.',
    )
  }
  const payToRaw = str('HOOD402_PAY_TO')
  if (payToRaw && !/^0x[0-9a-fA-F]{40}$/.test(payToRaw)) {
    throw new Error(`HOOD402_PAY_TO must be a 0x address, got "${payToRaw}"`)
  }
  const settlerRaw = str('HOOD402_SETTLER_KEY')
  if (settlerRaw && !/^0x[0-9a-fA-F]{64}$/.test(settlerRaw)) {
    throw new Error('HOOD402_SETTLER_KEY must be a 0x-prefixed 32-byte hex private key')
  }
  const xModeRaw = str('HOOD_ALERTS_X_MODE')
  if (xModeRaw !== null && xModeRaw !== 'official' && xModeRaw !== 'xactions') {
    throw new Error(`HOOD_ALERTS_X_MODE must be "official" or "xactions", got "${xModeRaw}"`)
  }
  const port = Math.floor(num('PORT', 8080))
  return {
    rpcUrl: str('HOOD_ALERTS_RPC_URL') ?? undefined,
    dbPath: str('HOOD_ALERTS_DB') ?? './data/hood-alerts.db',
    port,
    publicUrl: str('HOOD_ALERTS_PUBLIC_URL') ?? `http://localhost:${port}`,
    telegramToken: str('HOOD_ALERTS_TELEGRAM_TOKEN'),
    discordToken: str('HOOD_ALERTS_DISCORD_TOKEN'),
    discordAppId: str('HOOD_ALERTS_DISCORD_APP_ID'),
    xMode: xModeRaw ?? undefined,
    xApiKey: str('HOOD_ALERTS_X_API_KEY'),
    xApiSecret: str('HOOD_ALERTS_X_API_SECRET'),
    xAccessToken: str('HOOD_ALERTS_X_ACCESS_TOKEN'),
    xAccessSecret: str('HOOD_ALERTS_X_ACCESS_SECRET'),
    xactionsUrl: str('HOOD_ALERTS_XACTIONS_URL'),
    xactionsToken: str('HOOD_ALERTS_XACTIONS_TOKEN'),
    xTopics: (str('HOOD_ALERTS_X_TOPICS') ?? 'launches,graduations,whales')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    premiumRail: 'hood402',
    payTo: (payToRaw as Address | null) ?? null,
    facilitatorUrl: str('HOOD402_FACILITATOR_URL'),
    settlerKey: (settlerRaw as `0x${string}` | null) ?? null,
    premiumPriceUsdg: String(num('HOOD_ALERTS_PREMIUM_PRICE_USDG', 5)),
    premiumDays: num('HOOD_ALERTS_PREMIUM_DAYS', 30),
    detectors: {
      whaleFloorUsd: num('HOOD_ALERTS_WHALE_FLOOR_USD', 1000),
      whaleDefaultUsd: num('HOOD_ALERTS_WHALE_DEFAULT_USD', 5000),
      priceWindowS: num('HOOD_ALERTS_PRICE_WINDOW_S', 900),
      priceDefaultPct: num('HOOD_ALERTS_PRICE_DEFAULT_PCT', 2),
      premiumPollS: num('HOOD_ALERTS_PREMIUM_POLL_S', 60),
      premiumDefaultPct: num('HOOD_ALERTS_PREMIUM_DEFAULT_PCT', 2),
      rugDefaultPct: num('HOOD_ALERTS_RUG_DEFAULT_PCT', 30),
    },
  }
}
