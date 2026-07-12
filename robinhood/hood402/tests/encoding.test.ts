import { describe, expect, it } from 'vitest'
import {
  decodePaymentHeader,
  decodeSettlementHeader,
  encodePaymentHeader,
  encodeSettlementHeader,
} from '../src/scheme/encoding.js'
import type { PaymentPayload, SettleResult } from '../src/types.js'

const samplePayload: PaymentPayload = {
  x402Version: 1,
  scheme: 'exact',
  network: 'robinhood-testnet',
  payload: {
    signature: '0xabc123',
    authorization: {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '10000',
      validAfter: '1000',
      validBefore: '2000',
      nonce: '0xdead',
    },
  },
}

describe('payment header encoding', () => {
  it('round-trips a payload through base64', () => {
    const header = encodePaymentHeader(samplePayload)
    expect(typeof header).toBe('string')
    const decoded = decodePaymentHeader(header)
    expect(decoded).toEqual(samplePayload)
  })

  it('preserves unicode in description-adjacent fields', () => {
    const withUnicode: PaymentPayload = {
      ...samplePayload,
      network: 'robinhood-testnet — 测试',
    }
    const header = encodePaymentHeader(withUnicode)
    expect(decodePaymentHeader(header)).toEqual(withUnicode)
  })

  it('returns null for a missing header', () => {
    expect(decodePaymentHeader(undefined)).toBeNull()
    expect(decodePaymentHeader(null)).toBeNull()
    expect(decodePaymentHeader('')).toBeNull()
  })

  it('returns null (never throws) for malformed base64', () => {
    expect(decodePaymentHeader('not-valid-base64!!!')).toBeNull()
  })

  it('returns null for base64 that decodes to non-JSON', () => {
    const garbage = Buffer.from('this is not json').toString('base64')
    expect(decodePaymentHeader(garbage)).toBeNull()
  })

  it('returns null for base64 JSON that is not an object (e.g. a bare number)', () => {
    const notObject = Buffer.from('42').toString('base64')
    expect(decodePaymentHeader(notObject)).toBeNull()
  })
})

describe('settlement header encoding', () => {
  it('round-trips a settle result', () => {
    const result: SettleResult = {
      success: true,
      transaction: '0xdeadbeef',
      network: 'robinhood-testnet',
      payer: '0x1111111111111111111111111111111111111111',
    }
    const header = encodeSettlementHeader(result)
    expect(decodeSettlementHeader(header)).toEqual(result)
  })

  it('returns null for malformed settlement headers', () => {
    expect(decodeSettlementHeader('%%%not-base64%%%')).toBeNull()
    expect(decodeSettlementHeader(undefined)).toBeNull()
  })
})
