import type { Db } from './index.js'
import type { Platform } from './subscribers.js'

/** An active or expired premium entitlement. */
export interface Entitlement {
  platform: Platform
  chatId: string
  tier: 'premium'
  activatedAt: number
  expiresAt: number
  paymentTx: string | null
  payer: string | null
}

interface Row {
  platform: Platform
  chat_id: string
  tier: 'premium'
  activated_at: number
  expires_at: number
  payment_tx: string | null
  payer: string | null
}

function toEntitlement(r: Row): Entitlement {
  return {
    platform: r.platform,
    chatId: r.chat_id,
    tier: r.tier,
    activatedAt: r.activated_at,
    expiresAt: r.expires_at,
    paymentTx: r.payment_tx,
    payer: r.payer,
  }
}

/**
 * The premium entitlement state machine. States, per (platform, chat):
 *
 *   free ──activate(payment)──> active(expires_at)
 *   active ──activate(payment)──> active(expires_at + duration)   [extension]
 *   active ──clock passes expires_at──> expired (== free)
 *   any ──revoke──> free
 *
 * Expiry is evaluated lazily against the clock; there is no cron.
 */
export class EntitlementRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Activate or extend premium. Extensions stack on the remaining time. */
  activate(
    platform: Platform,
    chatId: string,
    durationS: number,
    payment?: { tx?: string; payer?: string },
  ): Entitlement {
    const now = this.now()
    const current = this.getRaw(platform, chatId)
    const base = current && current.expires_at > now ? current.expires_at : now
    const expiresAt = base + durationS
    this.db
      .prepare(
        'INSERT INTO entitlements (platform, chat_id, tier, activated_at, expires_at, payment_tx, payer) ' +
          "VALUES (?, ?, 'premium', ?, ?, ?, ?) " +
          'ON CONFLICT (platform, chat_id) DO UPDATE SET ' +
          'activated_at = excluded.activated_at, expires_at = excluded.expires_at, ' +
          'payment_tx = COALESCE(excluded.payment_tx, entitlements.payment_tx), ' +
          'payer = COALESCE(excluded.payer, entitlements.payer)',
      )
      .run(platform, chatId, now, expiresAt, payment?.tx ?? null, payment?.payer ?? null)
    return this.get(platform, chatId) as Entitlement
  }

  /** Drop back to free immediately. */
  revoke(platform: Platform, chatId: string): boolean {
    return this.db.prepare('DELETE FROM entitlements WHERE platform = ? AND chat_id = ?').run(platform, chatId).changes > 0
  }

  private getRaw(platform: Platform, chatId: string): Row | null {
    const row = this.db
      .prepare('SELECT * FROM entitlements WHERE platform = ? AND chat_id = ?')
      .get(platform, chatId) as Row | undefined
    return row ?? null
  }

  /** The stored entitlement, expired or not. Null when never purchased. */
  get(platform: Platform, chatId: string): Entitlement | null {
    const row = this.getRaw(platform, chatId)
    return row ? toEntitlement(row) : null
  }

  /** True while the entitlement clock has not run out. */
  isPremium(platform: Platform, chatId: string): boolean {
    const row = this.getRaw(platform, chatId)
    return row !== null && row.expires_at > this.now()
  }

  /** Seconds of premium remaining (0 when free/expired). */
  remainingS(platform: Platform, chatId: string): number {
    const row = this.getRaw(platform, chatId)
    if (!row) return 0
    return Math.max(0, row.expires_at - this.now())
  }
}
