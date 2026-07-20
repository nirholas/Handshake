import { createHmac, randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import type { AlertEvent } from '../engine/events.js'
import { cardToXDigestPost, cardToXPost, toCard } from '../format/cards.js'
import type { Transport } from './types.js'

/** Which mode a self-hosted instance picked for X posting. */
export type XMode = 'official' | 'xactions'

export interface XTransportConfig {
  mode: XMode
  // official mode: X API v2 OAuth1 user-context credentials.
  apiKey?: string
  apiSecret?: string
  accessToken?: string
  accessSecret?: string
  // xactions mode: a self-hosted https://github.com/nirholas/XActions instance.
  xactionsUrl?: string
  xactionsToken?: string
}

interface OAuth1Credentials {
  consumerKey: string
  consumerSecret: string
  token: string
  tokenSecret: string
}

/** RFC 3986 percent-encoding: stricter than encodeURIComponent (also escapes !*'()). */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Build an OAuth 1.0a `Authorization` header per RFC 5849 for one HTTP
 * request, HMAC-SHA1 signed with the user's access token secret. X's v2
 * tweet-creation endpoint requires this (user-context OAuth1); app-only
 * bearer tokens cannot post. No extra dependency: Node's `crypto` module is
 * enough for HMAC-SHA1 and base64.
 *
 * `timestamp`/`nonceValue` are injectable so tests can assert a deterministic
 * signature; real callers should omit them and get fresh values every
 * request (OAuth1 treats a reused nonce+timestamp pair as a replay).
 */
export function buildOAuth1Header(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  extraParams: Record<string, string> = {},
  timestamp: number = Math.floor(Date.now() / 1000),
  nonceValue: string = randomBytes(16).toString('hex'),
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonceValue,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: creds.token,
    oauth_version: '1.0',
  }

  const signingParams = { ...oauthParams, ...extraParams }
  const paramString = Object.keys(signingParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(signingParams[key] as string)}`)
    .join('&')
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64')

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature }
  return (
    'OAuth ' +
    Object.keys(headerParams)
      .sort()
      .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key] as string)}"`)
      .join(', ')
  )
}

/**
 * The X (Twitter) transport. Push-only: there is no inbound command bot (an
 * X broadcast account cannot DM back the way Telegram/Discord bots do), so
 * `start()`/`stop()` do no long-lived connection work, just credential
 * validation. Two modes, chosen once at startup by `cfg.mode`:
 *
 * - `official`: the real X API v2 (`POST /2/tweets`), OAuth1-signed with the
 *   user's own developer app credentials. ToS-compliant, costs money at X's
 *   paid API tiers.
 * - `xactions`: a self-hosted https://github.com/nirholas/XActions instance,
 *   posting via a browser-automation-driven X session instead of the
 *   official API. Free, but carries ToS risk, and posting is queued/async
 *   rather than confirmed synchronously.
 */
export class XTransport implements Transport {
  readonly platform = 'x' as const

  constructor(private readonly cfg: XTransportConfig) {}

  async start(): Promise<void> {
    if (this.cfg.mode === 'official') {
      const missing: string[] = []
      if (!this.cfg.apiKey) missing.push('HOOD_ALERTS_X_API_KEY')
      if (!this.cfg.apiSecret) missing.push('HOOD_ALERTS_X_API_SECRET')
      if (!this.cfg.accessToken) missing.push('HOOD_ALERTS_X_ACCESS_TOKEN')
      if (!this.cfg.accessSecret) missing.push('HOOD_ALERTS_X_ACCESS_SECRET')
      if (missing.length > 0) {
        throw new Error(`x transport (official mode) is missing required env var(s): ${missing.join(', ')}`)
      }
      logger.info('x transport active (official API v2, OAuth1 user context)')
      return
    }
    const missing: string[] = []
    if (!this.cfg.xactionsUrl) missing.push('HOOD_ALERTS_XACTIONS_URL')
    if (!this.cfg.xactionsToken) missing.push('HOOD_ALERTS_XACTIONS_TOKEN')
    if (missing.length > 0) {
      throw new Error(`x transport (xactions mode) is missing required env var(s): ${missing.join(', ')}`)
    }
    logger.info({ url: this.cfg.xactionsUrl }, 'x transport active (self-hosted xactions, ToS risk: not the official API)')
  }

  async stop(): Promise<void> {
    // stateless HTTP posting; nothing to close
  }

  async sendAlert(chatId: string, event: AlertEvent): Promise<void> {
    const text = cardToXPost(toCard(event))
    const result = await this.post(text)
    logger.info({ chatId, eventType: event.type, ...result }, 'x post sent')
  }

  async sendDigest(chatId: string, events: AlertEvent[]): Promise<void> {
    const text = cardToXDigestPost(events)
    const result = await this.post(text)
    logger.info(
      { chatId, count: events.length, summarized: events.map((e) => e.type), ...result },
      'x digest sent (posted the most significant event only; see "summarized" for the full batch)',
    )
  }

  private async post(text: string): Promise<{ id?: string; queued?: boolean }> {
    return this.cfg.mode === 'official' ? this.postOfficial(text) : this.postXactions(text)
  }

  private async postOfficial(text: string): Promise<{ id: string }> {
    const url = 'https://api.twitter.com/2/tweets'
    const creds: OAuth1Credentials = {
      consumerKey: this.cfg.apiKey as string,
      consumerSecret: this.cfg.apiSecret as string,
      token: this.cfg.accessToken as string,
      tokenSecret: this.cfg.accessSecret as string,
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: buildOAuth1Header('POST', url, creds),
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`X API POST /2/tweets failed: ${res.status} ${res.statusText} ${detail.slice(0, 300)}`)
    }
    const body = (await res.json()) as { data?: { id?: string } }
    const id = body.data?.id
    if (!id) throw new Error(`X API POST /2/tweets returned no tweet id: ${JSON.stringify(body).slice(0, 300)}`)
    return { id }
  }

  private async postXactions(text: string): Promise<{ queued: true }> {
    const url = `${this.cfg.xactionsUrl}/api/posting/tweet`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.xactionsToken}`,
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`xactions POST /api/posting/tweet failed: ${res.status} ${res.statusText} ${detail.slice(0, 300)}`)
    }
    // xactions queues the post through a browser-automation session; a 2xx
    // here means accepted, not delivered. It does not confirm the tweet
    // actually landed the way the official API's tweet id does.
    logger.info({ url }, 'x post queued via xactions: delivery is not confirmed synchronously')
    return { queued: true }
  }
}
