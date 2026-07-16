import type { Address } from 'viem'
import { logger } from '../logger.js'
import type { DetectorConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { DeliveryRepo } from '../db/deliveries.js'
import { EntitlementRepo } from '../db/entitlements.js'
import { SubscriberRepo, type Subscriber } from '../db/subscribers.js'
import type { Transport } from '../transports/types.js'
import { dedupTtlSeconds, fingerprint, type AlertEvent } from './events.js'
import { DigestBuffer, type BufferedAlert } from './digest.js'
import { FREE_MIN_INTERVAL_S, gate } from './gate.js'
import { matches, parseTopic } from './topics.js'

const nowS = (): number => Math.floor(Date.now() / 1000)

/**
 * The alert engine: one event stream in, per-subscriber deliveries out.
 * Detector events pass dedup, subscription routing, tier/quiet/digest gating,
 * and rate limiting before reaching a transport. Every delivery is logged.
 */
export class AlertEngine {
  readonly subscribers: SubscriberRepo
  readonly entitlements: EntitlementRepo
  readonly deliveries: DeliveryRepo
  private readonly digestBuffer = new DigestBuffer()
  private readonly transports = new Map<string, Transport>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private onWatchedTokensChanged: ((tokens: Address[]) => void) | null = null
  /** Ring of recent events for /healthz and diagnostics. */
  readonly recent: AlertEvent[] = []

  constructor(
    db: Db,
    private readonly cfg: DetectorConfig,
  ) {
    this.subscribers = new SubscriberRepo(db)
    this.entitlements = new EntitlementRepo(db)
    this.deliveries = new DeliveryRepo(db)
  }

  registerTransport(transport: Transport): void {
    this.transports.set(transport.platform, transport)
  }

  /** Called whenever the set of `token:0x…` watches changes. */
  onTokenWatches(cb: (tokens: Address[]) => void): void {
    this.onWatchedTokensChanged = cb
    cb(this.watchedTokens())
  }

  /** Tokens with at least one `token:` subscription. */
  watchedTokens(): Address[] {
    const tokens = new Set<string>()
    for (const topic of this.subscribers.activeTopics()) {
      const parsed = parseTopic(topic)
      if (parsed?.kind === 'token') tokens.add(parsed.address)
    }
    return [...tokens] as Address[]
  }

  /** Notify detectors after a watch/unwatch that touches token topics. */
  notifyWatchChange(): void {
    this.onWatchedTokensChanged?.(this.watchedTokens())
  }

  start(): void {
    this.flushTimer = setInterval(() => {
      this.flushDigests().catch((error) => logger.error({ err: String(error) }, 'digest flush failed'))
    }, 15_000)
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
    // Final flush so buffered alerts are not silently lost on shutdown.
    const all = this.digestBuffer.drainAll()
    for (const bucket of all) await this.deliverDigest(bucket.subscriberId, bucket.alerts)
  }

  /** Ingest one detector event. Synchronous decisions, async deliveries. */
  ingest(event: AlertEvent): void {
    const fp = fingerprint(event)
    if (!this.deliveries.claimFingerprint(fp, dedupTtlSeconds(event))) return

    this.recent.push(event)
    if (this.recent.length > 100) this.recent.shift()

    const now = nowS()
    for (const { subscription, subscriber } of this.subscribers.allWithSubscribers()) {
      const parsed = parseTopic(subscription.topic)
      if (!parsed) continue
      const premium = this.entitlements.isPremium(subscriber.platform, subscriber.chatId)
      // Premium-only topics stop matching when the entitlement lapses.
      if ((parsed.kind === 'premiums' || parsed.kind === 'rugs') && !premium) continue
      if (!matches(parsed, subscription.threshold, event)) continue

      const decision = gate(
        {
          premium,
          digest: subscriber.digest,
          quietStart: subscriber.quietStart,
          quietEnd: subscriber.quietEnd,
          lastDeliveredAt: this.deliveries.lastDeliveredAt(subscriber.id),
          deliveredLastMinute: this.deliveries.recentCount(subscriber.id, 60),
        },
        now,
      )
      const buffered: BufferedAlert = { event, fingerprint: fp, bufferedAt: now }
      if (decision.action === 'deliver') {
        void this.deliver(subscriber, event, fp)
      } else if (decision.action === 'digest') {
        const delayS =
          decision.reason === 'digest-mode'
            ? subscriber.digestIntervalS
            : decision.reason === 'quiet-hours'
              ? 900 // re-check quiet window every 15 min; gate re-applies on flush
              : FREE_MIN_INTERVAL_S
        this.digestBuffer.add(subscriber.id, buffered, delayS, now)
        this.deliveries.logDelivery(subscriber.id, fp, 'digested', decision.reason)
      } else {
        logger.warn({ subscriber: subscriber.id, fp }, 'alert dropped: rate limited')
      }
    }
  }

  private async deliver(subscriber: Subscriber, event: AlertEvent, fp: string): Promise<void> {
    const transport = this.transports.get(subscriber.platform)
    if (!transport) {
      this.deliveries.logDelivery(subscriber.id, fp, 'failed', `no transport for ${subscriber.platform}`)
      return
    }
    try {
      await transport.sendAlert(subscriber.chatId, event)
      this.deliveries.logDelivery(subscriber.id, fp, 'sent')
    } catch (error) {
      this.deliveries.logDelivery(subscriber.id, fp, 'failed', String(error))
      logger.error({ err: String(error), subscriber: subscriber.id }, 'alert delivery failed')
    }
  }

  private async flushDigests(): Promise<void> {
    const now = nowS()
    for (const bucket of this.digestBuffer.drain(now)) {
      const subscriber = this.subscribers.byId(bucket.subscriberId)
      if (!subscriber) continue
      // Still inside quiet hours? Re-buffer for another 15 minutes.
      const decision = gate(
        {
          premium: this.entitlements.isPremium(subscriber.platform, subscriber.chatId),
          digest: false,
          quietStart: subscriber.quietStart,
          quietEnd: subscriber.quietEnd,
          lastDeliveredAt: null,
          deliveredLastMinute: this.deliveries.recentCount(subscriber.id, 60),
        },
        now,
      )
      if (decision.action === 'digest') {
        for (const alert of bucket.alerts) this.digestBuffer.add(subscriber.id, alert, 900, now)
        continue
      }
      await this.deliverDigest(bucket.subscriberId, bucket.alerts)
    }
  }

  private async deliverDigest(subscriberId: number, alerts: BufferedAlert[]): Promise<void> {
    const subscriber = this.subscribers.byId(subscriberId)
    if (!subscriber || alerts.length === 0) return
    const transport = this.transports.get(subscriber.platform)
    if (!transport) return
    try {
      if (alerts.length === 1 && alerts[0]) {
        await transport.sendAlert(subscriber.chatId, alerts[0].event)
      } else {
        await transport.sendDigest(
          subscriber.chatId,
          alerts.map((a) => a.event),
        )
      }
      for (const a of alerts) this.deliveries.logDelivery(subscriberId, a.fingerprint, 'sent', 'digest')
    } catch (error) {
      for (const a of alerts) this.deliveries.logDelivery(subscriberId, a.fingerprint, 'failed', String(error))
      logger.error({ err: String(error), subscriber: subscriberId }, 'digest delivery failed')
    }
  }
}
