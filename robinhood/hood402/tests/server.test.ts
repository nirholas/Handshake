import { describe, expect, it, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { PaywallEngine, paywall } from '../src/server/index.js'
import { Hood402ConfigError } from '../src/errors.js'
import { FacilitatorClient } from '../src/facilitator-client.js'
import { PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER } from '../src/challenge.js'
import { encodePaymentHeader } from '../src/scheme/encoding.js'
import { randomNonce, TRANSFER_WITH_AUTHORIZATION_TYPES, usdgDomain } from '../src/scheme/exact.js'
import { ROBINHOOD_TESTNET } from '../src/networks.js'
import type { ExactEvmAuthorization, PaymentPayload } from '../src/types.js'

const payerAccount = privateKeyToAccount(generatePrivateKey())
const PAY_TO = '0x2222222222222222222222222222222222222222'
const NOW = 1_800_000_000

async function signedPayload(overrides: Partial<ExactEvmAuthorization> = {}): Promise<PaymentPayload> {
  const authorization: ExactEvmAuthorization = {
    from: payerAccount.address,
    to: PAY_TO,
    value: '10000',
    validAfter: String(NOW - 60),
    validBefore: String(NOW + 60),
    nonce: randomNonce(),
    ...overrides,
  }
  const signature = await payerAccount.signTypedData({
    domain: usdgDomain(ROBINHOOD_TESTNET),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  })
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'robinhood-testnet',
    payload: { signature, authorization },
  }
}

function stubFacilitator() {
  const client = Object.create(FacilitatorClient.prototype) as FacilitatorClient
  return client
}

describe('PaywallEngine construction', () => {
  it('throws Hood402ConfigError when neither facilitator nor a full self-settle set is given', () => {
    expect(
      () => new PaywallEngine({ price: '0.01', payTo: PAY_TO, resource: 'https://x.test/r' }),
    ).toThrow(Hood402ConfigError)
  })

  it('accepts facilitator mode with just a URL string', () => {
    expect(
      () =>
        new PaywallEngine({
          price: '0.01',
          payTo: PAY_TO,
          facilitator: 'https://facilitator.example.com',
        }),
    ).not.toThrow()
  })
})

describe('PaywallEngine.authorize — facilitator mode', () => {
  it('issues a 402 challenge when no X-PAYMENT header is present', async () => {
    const engine = new PaywallEngine({
      price: '0.01',
      payTo: PAY_TO,
      network: 'robinhood-testnet',
      facilitator: 'https://facilitator.example.com',
    })
    const auth = await engine.authorize(undefined, 'https://api.example.com/premium')
    expect(auth.ok).toBe(false)
    if (!auth.ok) {
      expect(auth.status).toBe(402)
      expect(auth.body.accepts[0]?.maxAmountRequired).toBe('10000')
      expect(auth.body.accepts[0]?.network).toBe('robinhood-testnet')
    }
  })

  it('issues a 402 with malformed_payment when the header cannot be decoded', async () => {
    const engine = new PaywallEngine({
      price: '0.01',
      payTo: PAY_TO,
      network: 'robinhood-testnet',
      facilitator: 'https://facilitator.example.com',
    })
    const auth = await engine.authorize('not-base64-garbage!!!', 'https://api.example.com/premium')
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.body.error).toBeTruthy()
  })

  it('delegates verification to the facilitator and passes through a valid payment', async () => {
    const facilitator = stubFacilitator()
    facilitator.verify = vi.fn().mockResolvedValue({ isValid: true, payer: payerAccount.address })
    const engine = new PaywallEngine({
      price: '0.01',
      payTo: PAY_TO,
      network: 'robinhood-testnet',
      facilitator,
    })
    const payload = await signedPayload()
    const auth = await engine.authorize(
      encodePaymentHeader(payload),
      'https://api.example.com/premium',
    )
    expect(auth.ok).toBe(true)
    expect(facilitator.verify).toHaveBeenCalledOnce()
  })

  it('turns a facilitator-rejected payment into a fresh 402', async () => {
    const facilitator = stubFacilitator()
    facilitator.verify = vi
      .fn()
      .mockResolvedValue({ isValid: false, invalidReason: 'insufficient_amount' })
    const engine = new PaywallEngine({
      price: '0.01',
      payTo: PAY_TO,
      network: 'robinhood-testnet',
      facilitator,
    })
    const payload = await signedPayload({ value: '1' })
    const auth = await engine.authorize(
      encodePaymentHeader(payload),
      'https://api.example.com/premium',
    )
    expect(auth.ok).toBe(false)
  })
})

describe('PaywallEngine.settle — facilitator mode', () => {
  it('delegates settlement and returns the receipt', async () => {
    const facilitator = stubFacilitator()
    facilitator.verify = vi.fn().mockResolvedValue({ isValid: true, payer: payerAccount.address })
    facilitator.settle = vi.fn().mockResolvedValue({
      success: true,
      transaction: '0xdeadbeef',
      network: 'robinhood-testnet',
      payer: payerAccount.address,
    })
    const engine = new PaywallEngine({
      price: '0.01',
      payTo: PAY_TO,
      network: 'robinhood-testnet',
      facilitator,
    })
    const payload = await signedPayload()
    const auth = await engine.authorize(
      encodePaymentHeader(payload),
      'https://api.example.com/premium',
    )
    expect(auth.ok).toBe(true)
    if (!auth.ok) return
    const settlement = await engine.settle(auth.payload, auth.requirements)
    expect(settlement.success).toBe(true)
    expect(engine.settlementHeader(settlement)).toEqual(expect.any(String))
  })
})

describe('paywall() Express middleware', () => {
  function mockReqRes(headerValue?: string) {
    const headers: Record<string, string> = {}
    const req = {
      header: (name: string) => (name.toLowerCase() === PAYMENT_HEADER.toLowerCase() ? headerValue : undefined),
      protocol: 'https',
      originalUrl: '/premium',
      get: (name: string) => (name === 'host' ? 'api.example.com' : undefined),
    }
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(body: unknown) {
        this.body = body
        return body
      },
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) {
        this.headers[name] = value
      },
    }
    return { req, res }
  }

  it('returns 402 and never calls next() when unpaid', async () => {
    const facilitator = stubFacilitator()
    const mw = paywall({ price: '0.01', payTo: PAY_TO, network: 'robinhood-testnet', facilitator })
    const { req, res } = mockReqRes()
    const next = vi.fn()
    await mw(req, res as never, next)
    expect(res.statusCode).toBe(402)
    expect(next).not.toHaveBeenCalled()
  })

  it('settles and calls next() with X-PAYMENT-RESPONSE set when paid', async () => {
    const facilitator = stubFacilitator()
    facilitator.verify = vi.fn().mockResolvedValue({ isValid: true, payer: payerAccount.address })
    facilitator.settle = vi.fn().mockResolvedValue({
      success: true,
      transaction: '0xdeadbeef',
      network: 'robinhood-testnet',
      payer: payerAccount.address,
    })
    const mw = paywall({ price: '0.01', payTo: PAY_TO, network: 'robinhood-testnet', facilitator })
    const payload = await signedPayload()
    const { req, res } = mockReqRes(encodePaymentHeader(payload))
    const next = vi.fn()
    await mw(req, res as never, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers[PAYMENT_RESPONSE_HEADER]).toBeTruthy()
  })
})
