import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildOAuth1Header, XTransport, type XTransportConfig } from '../src/transports/x.js'
import { logger } from '../src/logger.js'
import type { AlertEvent } from '../src/engine/events.js'

const TOKEN = '0x1234567890123456789012345678901234567890' as `0x${string}`

const OFFICIAL_CFG: XTransportConfig = {
  mode: 'official',
  apiKey: 'consumer-key',
  apiSecret: 'consumer-secret',
  accessToken: 'access-token',
  accessSecret: 'access-secret',
}

const XACTIONS_CFG: XTransportConfig = {
  mode: 'xactions',
  xactionsUrl: 'https://xactions.example.com',
  xactionsToken: 'bearer-token',
}

function whaleEvent(): AlertEvent {
  return {
    type: 'whale',
    source: 'uniswap-v3',
    token: TOKEN,
    symbol: 'FOO',
    side: 'buy',
    usd: 12_000,
    trader: TOKEN,
    blockNumber: 1n,
    transactionHash: '0x1',
    at: 0,
  }
}

const originalFetch = global.fetch
let infoSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger)
  vi.spyOn(logger, 'warn').mockImplementation(() => logger)
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('buildOAuth1Header', () => {
  const creds = { consumerKey: 'ck', consumerSecret: 'cs', token: 'tk', tokenSecret: 'ts' }

  it('produces a well-formed Authorization header with every required OAuth1 field', () => {
    const header = buildOAuth1Header('POST', 'https://api.twitter.com/2/tweets', creds, {}, 1_700_000_000, 'fixed-nonce')
    expect(header.startsWith('OAuth ')).toBe(true)
    for (const key of ['oauth_consumer_key', 'oauth_nonce', 'oauth_signature_method', 'oauth_signature', 'oauth_timestamp', 'oauth_token', 'oauth_version']) {
      expect(header).toContain(`${key}="`)
    }
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"')
    expect(header).toContain('oauth_version="1.0"')
    expect(header).toContain('oauth_consumer_key="ck"')
    expect(header).toContain('oauth_token="tk"')
    expect(header).toContain('oauth_timestamp="1700000000"')
    expect(header).toContain('oauth_nonce="fixed-nonce"')
  })

  it('is deterministic for the same method/url/creds/timestamp/nonce', () => {
    const a = buildOAuth1Header('POST', 'https://api.twitter.com/2/tweets', creds, {}, 1_700_000_000, 'fixed-nonce')
    const b = buildOAuth1Header('POST', 'https://api.twitter.com/2/tweets', creds, {}, 1_700_000_000, 'fixed-nonce')
    expect(a).toBe(b)
  })

  it('changes the signature when the URL changes (proves the base string is bound to the request)', () => {
    const a = buildOAuth1Header('POST', 'https://api.twitter.com/2/tweets', creds, {}, 1_700_000_000, 'fixed-nonce')
    const b = buildOAuth1Header('POST', 'https://api.twitter.com/2/other', creds, {}, 1_700_000_000, 'fixed-nonce')
    expect(a).not.toBe(b)
  })

  it('percent-encodes reserved characters in credential values', () => {
    const weirdCreds = { consumerKey: 'ck !*()', consumerSecret: 'cs', token: 'tk', tokenSecret: 'ts' }
    const header = buildOAuth1Header('POST', 'https://api.twitter.com/2/tweets', weirdCreds, {}, 1_700_000_000, 'n')
    expect(header).not.toContain('oauth_consumer_key="ck !*()"')
    expect(header).toContain('oauth_consumer_key="ck%20%21%2A%28%29"')
  })
})

describe('XTransport.start', () => {
  it('has the x platform', () => {
    expect(new XTransport(OFFICIAL_CFG).platform).toBe('x')
  })

  it('resolves when official mode has all four credentials', async () => {
    await expect(new XTransport(OFFICIAL_CFG).start()).resolves.toBeUndefined()
  })

  it('throws naming every missing credential in official mode', async () => {
    const t = new XTransport({ mode: 'official' })
    await expect(t.start()).rejects.toThrow(
      /HOOD_ALERTS_X_API_KEY.*HOOD_ALERTS_X_API_SECRET.*HOOD_ALERTS_X_ACCESS_TOKEN.*HOOD_ALERTS_X_ACCESS_SECRET/s,
    )
  })

  it('throws naming only the one missing official credential', async () => {
    const t = new XTransport({ ...OFFICIAL_CFG, accessSecret: undefined })
    let message = ''
    try {
      await t.start()
    } catch (error) {
      message = String((error as Error).message)
    }
    expect(message).toContain('HOOD_ALERTS_X_ACCESS_SECRET')
    expect(message).not.toContain('HOOD_ALERTS_X_API_KEY')
  })

  it('resolves when xactions mode has both url and token', async () => {
    await expect(new XTransport(XACTIONS_CFG).start()).resolves.toBeUndefined()
  })

  it('throws naming every missing credential in xactions mode', async () => {
    const t = new XTransport({ mode: 'xactions' })
    await expect(t.start()).rejects.toThrow(/HOOD_ALERTS_XACTIONS_URL.*HOOD_ALERTS_XACTIONS_TOKEN/s)
  })
})

describe('XTransport.sendAlert (official mode)', () => {
  it('POSTs to /2/tweets with an OAuth1 Authorization header and a compact body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'tweet-1' } }) })
    global.fetch = fetchSpy as unknown as typeof fetch
    const t = new XTransport(OFFICIAL_CFG)
    await t.sendAlert('public', whaleEvent())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.twitter.com/2/tweets')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization.startsWith('OAuth ')).toBe(true)
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(init.body as string) as { text: string }
    expect(body.text).toContain('Whale buy')
    expect(body.text.length).toBeLessThanOrEqual(280)
  })

  it('throws a diagnosable error on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', text: async () => '{"detail":"not enough scope"}' }) as unknown as typeof fetch
    const t = new XTransport(OFFICIAL_CFG)
    await expect(t.sendAlert('public', whaleEvent())).rejects.toThrow(/403.*not enough scope/s)
  })

  it('throws when the response has no tweet id', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch
    const t = new XTransport(OFFICIAL_CFG)
    await expect(t.sendAlert('public', whaleEvent())).rejects.toThrow(/no tweet id/)
  })
})

describe('XTransport.sendAlert / sendDigest (xactions mode)', () => {
  it('POSTs to {url}/api/posting/tweet with a bearer token and treats 2xx as queued', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchSpy as unknown as typeof fetch
    const t = new XTransport(XACTIONS_CFG)
    await t.sendAlert('public', whaleEvent())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://xactions.example.com/api/posting/tweet')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer bearer-token')
  })

  it('logs that xactions delivery is not confirmed synchronously', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch
    const t = new XTransport(XACTIONS_CFG)
    await t.sendAlert('public', whaleEvent())
    expect(infoSpy.mock.calls.some((c) => String(c[1] ?? '').includes('not confirmed synchronously'))).toBe(true)
  })

  it('throws a diagnosable error on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'upstream down' }) as unknown as typeof fetch
    const t = new XTransport(XACTIONS_CFG)
    await expect(t.sendAlert('public', whaleEvent())).rejects.toThrow(/503.*upstream down/s)
  })

  it('sendDigest posts the most significant event with a summarized-count log', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchSpy as unknown as typeof fetch
    const t = new XTransport(XACTIONS_CFG)
    const events = [whaleEvent(), whaleEvent(), whaleEvent()]
    await t.sendDigest('public', events)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { text: string }
    expect(body.text).toContain('(+2 more)')

    const digestLog = infoSpy.mock.calls.find((c) => String(c[1] ?? '').includes('x digest sent'))
    expect(digestLog).toBeDefined()
    expect((digestLog?.[0] as Record<string, unknown>).count).toBe(3)
  })
})
