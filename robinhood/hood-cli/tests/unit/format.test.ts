import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import { usd, num, compact, pct, shortAddress, age, tokenAmount } from '../../src/format.js'
import { setColorEnabled } from '../../src/ui/ansi.js'

setColorEnabled(false)

describe('usd', () => {
  it('formats a normal price with 2 decimals', () => {
    expect(usd(315.5)).toBe('$315.50')
  })
  it('widens precision for sub-cent values', () => {
    expect(usd(0.0001234)).toBe('$0.000123')
  })
  it('uses 4 decimals under a dollar', () => {
    expect(usd(0.5)).toBe('$0.5000')
  })
  it('handles zero', () => {
    expect(usd(0)).toBe('$0.00')
  })
  it('returns an em dash for non-finite input', () => {
    expect(usd(NaN)).toBe('—')
    expect(usd(Infinity)).toBe('—')
  })
  it('groups thousands', () => {
    expect(usd(1234567.89)).toBe('$1,234,567.89')
  })
})

describe('num', () => {
  it('groups thousands with a bounded fraction', () => {
    expect(num(1234.56789, 2)).toBe('1,234.57')
  })
  it('defaults to 4 max fraction digits', () => {
    expect(num(1.123456789)).toBe('1.1235')
  })
})

describe('compact', () => {
  it('compacts large numbers', () => {
    expect(compact(1_234_567)).toBe('1.23M')
  })
})

describe('pct', () => {
  it('formats a positive ratio with a plus sign', () => {
    expect(pct(0.0123).replace(/\x1b\[[0-9;]*m/g, '')).toBe('+1.23%')
  })
  it('formats a negative ratio', () => {
    expect(pct(-0.05).replace(/\x1b\[[0-9;]*m/g, '')).toBe('-5.00%')
  })
  it('formats exact zero without a sign', () => {
    expect(pct(0)).toBe('0.00%')
  })
})

describe('shortAddress', () => {
  it('middle-truncates a 42-char address', () => {
    expect(shortAddress('0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9')).toBe('0xaF3D…93f9')
  })
  it('leaves short strings untouched', () => {
    expect(shortAddress('0xabc')).toBe('0xabc')
  })
})

describe('age', () => {
  it('renders seconds under a minute', () => {
    expect(age(42)).toBe('42s')
  })
  it('renders minutes under an hour', () => {
    expect(age(125)).toBe('2m')
  })
  it('renders hours and minutes under a day', () => {
    expect(age(3 * 3600 + 5 * 60)).toBe('3h 5m')
  })
  it('renders days and hours', () => {
    expect(age(2 * 86400 + 4 * 3600)).toBe('2d 4h')
  })
  it('returns an em dash for negative input', () => {
    expect(age(-1)).toBe('—')
  })
})

describe('tokenAmount', () => {
  it('renders a whole-token amount with no trailing zeros', () => {
    expect(tokenAmount(parseUnits('1', 18), 18)).toBe('1')
  })
  it('trims trailing zeros in the fraction', () => {
    expect(tokenAmount(parseUnits('1.5', 18), 18)).toBe('1.5')
  })
  it('caps fractional precision', () => {
    expect(tokenAmount(parseUnits('1.123456789', 18), 18, 4)).toBe('1.1234')
  })
  it('formats USDG-style 6-decimal amounts', () => {
    expect(tokenAmount(parseUnits('100', 6), 6)).toBe('100')
  })
})
