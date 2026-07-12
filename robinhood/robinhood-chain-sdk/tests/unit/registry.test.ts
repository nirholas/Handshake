import { describe, expect, it } from 'vitest'
import { getAddress, isAddress } from 'viem'
import {
  getRegistry,
  getStockToken,
  getStockTokenByAddress,
  isStockTokenAddress,
  isStockTokenSymbol,
  listPricedStockTokens,
  listStockTokens,
} from '../../src/registry/index.js'
import { UnknownSymbolError } from '../../src/errors.js'

describe('stock token registry integrity', () => {
  const registry = getRegistry()

  it('targets Robinhood Chain mainnet', () => {
    expect(registry.chainId).toBe(4663)
    expect(registry.generatedAtBlock).toBeGreaterThan(0)
  })

  it('ships the full on-chain token set', () => {
    expect(registry.tokens.length).toBe(registry.tokenCount)
    expect(registry.tokens.length).toBeGreaterThanOrEqual(95)
  })

  it('records the shared Stock beacon every proxy was verified against', () => {
    expect(isAddress(registry.stockBeacon)).toBe(true)
  })

  it('every entry has a checksummed address', () => {
    for (const t of registry.tokens) {
      expect(isAddress(t.address), `${t.symbol} address`).toBe(true)
      expect(getAddress(t.address), `${t.symbol} checksum`).toBe(t.address)
    }
  })

  it('every entry follows the canonical naming pattern and has 18 decimals', () => {
    for (const t of registry.tokens) {
      expect(t.name, t.symbol).toContain('• Robinhood Token')
      expect(t.decimals, t.symbol).toBe(18)
      expect(t.symbol).toMatch(/^[A-Z0-9.]{1,8}$/)
    }
  })

  it('symbols are unique', () => {
    const symbols = registry.tokens.map((t) => t.symbol)
    expect(new Set(symbols).size).toBe(symbols.length)
  })

  it('addresses are unique', () => {
    const addresses = registry.tokens.map((t) => t.address.toLowerCase())
    expect(new Set(addresses).size).toBe(addresses.length)
  })

  it('feed entries are checksummed and carry 8 answer decimals', () => {
    const priced = listPricedStockTokens()
    expect(priced.length).toBe(registry.feedCount)
    expect(priced.length).toBeGreaterThanOrEqual(30)
    for (const t of priced) {
      expect(isAddress(t.feed as string), `${t.symbol} feed`).toBe(true)
      expect(getAddress(t.feed as string)).toBe(t.feed)
      expect(t.feedDecimals).toBe(8)
    }
  })

  it('feedless entries have null feed AND null feedDecimals', () => {
    for (const t of listStockTokens().filter((t) => t.feed === null)) {
      expect(t.feedDecimals, t.symbol).toBeNull()
    }
  })

  it('uiMultiplier snapshots are 1e18-scaled positive integers', () => {
    for (const t of registry.tokens) {
      const m = BigInt(t.uiMultiplierAtGeneration)
      expect(m >= 10n ** 17n, `${t.symbol} multiplier ${m} suspiciously small`).toBe(true)
      expect(m < 10n ** 21n, `${t.symbol} multiplier ${m} suspiciously large`).toBe(true)
    }
  })

  it('the flagship tickers are present with their documented addresses', () => {
    // Cross-checked against https://docs.robinhood.com/chain/contracts
    expect(getStockToken('AAPL').address).toBe('0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9')
    expect(getStockToken('TSLA').address).toBe('0x322F0929c4625eD5bAd873c95208D54E1c003b2d')
    expect(getStockToken('NVDA').address).toBe('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC')
    expect(getStockToken('SPY').address).toBe('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C')
  })

  it('lookups are case-insensitive and typed errors fire on misses', () => {
    expect(getStockToken('tsla').symbol).toBe('TSLA')
    expect(isStockTokenSymbol('aapl')).toBe(true)
    expect(isStockTokenSymbol('NOT_A_TICKER')).toBe(false)
    expect(() => getStockToken('NOT_A_TICKER')).toThrowError(UnknownSymbolError)
  })

  it('address lookups round-trip', () => {
    const tsla = getStockToken('TSLA')
    expect(getStockTokenByAddress(tsla.address)?.symbol).toBe('TSLA')
    expect(isStockTokenAddress(tsla.address)).toBe(true)
    expect(isStockTokenAddress('0x0000000000000000000000000000000000000001')).toBe(false)
  })
})
