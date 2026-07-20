#!/usr/bin/env tsx
/**
 * Operator tool: grant, extend, revoke, or inspect a premium entitlement
 * directly in the database. Use it to comp a chat, to run the premium delivery
 * flow before wiring a payment rail, or to fix a settlement that half-applied.
 * It does NOT move funds; it only writes the entitlement row.
 *
 *   npm run grant-premium -- grant telegram 123456789 --days 30
 *   npm run grant-premium -- status discord 987654321
 *   npm run grant-premium -- revoke telegram 123456789
 *   npm run grant-premium -- grant x public --days 30   # the X broadcast subscriber
 *
 * The database path follows HOOD_ALERTS_DB (default ./data/hood-alerts.db).
 */
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db/index.js'
import { EntitlementRepo } from '../src/db/entitlements.js'
import type { Platform } from '../src/db/subscribers.js'

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(message)
  process.exit(1)
}

const PLATFORMS: Platform[] = ['telegram', 'discord', 'console', 'x']

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function main(): void {
  const [action, platform, chat] = process.argv.slice(2)
  if (!action || !['grant', 'revoke', 'status'].includes(action)) {
    fail('Usage: grant-premium <grant|revoke|status> <telegram|discord|console|x> <chatId> [--days 30]')
  }
  if (!platform || !PLATFORMS.includes(platform as Platform)) fail(`platform must be one of ${PLATFORMS.join(', ')}`)
  if (!chat) fail('chatId is required')

  const config = loadConfig()
  const db = openDb(config.dbPath)
  const repo = new EntitlementRepo(db)
  const p = platform as Platform

  if (action === 'status') {
    const remaining = repo.remainingS(p, chat)
    const entitlement = repo.get(p, chat)
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          platform: p,
          chat,
          tier: remaining > 0 ? 'premium' : 'free',
          remainingDays: Math.round((remaining / 86_400) * 100) / 100,
          expiresAt: entitlement ? new Date(entitlement.expiresAt * 1000).toISOString() : null,
          paymentTx: entitlement?.paymentTx ?? null,
        },
        null,
        2,
      ),
    )
  } else if (action === 'grant') {
    const days = Number(flag('days') ?? config.premiumDays)
    if (!Number.isFinite(days) || days <= 0) fail('--days must be a positive number')
    const entitlement = repo.activate(p, chat, days * 86_400, { payer: 'operator-grant' })
    // eslint-disable-next-line no-console
    console.log(`Premium granted to ${p}:${chat} until ${new Date(entitlement.expiresAt * 1000).toISOString()} (+${days}d).`)
  } else {
    const removed = repo.revoke(p, chat)
    // eslint-disable-next-line no-console
    console.log(removed ? `Premium revoked for ${p}:${chat}.` : `No entitlement found for ${p}:${chat}.`)
  }
  db.close()
}

main()
