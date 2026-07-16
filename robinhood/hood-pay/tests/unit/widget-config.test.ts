import { describe, expect, it } from 'vitest'
import { validateCheckoutConfig } from '../../src/widget/widget.js'

const PAY_TO = '0x4022de2D36C334E73C7a108805Cea11C0564f402'

describe('validateCheckoutConfig', () => {
  it('accepts a minimal config and defaults to mainnet USDG', () => {
    const { request } = validateCheckoutConfig({ payTo: PAY_TO, amount: '9.99' })
    expect(request.network).toBe('mainnet')
    expect(request.payTo).toBe(PAY_TO)
    expect(request.amount).toBe('9.99')
  })

  it('rejects non-object and callback-shaped mistakes', () => {
    expect(() => validateCheckoutConfig(null)).toThrow(/object/)
    expect(() => validateCheckoutConfig('config')).toThrow(/object/)
    expect(() => validateCheckoutConfig({ payTo: PAY_TO, amount: '1', onSuccess: 'yes' })).toThrow(/onSuccess/)
    expect(() => validateCheckoutConfig({ payTo: PAY_TO, amount: '1', onError: 42 })).toThrow(/onError/)
    expect(() => validateCheckoutConfig({ payTo: PAY_TO, amount: '1', onStateChange: {} })).toThrow(/onStateChange/)
  })

  it('propagates request-level validation', () => {
    expect(() => validateCheckoutConfig({ payTo: 'nope', amount: '1' })).toThrow(/payTo/)
    expect(() => validateCheckoutConfig({ payTo: PAY_TO, amount: 'free' })).toThrow(/decimal/)
    expect(() =>
      validateCheckoutConfig({ payTo: PAY_TO, amount: '1', reference: `0x${'22'.repeat(32)}` }),
    ).toThrow(/router/)
  })

  it('carries callbacks through', () => {
    const onSuccess = () => {}
    const out = validateCheckoutConfig({ payTo: PAY_TO, amount: '1', onSuccess })
    expect(out.onSuccess).toBe(onSuccess)
  })
})
