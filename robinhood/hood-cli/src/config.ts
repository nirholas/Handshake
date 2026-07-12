/**
 * Persistent CLI config. Stored as JSON at `$HOOD_CONFIG_DIR` or
 * `~/.config/hood/config.json`. NEVER holds a private key — the wallet lives in
 * a separate password-encrypted keystore (see `keystore.ts`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { usageError } from './errors.js'

export interface HoodConfig {
  /** Default network for every command. @defaultValue 'mainnet' */
  network?: 'mainnet' | 'testnet'
  /** Custom mainnet RPC URL. */
  rpc?: string
  /** Custom testnet RPC URL. */
  testnetRpc?: string
  /** Alchemy API key — builds `https://robinhood-mainnet.g.alchemy.com/v2/{key}`. */
  alchemyKey?: string
  /** Path to the encrypted wallet keystore. */
  walletKeystore?: string
  /** Cached wallet address for display (never the key). */
  walletAddress?: string
  /** Hard USD spend cap for a single swap/transfer (guard rail). */
  maxSpendUsd?: number
}

/** The set of keys a user may `hood config set`. `wallet` is handled specially. */
export const CONFIG_KEYS = ['network', 'rpc', 'testnetRpc', 'alchemyKey', 'maxSpendUsd'] as const

export function configDir(): string {
  return process.env.HOOD_CONFIG_DIR ?? join(homedir(), '.config', 'hood')
}

export function configPath(): string {
  return join(configDir(), 'config.json')
}

export function defaultKeystorePath(): string {
  return join(configDir(), 'keystore.json')
}

/** Read the config, returning `{}` when none exists. */
export function loadConfig(): HoodConfig {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HoodConfig
  } catch (err) {
    throw usageError(`Config at ${path} is not valid JSON.`, 'Delete it or fix it by hand.')
  }
}

/** Persist the config, creating the directory (0700) on first write. */
export function saveConfig(config: HoodConfig): void {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

/** Validate + coerce a `config set <key> <value>` pair. */
export function setConfigValue(config: HoodConfig, key: string, value: string): HoodConfig {
  const next = { ...config }
  switch (key) {
    case 'network':
      if (value !== 'mainnet' && value !== 'testnet') throw usageError('network must be "mainnet" or "testnet".')
      next.network = value
      break
    case 'rpc':
      next.rpc = value
      break
    case 'testnetRpc':
      next.testnetRpc = value
      break
    case 'alchemyKey':
      next.alchemyKey = value
      break
    case 'maxSpendUsd': {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) throw usageError('maxSpendUsd must be a non-negative number.')
      next.maxSpendUsd = n
      break
    }
    default:
      throw usageError(`Unknown config key "${key}".`, `Valid keys: ${CONFIG_KEYS.join(', ')}, wallet.`)
  }
  return next
}

/** A redacted view of the config for `config list` (masks the alchemy key). */
export function redactedConfig(config: HoodConfig): Record<string, unknown> {
  return {
    network: config.network ?? 'mainnet',
    rpc: config.rpc ?? null,
    testnetRpc: config.testnetRpc ?? null,
    alchemyKey: config.alchemyKey ? maskKey(config.alchemyKey) : null,
    walletAddress: config.walletAddress ?? null,
    walletKeystore: config.walletKeystore ?? (config.walletAddress ? defaultKeystorePath() : null),
    maxSpendUsd: config.maxSpendUsd ?? null,
  }
}

function maskKey(key: string): string {
  if (key.length <= 6) return '••••'
  return `${key.slice(0, 3)}…${key.slice(-3)}`
}
