#!/usr/bin/env tsx
/**
 * Live detector probe: runs the full detector set against Robinhood Chain
 * mainnet (4663) and prints every alert it would fire to the console, with no
 * bot tokens and no database. This is the zero-config proof that live detection
 * works. Read-only; never signs or sends a transaction.
 *
 *   npm run probe                 # default 90s, chain-wide detectors
 *   npm run probe -- --seconds 300
 *   npm run probe -- --token 0xTOKEN   # also stream that token's swaps/holders
 *
 * Ctrl-C stops it cleanly.
 */
import { createHoodClient } from 'hoodchain'
import type { Address } from 'viem'
import { loadConfig } from '../src/config.js'
import { LiveDetectors } from '../src/engine/detectors/live.js'
import { toCard, cardToText } from '../src/format/cards.js'
import { logger } from '../src/logger.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const seconds = Number(arg('seconds') ?? 90)
  const token = arg('token') as Address | undefined
  const config = loadConfig()
  const client = createHoodClient(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {})

  let count = 0
  const detectors = new LiveDetectors(client, config.detectors, (event) => {
    count += 1
    const card = toCard(event)
    // eslint-disable-next-line no-console
    console.log(`\n[${new Date().toISOString()}] ${event.type}\n${cardToText(card)}`)
  })

  logger.info({ seconds, token: token ?? 'chain-wide only' }, 'live probe starting (read-only)')
  await detectors.start()
  if (token) await detectors.syncWatchedTokens([token])

  const stop = (): void => {
    detectors.stop()
    logger.info({ alerts: count, eventCounts: detectors.eventCounts }, 'probe finished')
    process.exit(0)
  }
  process.on('SIGINT', stop)
  setTimeout(stop, seconds * 1000)
}

main().catch((error) => {
  logger.fatal({ err: String(error?.stack ?? error) }, 'probe failed')
  process.exit(1)
})
