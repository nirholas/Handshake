import type { Platform } from '../db/subscribers.js'
import type { AlertEvent } from '../engine/events.js'

/** A delivery channel: Telegram, Discord, or the console (self-host smoke mode). */
export interface Transport {
  readonly platform: Platform
  /** Deliver one alert to a chat/channel. Throws on failure (engine logs it). */
  sendAlert(chatId: string, event: AlertEvent): Promise<void>
  /** Deliver a batched digest. */
  sendDigest(chatId: string, events: AlertEvent[]): Promise<void>
  /** Start receiving commands (long-poll/gateway). */
  start(): Promise<void>
  /** Graceful shutdown. */
  stop(): Promise<void>
}
