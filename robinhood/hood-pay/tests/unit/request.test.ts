import { describe, expect, it } from 'vitest'
import {
  decodePaymentRequest,
  encodePaymentRequest,
  formatRequestAmount,
  paymentLinkUrl,
  requestRawAmount,
  requestToken,
  validatePaymentRequest,
} from '../../src/request.js'
import { networkInfo } from '../../src/networks.js'

const PAY_TO = '0x4022de2D36C334E73C7a108805Cea11C0564f402'
const ROUTER = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'
const REF = `0x${'11'.repeat(32)}` as const

describe('validatePaymentRequest', () => {
  it('normalizes a minimal mainnet USDG request', () => {
    const request = validatePaymentRequest({ payTo: PAY_TO.toLowerCase(), amount: '12.50' })
    expect(request.v).toBe(1)
    expect(request.network).toBe('mainnet')
    expect(request.payTo).toBe(PAY_TO) // checksum restored
    expect(requestToken(request)).toEqual(networkInfo('mainnet').usdg)
    expect(requestRawAmount(request)).toBe(12_500_000n)
    expect(formatRequestAmount(request, 12_500_042n)).toBe('12.500042')
  })

  it('rejects a bad EIP-55 checksum', () => {
    const badChecksum = PAY_TO.replace('D', 'd').replace('C', 'c')
    expect(() => validatePaymentRequest({ payTo: badChecksum, amount: '1' })).toThrow()
  })

  it('rejects malformed addresses, amounts, and networks', () => {
    expect(() => validatePaymentRequest({ payTo: '0x123', amount: '1' })).toThrow(/payTo/)
    expect(() => validatePaymentRequest({ payTo: PAY_TO, amount: '1,50' })).toThrow(/decimal/)
    expect(() => validatePaymentRequest({ payTo: PAY_TO, amount: '-1' })).toThrow(/decimal/)
    expect(() => validatePaymentRequest({ payTo: PAY_TO, amount: '0' })).toThrow(/greater than zero/)
    expect(() => validatePaymentRequest({ payTo: PAY_TO, amount: '1e3' })).toThrow(/decimal/)
    expect(() => validatePaymentRequest({ payTo: PAY_TO, amount: '1', network: 'base' })).toThrow(/network/)
    expect(() => validatePaymentRequest({ payTo: PAY_TO, amount: 5 })).toThrow(/string/)
  })

  it('rejects more decimals than the token carries', () => {
    expect(() => validatePaymentRequest({ payTo: PAY_TO, amount: '1.1234567' })).toThrow(/decimal places/)
    expect(validatePaymentRequest({ payTo: PAY_TO, amount: '1.123456' }).amount).toBe('1.123456')
  })

  it('accepts dynamic amounts', () => {
    const request = validatePaymentRequest({ payTo: PAY_TO, amount: 'dynamic' })
    expect(request.amount).toBe('dynamic')
    expect(() => requestRawAmount(request)).toThrow(/dynamic/)
  })

  it('validates token overrides', () => {
    const token = { address: ROUTER.toLowerCase(), symbol: 'TSLA', decimals: 18 }
    const request = validatePaymentRequest({ payTo: PAY_TO, amount: '0.5', token })
    expect(request.token?.address).toBe(ROUTER)
    expect(requestRawAmount(request)).toBe(500_000_000_000_000_000n)
    expect(() =>
      validatePaymentRequest({ payTo: PAY_TO, amount: '1', token: { ...token, decimals: 37 } }),
    ).toThrow(/decimals/)
    expect(() =>
      validatePaymentRequest({ payTo: PAY_TO, amount: '1', token: { ...token, symbol: '' } }),
    ).toThrow(/symbol/)
  })

  it('enforces router-mode pairing', () => {
    expect(() => validatePaymentRequest({ payTo: PAY_TO, amount: '1', reference: REF })).toThrow(/router/)
    expect(() => validatePaymentRequest({ payTo: PAY_TO, amount: '1', router: ROUTER })).toThrow(/reference/)
    expect(() => validatePaymentRequest({ payTo: PAY_TO, amount: '1', reference: '0x1234', router: ROUTER })).toThrow(
      /32-byte/,
    )
    const request = validatePaymentRequest({ payTo: PAY_TO, amount: '1', reference: REF, router: ROUTER })
    expect(request.reference).toBe(REF)
    expect(request.router).toBe(ROUTER)
  })

  it('caps the memo length', () => {
    const request = validatePaymentRequest({ payTo: PAY_TO, amount: '1', memo: 'x'.repeat(500) })
    expect(request.memo).toHaveLength(280)
  })
})

describe('payment link codec', () => {
  it('round-trips every field through the fragment', () => {
    const request = validatePaymentRequest({
      network: 'testnet',
      payTo: PAY_TO,
      amount: '3.99',
      memo: 'Invoice #7 - sticker pack (unicode: Ω≈ç√)',
      reference: REF,
      router: ROUTER,
    })
    const fragment = encodePaymentRequest(request)
    expect(fragment.startsWith('1.')).toBe(true)
    expect(decodePaymentRequest(fragment)).toEqual(request)
    expect(decodePaymentRequest(`#${fragment}`)).toEqual(request)
  })

  it('builds hosted links against the default and custom bases', () => {
    const request = validatePaymentRequest({ payTo: PAY_TO, amount: '25' })
    expect(paymentLinkUrl(request)).toMatch(/^https:\/\/nirholas\.github\.io\/hood-pay\/pay\.html#1\./)
    expect(paymentLinkUrl(request, 'https://shop.example/pay.html')).toMatch(/^https:\/\/shop\.example\/pay\.html#1\./)
  })

  it('rejects tampered and malformed fragments', () => {
    expect(() => decodePaymentRequest('no-dot')).toThrow(/version/)
    expect(() => decodePaymentRequest('2.abcd')).toThrow(/version "2"/)
    expect(() => decodePaymentRequest('1.!!!not-base64!!!')).toThrow(/malformed/)
    const fragment = encodePaymentRequest(validatePaymentRequest({ payTo: PAY_TO, amount: '25' }))
    expect(() => decodePaymentRequest(`1.${fragment.slice(2, -4)}`)).toThrow()
  })
})
