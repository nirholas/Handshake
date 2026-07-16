import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createWebhookEmitter,
  signWebhook,
  toWebhookEvent,
  verifyWebhookSignature,
  SIGNATURE_HEADER,
} from '../../src/verify/webhook.js'
import type { PaymentResult } from '../../src/verify/types.js'
import type { Address, Hex } from 'viem'

const SECRET = 'whsec_test_1234567890'

const result: PaymentResult = {
  status: 'paid',
  expectedRaw: 12_500_042n,
  receivedRaw: 12_500_042n,
  overageRaw: 0n,
  payer: '0x2d4d2A025b10C09BDbd794B4FCe4F7ea8C7d7bB4' as Address,
  transfers: [
    {
      txHash: `0x${'aa'.repeat(32)}` as Hex,
      logIndex: 3,
      blockNumber: 123456n,
      blockHash: `0x${'bb'.repeat(32)}` as Hex,
      payer: '0x2d4d2A025b10C09BDbd794B4FCe4F7ea8C7d7bB4' as Address,
      amountRaw: 12_500_042n,
    },
  ],
}

describe('signature scheme', () => {
  it('signs and verifies round-trip', () => {
    const body = JSON.stringify(toWebhookEvent('payment.paid', 'inv_1', result))
    const now = Math.floor(Date.now() / 1000)
    const header = signWebhook(SECRET, body, now)
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(verifyWebhookSignature(SECRET, body, header)).toBe(true)
  })

  it('rejects wrong secret, tampered body, stale timestamp, malformed header', () => {
    const body = '{"type":"payment.paid"}'
    const now = 1_800_000_000
    const header = signWebhook(SECRET, body, now)
    expect(verifyWebhookSignature('other', body, header, { now })).toBe(false)
    expect(verifyWebhookSignature(SECRET, body + ' ', header, { now })).toBe(false)
    expect(verifyWebhookSignature(SECRET, body, header, { now: now + 301 })).toBe(false)
    expect(verifyWebhookSignature(SECRET, body, header, { now: now + 299 })).toBe(true)
    expect(verifyWebhookSignature(SECRET, body, 't=zzz,v1=00', { now })).toBe(false)
    expect(verifyWebhookSignature(SECRET, body, '', { now })).toBe(false)
  })

  it('serializes bigints as decimal strings', () => {
    const event = toWebhookEvent('payment.paid', 'inv_1', result)
    expect(event.payment.expectedRaw).toBe('12500042')
    expect(event.payment.transfers[0]!.blockNumber).toBe('123456')
    expect(() => JSON.stringify(event)).not.toThrow()
  })
})

describe('emitter against a real HTTP server', () => {
  let server: Server
  let url: string
  let failuresLeft = 0
  const received: Array<{ body: string; signature: string }> = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString()))
      req.on('end', () => {
        if (failuresLeft > 0) {
          failuresLeft--
          res.writeHead(500).end()
          return
        }
        received.push({ body, signature: String(req.headers[SIGNATURE_HEADER]) })
        res.writeHead(200).end('ok')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address === 'object' && address) url = `http://127.0.0.1:${address.port}/webhook`
  })

  afterAll(() => server.close())

  it('delivers a signed event the receiver can verify', async () => {
    const emitter = createWebhookEmitter({ url, secret: SECRET, retryDelaysMs: [0, 10] })
    const outcome = await emitter.emit(toWebhookEvent('payment.paid', 'inv_1', result))
    expect(outcome).toMatchObject({ ok: true, attempts: 1, status: 200 })
    const delivery = received.at(-1)!
    expect(verifyWebhookSignature(SECRET, delivery.body, delivery.signature)).toBe(true)
    expect(JSON.parse(delivery.body).invoiceId).toBe('inv_1')
  })

  it('retries 5xx and succeeds', async () => {
    failuresLeft = 2
    const emitter = createWebhookEmitter({ url, secret: SECRET, retryDelaysMs: [0, 5, 5] })
    const outcome = await emitter.emit(toWebhookEvent('payment.paid', 'inv_2', result))
    expect(outcome).toMatchObject({ ok: true, attempts: 3 })
  })

  it('gives up after exhausting retries', async () => {
    failuresLeft = 99
    const emitter = createWebhookEmitter({ url, secret: SECRET, retryDelaysMs: [0, 5] })
    const outcome = await emitter.emit(toWebhookEvent('payment.paid', 'inv_3', result))
    expect(outcome.ok).toBe(false)
    expect(outcome.attempts).toBe(2)
    failuresLeft = 0
  })

  it('does not retry a 4xx rejection', async () => {
    const rejecting = createServer((_req, res) => res.writeHead(400).end())
    await new Promise<void>((resolve) => rejecting.listen(0, '127.0.0.1', resolve))
    const address = rejecting.address()
    const badUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
    const emitter = createWebhookEmitter({ url: badUrl, secret: SECRET, retryDelaysMs: [0, 5, 5] })
    const outcome = await emitter.emit(toWebhookEvent('payment.paid', 'inv_4', result))
    expect(outcome).toMatchObject({ ok: false, attempts: 1, status: 400 })
    rejecting.close()
  })
})
