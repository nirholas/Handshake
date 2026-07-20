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
import { XTransport, type XTransportConfig } from './transports/x.js'
import type { Transport } from './transports/types.js'
import { PremiumPaywall } from './premium/paywall.js'
import { defaultThreshold, parseTopic, PREMIUM_TOPICS, resolveWatchTarget } from './engine/topics.js'
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

  // X (Twitter) is wired separately: it has no inbound bot (no watch/unwatch
  // DMs), so topics are config-driven instead of command-driven, and a
  // failed start() here only disables this one optional transport (never
  // crashes the process; Telegram/Discord/console keep running).
  if (config.xMode === 'official' || config.xMode === 'xactions') {
    const xConfig: XTransportConfig | null =
      config.xMode === 'official'
        ? config.xApiKey && config.xApiSecret && config.xAccessToken && config.xAccessSecret
          ? { mode: 'official', apiKey: config.xApiKey, apiSecret: config.xApiSecret, accessToken: config.xAccessToken, accessSecret: config.xAccessSecret }
          : null
        : config.xactionsUrl && config.xactionsToken
          ? { mode: 'xactions', xactionsUrl: config.xactionsUrl, xactionsToken: config.xactionsToken }
          : null
    if (!xConfig) {
      logger.warn(
        config.xMode === 'official'
          ? 'HOOD_ALERTS_X_MODE=official but HOOD_ALERTS_X_API_KEY/_API_SECRET/_ACCESS_TOKEN/_ACCESS_SECRET are not all set: x transport disabled'
          : 'HOOD_ALERTS_X_MODE=xactions but HOOD_ALERTS_XACTIONS_URL/_XACTIONS_TOKEN are not both set: x transport disabled',
      )
    } else {
      const x = new XTransport(xConfig)
      try {
        await x.start()
        engine.registerTransport(x)
        transports.push(x)

        // No inbound bot to run `watch` commands, so pre-register the
        // broadcast subscriber and subscribe it to HOOD_ALERTS_X_TOPICS the
        // same way Commands.watch() would: resolve each entry through the
        // real topic parser/threshold defaults, and reuse SubscriberRepo
        // directly rather than inventing a parallel subscription path.
        const xSubscriber = engine.subscribers.ensure('x', 'public', 'X broadcast')
        const xPremium = engine.entitlements.isPremium('x', 'public')
        for (const raw of config.xTopics) {
          const resolved = resolveWatchTarget(raw)
          if (!resolved.ok) {
            logger.warn({ topic: raw, error: resolved.error }, 'HOOD_ALERTS_X_TOPICS: skipping unrecognized topic')
            continue
          }
          if (PREMIUM_TOPICS.has(resolved.topic) && !xPremium) {
            logger.warn({ topic: raw }, 'HOOD_ALERTS_X_TOPICS: skipping premium-tier topic (x/public is not premium)')
            continue
          }
          const parsed = parseTopic(resolved.topic)
          const threshold = parsed
            ? defaultThreshold(parsed, {
                whaleUsd: config.detectors.whaleDefaultUsd,
                premiumPct: config.detectors.premiumDefaultPct,
                rugPct: config.detectors.rugDefaultPct,
                pricePct: config.detectors.priceDefaultPct,
              })
            : null
          engine.subscribers.subscribe(xSubscriber.id, resolved.topic, threshold)
          if (parsed?.kind === 'token') engine.notifyWatchChange()
        }
        logger.info({ mode: config.xMode, topics: config.xTopics }, 'x transport online')
      } catch (error) {
        logger.warn({ err: String(error) }, 'x transport failed to start: x transport disabled')
      }
    }
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
