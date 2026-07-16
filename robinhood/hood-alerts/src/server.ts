import { Hono } from 'hono'
import { PAYMENT_HEADER } from 'hood402'
import type { Config } from './config.js'
import type { AlertEngine } from './engine/engine.js'
import type { LiveDetectors } from './engine/detectors/live.js'
import type { PremiumPaywall } from './premium/paywall.js'
import type { Platform } from './db/subscribers.js'

export interface ServerDeps {
  config: Config
  engine: AlertEngine
  detectors: LiveDetectors
  paywall: PremiumPaywall
  startedAt: number
}

/** Build the HTTP app: health, premium status, and the x402 activation endpoint. */
export function buildApp(deps: ServerDeps): Hono {
  const app = new Hono()

  app.get('/', (c) =>
    c.json({
      service: 'hood-alerts',
      chain: 4663,
      docs: 'https://nirholas.github.io/hood-alerts/',
      endpoints: ['/healthz', '/premium/status', '/premium/activate'],
    }),
  )

  app.get('/healthz', (c) => {
    const lastEventAt = deps.detectors.lastEventAt
    return c.json({
      ok: true,
      uptimeS: Math.floor(Date.now() / 1000) - deps.startedAt,
      lastEventAt: lastEventAt ? new Date(lastEventAt * 1000).toISOString() : null,
      eventCounts: deps.detectors.eventCounts,
      premiumPurchases: deps.paywall.enabled,
    })
  })

  const validTarget = (c: { req: { query(k: string): string | undefined } }): { platform: Platform; chat: string } | null => {
    const platform = c.req.query('platform')
    const chat = c.req.query('chat')
    if ((platform !== 'telegram' && platform !== 'discord' && platform !== 'console') || !chat || chat.length > 64) return null
    return { platform, chat }
  }

  app.get('/premium/status', (c) => {
    const target = validTarget(c)
    if (!target) return c.json({ error: 'pass ?platform=telegram|discord&chat=<chat id>' }, 400)
    const entitlement = deps.engine.entitlements.get(target.platform, target.chat)
    const remaining = deps.engine.entitlements.remainingS(target.platform, target.chat)
    return c.json({
      platform: target.platform,
      chat: target.chat,
      tier: remaining > 0 ? 'premium' : 'free',
      expiresAt: entitlement && remaining > 0 ? new Date(entitlement.expiresAt * 1000).toISOString() : null,
    })
  })

  app.post('/premium/activate', async (c) => {
    const target = validTarget(c)
    if (!target) return c.json({ error: 'pass ?platform=telegram|discord&chat=<chat id>' }, 400)
    const result = await deps.paywall.activate(target.platform, target.chat, c.req.header(PAYMENT_HEADER), c.req.url)
    if (result.status === 200) {
      c.header('X-PAYMENT-RESPONSE', result.settlementHeader)
      return c.json(result.body as Record<string, unknown>, 200)
    }
    return c.json(result.body as Record<string, unknown>, result.status)
  })

  return app
}
