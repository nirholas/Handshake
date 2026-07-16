import { describe, expect, it } from 'vitest'
import { dedupTtlSeconds, fingerprint, type AlertEvent } from '../src/engine/events.js'

const TOKEN = '0x1234567890123456789012345678901234567890'

describe('fingerprint', () => {
  it('is stable and lowercases the token for launch/whale', () => {
    const launch: AlertEvent = {
      type: 'launch',
      launchpad: 'noxa',
      token: TOKEN.toUpperCase() as `0x${string}`,
      symbol: 'X',
      name: null,
      creator: TOKEN as `0x${string}`,
      pool: null,
      blockNumber: 1n,
      transactionHash: '0xabc',
      at: 0,
    }
    expect(fingerprint(launch)).toBe(`launch:0xabc:${TOKEN.toLowerCase()}`)
  })

  it('distinguishes graduation by token', () => {
    const grad = (token: string): AlertEvent => ({ type: 'graduation', token: token as `0x${string}`, symbol: null, name: null, pool: TOKEN as `0x${string}`, blockNumber: 1n, transactionHash: '0x1', at: 0 })
    expect(fingerprint(grad(TOKEN))).toBe(`grad:${TOKEN.toLowerCase()}`)
    expect(fingerprint(grad(TOKEN))).not.toBe(fingerprint(grad('0x0000000000000000000000000000000000dead')))
  })

  it('rounds the whale usd amount into the fingerprint so near-identical trades still dedup', () => {
    const whale = (usd: number): AlertEvent => ({ type: 'whale', source: 'uniswap-v3', token: TOKEN as `0x${string}`, symbol: null, side: 'buy', usd, trader: TOKEN as `0x${string}`, blockNumber: 1n, transactionHash: '0xabc', at: 0 })
    expect(fingerprint(whale(5000.4))).toBe(fingerprint(whale(5000.2)))
    expect(fingerprint(whale(5000))).not.toBe(fingerprint(whale(5001)))
  })

  it('keys price_move by symbol and timestamp', () => {
    const move: AlertEvent = { type: 'price_move', symbol: 'TSLA', pct: 5, fromUsd: 1, toUsd: 1.05, windowS: 900, at: 123 }
    expect(fingerprint(move)).toBe('price:TSLA:123')
  })

  it('keys premium by symbol, direction and rung', () => {
    const premium: AlertEvent = { type: 'premium', symbol: 'TSLA', token: TOKEN as `0x${string}`, premiumPct: 3, level: 2, direction: 'premium', dexUsd: 1, feedUsd: 1, pool: TOKEN as `0x${string}`, at: 0 }
    expect(fingerprint(premium)).toBe('premium:TSLA:premium:2')
  })

  it('keys holders by token and milestone', () => {
    const holders: AlertEvent = { type: 'holders', token: TOKEN as `0x${string}`, symbol: null, milestone: 1000, count: 1001, at: 0 }
    expect(fingerprint(holders)).toBe(`holders:${TOKEN.toLowerCase()}:1000`)
  })

  it('keys liquidity_pull by pool only', () => {
    const pull: AlertEvent = { type: 'liquidity_pull', token: null, symbol: null, pool: TOKEN.toUpperCase() as `0x${string}`, quoteAsset: 'USDG', droppedPct: 40, beforeUsd: 100, afterUsd: 60, at: 0 }
    expect(fingerprint(pull)).toBe(`liq:${TOKEN.toLowerCase()}`)
  })
})

describe('dedupTtlSeconds', () => {
  it('gives launches, graduations, and whales a 7-day window', () => {
    const week = 7 * 24 * 3600
    const launch: AlertEvent = { type: 'launch', launchpad: 'noxa', token: TOKEN as `0x${string}`, symbol: null, name: null, creator: TOKEN as `0x${string}`, pool: null, blockNumber: 1n, transactionHash: '0x1', at: 0 }
    const grad: AlertEvent = { type: 'graduation', token: TOKEN as `0x${string}`, symbol: null, name: null, pool: TOKEN as `0x${string}`, blockNumber: 1n, transactionHash: '0x1', at: 0 }
    const whale: AlertEvent = { type: 'whale', source: 'uniswap-v3', token: TOKEN as `0x${string}`, symbol: null, side: 'buy', usd: 1, trader: TOKEN as `0x${string}`, blockNumber: 1n, transactionHash: '0x1', at: 0 }
    expect(dedupTtlSeconds(launch)).toBe(week)
    expect(dedupTtlSeconds(grad)).toBe(week)
    expect(dedupTtlSeconds(whale)).toBe(week)
  })

  it('gives price_move a 1-day window and premium a 6-hour window', () => {
    const move: AlertEvent = { type: 'price_move', symbol: 'TSLA', pct: 1, fromUsd: 1, toUsd: 1, windowS: 900, at: 0 }
    const premium: AlertEvent = { type: 'premium', symbol: 'TSLA', token: TOKEN as `0x${string}`, premiumPct: 1, level: 1, direction: 'premium', dexUsd: 1, feedUsd: 1, pool: TOKEN as `0x${string}`, at: 0 }
    expect(dedupTtlSeconds(move)).toBe(24 * 3600)
    expect(dedupTtlSeconds(premium)).toBe(6 * 3600)
  })

  it('gives holders a 30-day window and liquidity_pull a 1-hour window', () => {
    const holders: AlertEvent = { type: 'holders', token: TOKEN as `0x${string}`, symbol: null, milestone: 1, count: 1, at: 0 }
    const pull: AlertEvent = { type: 'liquidity_pull', token: null, symbol: null, pool: TOKEN as `0x${string}`, quoteAsset: 'USDG', droppedPct: 1, beforeUsd: 1, afterUsd: 1, at: 0 }
    expect(dedupTtlSeconds(holders)).toBe(30 * 24 * 3600)
    expect(dedupTtlSeconds(pull)).toBe(3600)
  })
})
