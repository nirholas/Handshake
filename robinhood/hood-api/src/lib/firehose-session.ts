import { createHmac, randomBytes } from 'node:crypto'
import { env } from './env.js'

/**
 * Metered firehose session tokens.
 *
 * `GET /v1/firehose` is x402-gated (one metered charge) and mints a
 * short-lived, signed session token. The client then opens `wss:///v1/ws`
 * with that token in a query param; the WS upgrade handler verifies the HMAC
 * and expiry before subscribing the socket to the sequencer feed. This keeps
 * the paywall on the cheap HTTP call while the expensive long-lived
 * connection needs no per-message billing.
 */

const SESSION_TTL_SECONDS = 10 * 60 // 10 minutes of streaming per paid token

function secret(): string {
  if (env.firehoseSessionSecret) return env.firehoseSessionSecret
  // Stable for the life of this process; regenerating on every mint would
  // invalidate outstanding tokens, so this is computed once and memoized.
  return processSecret
}
const processSecret = randomBytes(32).toString('hex')

export interface FirehoseSession {
  token: string
  expiresAt: string
}

export function mintSession(): FirehoseSession {
  const id = randomBytes(16).toString('hex')
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  const payload = `${id}.${exp}`
  const sig = createHmac('sha256', secret()).update(payload).digest('hex')
  return { token: `${payload}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() }
}

export function verifySession(token: string | undefined | null): { ok: true } | { ok: false; reason: string } {
  if (!token) return { ok: false, reason: 'missing session token' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed session token' }
  const [id, expRaw, sig] = parts
  const payload = `${id}.${expRaw}`
  const expected = createHmac('sha256', secret()).update(payload).digest('hex')
  if (sig !== expected) return { ok: false, reason: 'invalid session signature' }
  const exp = Number(expRaw)
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'session token expired — request a new one from GET /v1/firehose' }
  }
  return { ok: true }
}
