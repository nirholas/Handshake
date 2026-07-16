#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { createHoodClient } from 'hoodchain'
import { loadConfig } from './config.js'
import { logger } from './logger.js'
import { openDb } from './db/index.js'
import { AlertEngine } from './engine/engine.js'
import { LiveDetectors } from './engine/detectors/live.js'
import { Commands } from './commands/commands.js'
import { ConsoleTransport } from './transports/console.js'
import { TelegramTransport } from './transports/telegram.js'
import { DiscordTransport } from './transports/discord.js'
import type { Transport } from './transports/types.js'
import { PremiumPaywall } from './premium/paywall.js'
import { buildApp } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const db = openDb(config.dbPath)
  const client = createHoodClient(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {})

  const engine = new AlertEngine(db, config.detectors)
  const detectors = new LiveDetectors(client, config.detectors, (event) => engine.ingest(event))
  engine.onTokenWatches((tokens) => {
    void detectors.syncWatchedTokens(tokens).catch((error) => logger.error({ err: String(error) }, 'token watch sync failed'))
  })

  const commands = new Commands({
    subscribers: engine.subscribers,
    entitlements: engine.entitlements,
    config,
    notifyWatchChange: () => engine.notifyWatchChange(),
  })

  const transports: Transport[] = [new ConsoleTransport()]
  if (config.telegramToken) transports.push(new TelegramTransport(config.telegramToken, commands))
  else logger.warn('HOOD_ALERTS_TELEGRAM_TOKEN not set: telegram transport disabled')
  if (config.discordToken && config.discordAppId) transports.push(new DiscordTransport(config.discordToken, config.discordAppId, commands))
  else logger.warn('HOOD_ALERTS_DISCORD_TOKEN/APP_ID not set: discord transport disabled')

  for (const t of transports) {
    engine.registerTransport(t)
    await t.start()
  }

  const paywall = new PremiumPaywall(config, engine.entitlements)
  if (!paywall.enabled) logger.warn('premium purchases disabled (set HOOD402_PAY_TO + facilitator or settler key)')

  engine.start()
  await detectors.start()

  const app = buildApp({ config, engine, detectors, paywall, startedAt: Math.floor(Date.now() / 1000) })
  const server = serve({ fetch: app.fetch, port: config.port }, (info) =>
    logger.info({ port: info.port }, 'http server listening'),
  )

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down')
    server.close()
    detectors.stop()
    await engine.stop() // flushes pending digests
    for (const t of transports) await t.stop().catch(() => undefined)
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  logger.fatal({ err: String(error?.stack ?? error) }, 'fatal startup error')
  process.exit(1)
})
