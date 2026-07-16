/**
 * Type-level tests: the wrong multiplier usage must NOT compile.
 *
 * Run via vitest typecheck (`npm test`). Every `@ts-expect-error` line
 * asserts that the marked expression is a compile error; if the API ever
 * loosens so the misuse compiles, tsc reports the directive as unused and
 * the typecheck stage fails.
 */
import { describe, expectTypeOf, it } from 'vitest'
import {
  adjustedPrice,
  rawPrice,
  trueValue,
  type AdjustedPrice,
  type RawPrice,
  type StockPrice,
} from '../../src/index.js'

describe('branded price types', () => {
  it('bare numbers are not prices', () => {
    // @ts-expect-error a bare number is not a StockPrice - declare the kind
    trueValue({ raw: 1n, multiplier: 10n ** 18n, price: 100.62 })
  })

  it('structural literals cannot forge a price', () => {
    // @ts-expect-error object literals lack the brand: use adjustedPrice()
    trueValue({ raw: 1n, multiplier: 10n ** 18n, price: { usd: 100.62, adjusted: true } })
    // @ts-expect-error object literals lack the brand: use rawPrice()
    const forged: RawPrice = { usd: 100.52, adjusted: false }
    void forged
  })

  it('the two price kinds are not interchangeable', () => {
    expectTypeOf<AdjustedPrice>().not.toExtend<RawPrice>()
    expectTypeOf<RawPrice>().not.toExtend<AdjustedPrice>()

    const adjusted = adjustedPrice(100.62)
    const raw = rawPrice(100.52)
    expectTypeOf(adjusted).toExtend<StockPrice>()
    expectTypeOf(raw).toExtend<StockPrice>()

    // @ts-expect-error an AdjustedPrice cannot stand in for a RawPrice
    const wrongKind: RawPrice = adjusted
    void wrongKind
  })

  it('constructors return the exact branded kind', () => {
    expectTypeOf(adjustedPrice).returns.toEqualTypeOf<AdjustedPrice>()
    expectTypeOf(rawPrice).returns.toEqualTypeOf<RawPrice>()
    expectTypeOf(adjustedPrice(1).adjusted).toEqualTypeOf<true>()
    expectTypeOf(rawPrice(1).adjusted).toEqualTypeOf<false>()
  })

  it('trueValue requires bigint raw and multiplier', () => {
    // @ts-expect-error raw must be a bigint, not a number
    trueValue({ raw: 1, multiplier: 10n ** 18n, price: adjustedPrice(1) })
    // @ts-expect-error multiplier must be a bigint, not a number
    trueValue({ raw: 1n, multiplier: 1e18, price: adjustedPrice(1) })
  })
})
