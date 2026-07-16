import { describe, expect, it } from 'vitest'
import { defaultThreshold, matches, parseTopic, resolveWatchTarget, PREMIUM_TOPICS } from '../src/engine/topics.js'
import type { AlertEvent } from '../src/engine/events.js'

describe('parseTopic', () => {
  it('parses the fixed topics', () => {
    expect(parseTopic('launches')).toEqual({ kind: 'launches', launchpad: null })
    expect(parseTopic('launches:noxa')).toEqual({ kind: 'launches', launchpad: 'noxa' })
    expect(parseTopic('launches:odyssey')).toEqual({ kind: 'launches', launchpad: 'odyssey' })
    expect(parseTopic('graduations')).toEqual({ kind: 'graduations' })
    expect(parseTopic('whales')).toEqual({ kind: 'whales' })
    expect(parseTopic('premiums')).toEqual({ kind: 'premiums' })
    expect(parseTopic('rugs')).toEqual({ kind: 'rugs' })
  })

  it('parses a token topic from a lowercase 0x address', () => {
    const addr = '0x1234567890123456789012345678901234567890'
    expect(parseTopic(`token:${addr}`)).toEqual({ kind: 'token', address: addr })
  })

  it('rejects a token topic with an uppercase or malformed address', () => {
    expect(parseTopic('token:0x1234567890123456789012345678901234567890'.toUpperCase())).toBeNull()
    expect(parseTopic('token:0xnotanaddress')).toBeNull()
  })

  it('parses a stock topic', () => {
    expect(parseTopic('stock:TSLA')).toEqual({ kind: 'stock', symbol: 'TSLA' })
    expect(parseTopic('stock:AAPL.X')).toEqual({ kind: 'stock', symbol: 'AAPL.X' })
  })

  it('rejects an unknown or malformed topic', () => {
    expect(parseTopic('bogus')).toBeNull()
    expect(parseTopic('stock:')).toBeNull()
    expect(parseTopic('stock:lowercase')).toBeNull()
  })
})

describe('resolveWatchTarget', () => {
  it('resolves the fixed keywords, case-insensitively', () => {
    expect(resolveWatchTarget('Launches')).toEqual({ ok: true, topic: 'launches' })
    expect(resolveWatchTarget('launch')).toEqual({ ok: true, topic: 'launches' })
    expect(resolveWatchTarget('NOXA')).toEqual({ ok: true, topic: 'launches:noxa' })
    expect(resolveWatchTarget('odyssey')).toEqual({ ok: true, topic: 'launches:odyssey' })
    expect(resolveWatchTarget('grads')).toEqual({ ok: true, topic: 'graduations' })
    expect(resolveWatchTarget('whale')).toEqual({ ok: true, topic: 'whales' })
    expect(resolveWatchTarget('arb')).toEqual({ ok: true, topic: 'premiums' })
    expect(resolveWatchTarget('liquidity')).toEqual({ ok: true, topic: 'rugs' })
  })

  it('resolves a 0x address to a lowercased token topic', () => {
    const addr = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'
    expect(resolveWatchTarget(addr)).toEqual({ ok: true, topic: `token:${addr.toLowerCase()}` })
  })

  it('resolves a known Stock Token ticker, uppercased', () => {
    expect(resolveWatchTarget('tsla')).toEqual({ ok: true, topic: 'stock:TSLA' })
  })

  it('errors on a ticker-shaped string that is not a real Stock Token', () => {
    const result = resolveWatchTarget('NOTREAL')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toMatch(/not a Robinhood Chain Stock Token ticker/)
  })

  it('errors on garbage input', () => {
    const result = resolveWatchTarget('!!! not valid !!!')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toMatch(/Cannot watch/)
  })

  it('trims whitespace before resolving', () => {
    expect(resolveWatchTarget('  launches  ')).toEqual({ ok: true, topic: 'launches' })
  })
})

describe('PREMIUM_TOPICS', () => {
  it('gates exactly premiums and rugs', () => {
    expect(PREMIUM_TOPICS.has('premiums')).toBe(true)
    expect(PREMIUM_TOPICS.has('rugs')).toBe(true)
    expect(PREMIUM_TOPICS.has('whales')).toBe(false)
    expect(PREMIUM_TOPICS.has('launches')).toBe(false)
  })
})

describe('defaultThreshold', () => {
  const defaults = { whaleUsd: 5000, premiumPct: 2, rugPct: 30, pricePct: 2 }

  it('returns the right default per topic kind', () => {
    expect(defaultThreshold({ kind: 'whales' }, defaults)).toBe(5000)
    expect(defaultThreshold({ kind: 'premiums' }, defaults)).toBe(2)
    expect(defaultThreshold({ kind: 'rugs' }, defaults)).toBe(30)
    expect(defaultThreshold({ kind: 'stock', symbol: 'TSLA' }, defaults)).toBe(2)
    expect(defaultThreshold({ kind: 'token', address: '0xabc' as `0x${string}` }, defaults)).toBe(5000)
  })

  it('returns null for topics with no threshold semantics', () => {
    expect(defaultThreshold({ kind: 'launches', launchpad: null }, defaults)).toBeNull()
    expect(defaultThreshold({ kind: 'graduations' }, defaults)).toBeNull()
  })
})

describe('matches', () => {
  const TOKEN = '0x1234567890123456789012345678901234567890' as `0x${string}`
  const OTHER_TOKEN = '0x0000000000000000000000000000000000dead' as `0x${string}`

  function launchEvent(launchpad: 'noxa' | 'odyssey'): AlertEvent {
    return {
      type: 'launch',
      launchpad,
      token: TOKEN,
      symbol: 'X',
      name: null,
      creator: TOKEN,
      pool: null,
      blockNumber: 1n,
      transactionHash: '0x1',
      at: 0,
    }
  }

  it('launches matches any launchpad when unfiltered, and filters when set', () => {
    expect(matches({ kind: 'launches', launchpad: null }, null, launchEvent('noxa'))).toBe(true)
    expect(matches({ kind: 'launches', launchpad: 'noxa' }, null, launchEvent('noxa'))).toBe(true)
    expect(matches({ kind: 'launches', launchpad: 'odyssey' }, null, launchEvent('noxa'))).toBe(false)
  })

  it('graduations matches only graduation events', () => {
    const grad: AlertEvent = { type: 'graduation', token: TOKEN, symbol: null, name: null, pool: TOKEN, blockNumber: 1n, transactionHash: '0x1', at: 0 }
    expect(matches({ kind: 'graduations' }, null, grad)).toBe(true)
    expect(matches({ kind: 'graduations' }, null, launchEvent('noxa'))).toBe(false)
  })

  it('whales matches on type and threshold', () => {
    const whale: AlertEvent = { type: 'whale', source: 'uniswap-v3', token: TOKEN, symbol: null, side: 'buy', usd: 6000, trader: TOKEN, blockNumber: 1n, transactionHash: '0x1', at: 0 }
    expect(matches({ kind: 'whales' }, 5000, whale)).toBe(true)
    expect(matches({ kind: 'whales' }, 7000, whale)).toBe(false)
    expect(matches({ kind: 'whales' }, null, whale)).toBe(true)
    expect(matches({ kind: 'launches', launchpad: null }, null, whale)).toBe(false)
  })

  it('premiums matches on the absolute percent', () => {
    const premium = (pct: number): AlertEvent => ({
      type: 'premium',
      symbol: 'TSLA',
      token: TOKEN,
      premiumPct: pct,
      level: Math.abs(pct),
      direction: pct >= 0 ? 'premium' : 'discount',
      dexUsd: 100,
      feedUsd: 98,
      pool: TOKEN,
      at: 0,
    })
    expect(matches({ kind: 'premiums' }, 2, premium(-3))).toBe(true)
    expect(matches({ kind: 'premiums' }, 2, premium(3))).toBe(true)
    expect(matches({ kind: 'premiums' }, 5, premium(3))).toBe(false)
  })

  it('rugs matches on dropped percent', () => {
    const pull: AlertEvent = { type: 'liquidity_pull', token: TOKEN, symbol: null, pool: TOKEN, quoteAsset: 'USDG', droppedPct: 40, beforeUsd: 100, afterUsd: 60, at: 0 }
    expect(matches({ kind: 'rugs' }, 30, pull)).toBe(true)
    expect(matches({ kind: 'rugs' }, 50, pull)).toBe(false)
  })

  it('token matches by address across event kinds it applies to', () => {
    const whale: AlertEvent = { type: 'whale', source: 'uniswap-v3', token: TOKEN, symbol: null, side: 'buy', usd: 100, trader: TOKEN, blockNumber: 1n, transactionHash: '0x1', at: 0 }
    const otherWhale: AlertEvent = { ...whale, token: OTHER_TOKEN }
    const holders: AlertEvent = { type: 'holders', token: TOKEN, symbol: null, milestone: 100, count: 101, at: 0 }
    const priceMove: AlertEvent = { type: 'price_move', symbol: 'TSLA', pct: 5, fromUsd: 1, toUsd: 1.05, windowS: 900, at: 0 }

    expect(matches({ kind: 'token', address: TOKEN }, 0, whale)).toBe(true)
    expect(matches({ kind: 'token', address: TOKEN }, 0, otherWhale)).toBe(false)
    expect(matches({ kind: 'token', address: TOKEN }, null, holders)).toBe(true)
    expect(matches({ kind: 'token', address: TOKEN }, null, priceMove)).toBe(false)
  })

  it('stock matches by symbol for price_move and premium', () => {
    const priceMove: AlertEvent = { type: 'price_move', symbol: 'TSLA', pct: -3, fromUsd: 100, toUsd: 97, windowS: 900, at: 0 }
    expect(matches({ kind: 'stock', symbol: 'TSLA' }, 2, priceMove)).toBe(true)
    expect(matches({ kind: 'stock', symbol: 'AAPL' }, 2, priceMove)).toBe(false)
    expect(matches({ kind: 'stock', symbol: 'TSLA' }, 5, priceMove)).toBe(false)
  })
})
