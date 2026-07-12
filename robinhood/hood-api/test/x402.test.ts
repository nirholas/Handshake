import 'dotenv/config'
import { serve } from '@hono/node-server'
import { createSigner } from 'x402/types'
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApp } from '../src/app.js'

/**
 * Proves the full x402 402 -> pay -> 200 flow against a REAL running instance
 * of this server and the REAL public x402.org base-sepolia facilitator — no
 * mocked payment, no recorded fixture.
 *
 * Requires:
 *  - X402_PAY_TO set (a receiving address) so the server's payment middleware
 *    is active — otherwise every paid route returns a clean 503 and this
 *    suite only asserts that.
 *  - X402_TEST_PRIVATE_KEY set to a base-sepolia key holding a small amount
 *    of testnet USDC, to actually execute a settlement. Circle's faucet
 *    (faucet.circle.com) requires a browser + reCAPTCHA, so funding is an
 *    owner action; without a funded key this suite verifies the unpaid 402
 *    challenge shape (still real, still against the live facilitator) and
 *    explains exactly what to set to complete the paid leg.
 */

let server: ReturnType<typeof serve>
let baseUrl: string

beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
})

describe('x402 payment flow (real facilitator)', () => {
  it('unpaid request returns the real 402 challenge or a clean 503', async () => {
    const res = await fetch(`${baseUrl}/v1/portfolio/0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9`)
    if (res.status === 503) {
      console.warn('[x402.test] X402_PAY_TO not set — payments disabled, skipping challenge assertions')
      return
    }
    expect(res.status).toBe(402)
    const body = (await res.json()) as { accepts: Array<Record<string, unknown>>; x402Version: number }
    expect(body.x402Version).toBe(1)
    expect(body.accepts[0]?.scheme).toBe('exact')
    expect(body.accepts[0]?.network).toBe(process.env.X402_NETWORK || 'base-sepolia')
    expect(body.accepts[0]?.asset).toMatch(/^0x[a-fA-F0-9]{40}$/)
  })

  it('a funded payer completes 402 -> pay -> 200 end-to-end', async () => {
    if (!process.env.X402_PAY_TO) {
      console.warn('[x402.test] X402_PAY_TO not set — skipping paid E2E (payments disabled)')
      return
    }
    const pk = process.env.X402_TEST_PRIVATE_KEY
    if (!pk) {
      console.warn(
        '[x402.test] X402_TEST_PRIVATE_KEY not set — skipping paid E2E. ' +
          'To run this leg for real: fund a base-sepolia key with testnet USDC via ' +
          'https://faucet.circle.com (browser + reCAPTCHA, no scriptable faucet exists), ' +
          'set X402_TEST_PRIVATE_KEY to that key, and rerun `npm run test:x402`.',
      )
      return
    }

    const network = (process.env.X402_NETWORK as 'base' | 'base-sepolia') || 'base-sepolia'
    const signer = await createSigner(network, pk as `0x${string}`)
    const fetchWithPay = wrapFetchWithPayment(fetch, signer)

    const res = await fetchWithPay(`${baseUrl}/v1/portfolio/0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { owner: string }
    expect(body.owner).toBe('0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9')

    const paymentHeader = res.headers.get('x-payment-response')
    if (paymentHeader) {
      const decoded = decodeXPaymentResponse(paymentHeader)
      console.log('[x402.test] settlement:', decoded)
      expect(decoded.success).toBe(true)
    }
  })
})
