import { logger } from '../logger.js'
import type { AlertEvent } from '../engine/events.js'
import { cardToText, digestCards, toCard } from '../format/cards.js'
import type { Transport } from './types.js'

/**
 * The console transport: alerts print as structured log lines. This is the
 * zero-config self-host smoke mode and what `npm run probe` uses to prove
 * live detection without any bot token.
 */
export class ConsoleTransport implements Transport {
  readonly platform = 'console' as const

  async sendAlert(chatId: string, event: AlertEvent): Promise<void> {
    logger.info({ chatId, alert: cardToText(toCard(event)), eventType: event.type }, 'alert')
  }

  async sendDigest(chatId: string, events: AlertEvent[]): Promise<void> {
    const digest = digestCards(events)
    logger.info(
      { chatId, title: digest.title, alerts: digest.cards.map(cardToText), omitted: digest.omitted },
      'digest',
    )
  }

  async start(): Promise<void> {
    logger.info('console transport active (no bot tokens configured)')
  }

  async stop(): Promise<void> {
    // nothing to close
  }
}
