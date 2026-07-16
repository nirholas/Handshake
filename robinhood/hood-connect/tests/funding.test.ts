import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseLifiQuote, parseRelayQuote } from '../src/index.js'

/**
 * Quote parsers, exercised against REAL API responses captured live on
 * 2026-07-15 (0.002 ETH, Arbitrum One 42161 -> Robinhood Chain 4663). The
 * fixtures are verbatim `li.quest/v1/quote` and `api.relay.link/quote`
 * bodies, not fabricated shapes; `tests/live/funding.live.test.ts` hits the
 * same endpoints for fresh quotes.
 */

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8'))
}

describe('parseLifiQuote', () => {
  const quote = parseLifiQuote(fixture('lifi-quote.json') as Parameters<typeof parseLifiQuote>[0])

  it('routes from Arbitrum to Robinhood Chain', () => {
    expect(quote.provider).toBe('lifi')
    expect(quote.fromChainId).toBe(42161)
    expect(quote.toChainId).toBe(4663)
    expect(quote.tool.length).toBeGreaterThan(0)
  })

  it('extracts an executable transaction', () => {
    expect(quote.tx.chainId).toBe(42161)
    expect(quote.tx.to).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(quote.tx.data).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(quote.tx.value).toBe(2000000000000000n)
    expect(quote.tx.gasLimit).toBeGreaterThan(0n)
  })

  it('reports amounts and ETA', () => {
    expect(quote.fromAmount).toBe(2000000000000000n)
    expect(quote.toAmount).toBeGreaterThan(0n)
    expect(quote.toAmount).toBeLessThanOrEqual(quote.fromAmount)
    expect(Number(quote.toAmountFormatted)).toBeGreaterThan(0)
    expect(quote.toSymbol).toBe('ETH')
    expect(quote.etaSeconds).toBeGreaterThan(0)
  })

  it('native-ETH source needs no approval', () => {
    expect(quote.approval).toBeUndefined()
  })
})

describe('parseRelayQuote', () => {
  const quote = parseRelayQuote(fixture('relay-quote.json') as Parameters<typeof parseRelayQuote>[0])

  it('routes to Robinhood Chain with an executable deposit tx', () => {
    expect(quote.provider).toBe('relay')
    expect(quote.toChainId).toBe(4663)
    expect(quote.tx.chainId).toBe(42161)
    expect(quote.tx.to).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(quote.tx.data).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(quote.tx.value).toBe(2000000000000000n)
  })

  it('reports amounts, symbol, and status handle', () => {
    expect(quote.toAmount).toBeGreaterThan(0n)
    expect(quote.toSymbol).toBe('ETH')
    expect(Number(quote.toAmountFormatted)).toBeCloseTo(Number(quote.toAmount) / 1e18, 6)
    expect(quote.statusRef).toMatch(/^\/intents\/status\?requestId=0x/)
    expect(quote.etaSeconds).toBeGreaterThan(0)
  })
})
