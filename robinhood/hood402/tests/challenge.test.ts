import { describe, expect, it } from 'vitest'
import { buildPaymentRequired, buildRequirements, toAtomic } from '../src/challenge.js'
import { ROBINHOOD_MAINNET, ROBINHOOD_TESTNET } from '../src/networks.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'

describe('toAtomic', () => {
  it('converts a human decimal string to 6-decimal atomic units', () => {
    expect(toAtomic('0.01', 6)).toBe('10000')
    expect(toAtomic('1', 6)).toBe('1000000')
    expect(toAtomic('0.000001', 6)).toBe('1')
  })

  it('passes through pre-atomic values', () => {
    expect(toAtomic({ atomic: '12345' }, 6)).toBe('12345')
  })

  it('converts the usdg-tagged form', () => {
    expect(toAtomic({ usdg: '2.50' }, 6)).toBe('2500000')
  })
})

describe('buildRequirements', () => {
  it('builds a spec-compliant requirement for mainnet USDG by default', () => {
    const req = buildRequirements({
      price: '0.05',
      payTo: PAY_TO,
      resource: 'https://api.example.com/data',
    })
    expect(req.scheme).toBe('exact')
    expect(req.network).toBe(ROBINHOOD_MAINNET.id)
    expect(req.asset).toBe(ROBINHOOD_MAINNET.usdg)
    expect(req.maxAmountRequired).toBe('50000')
    expect(req.payTo.toLowerCase()).toBe(PAY_TO.toLowerCase())
    expect(req.maxTimeoutSeconds).toBe(60)
    expect(req.mimeType).toBe('application/json')
    expect(req.extra).toEqual({ name: 'Global Dollar', version: '1' })
  })

  it('resolves the testnet network and its USDG address', () => {
    const req = buildRequirements({
      price: '1.00',
      payTo: PAY_TO,
      resource: 'https://api.example.com/data',
      network: 'robinhood-testnet',
    })
    expect(req.network).toBe(ROBINHOOD_TESTNET.id)
    expect(req.asset).toBe(ROBINHOOD_TESTNET.usdg)
  })

  it('accepts network aliases (three.ws catalog naming)', () => {
    const req = buildRequirements({
      price: '1.00',
      payTo: PAY_TO,
      resource: 'https://api.example.com/data',
      network: 'robinhood-chain',
    })
    expect(req.network).toBe(ROBINHOOD_MAINNET.id)
  })

  it('rejects an unknown network', () => {
    expect(() =>
      buildRequirements({
        price: '1.00',
        payTo: PAY_TO,
        resource: 'https://api.example.com/data',
        network: 'ethereum-mainnet',
      }),
    ).toThrow(/unknown network/)
  })
})

describe('buildPaymentRequired', () => {
  it('wraps requirements into a v1 402 body', () => {
    const req = buildRequirements({ price: '0.01', payTo: PAY_TO, resource: 'https://x.test/r' })
    const body = buildPaymentRequired(req)
    expect(body.x402Version).toBe(1)
    expect(body.accepts).toEqual([req])
    expect(body.error).toBeUndefined()
  })

  it('includes an error message when given one', () => {
    const req = buildRequirements({ price: '0.01', payTo: PAY_TO, resource: 'https://x.test/r' })
    const body = buildPaymentRequired(req, 'insufficient funds')
    expect(body.error).toBe('insufficient funds')
  })
})
