import { describe, expect, it } from 'vitest'
import {
  cardToDiscordEmbed,
  cardToText,
  cardToTelegramHtml,
  cardToXDigestPost,
  cardToXPost,
  digestCards,
  short,
  toCard,
  usd,
  X_POST_LIMIT,
} from '../src/format/cards.js'
import type { AlertEvent } from '../src/engine/events.js'

const TOKEN = '0x1234567890123456789012345678901234567890' as `0x${string}`

describe('usd', () => {
  it('formats millions, thousands, and small amounts', () => {
    expect(usd(2_500_000)).toBe('$2.50M')
    expect(usd(5_400)).toBe('$5.4k')
    expect(usd(42.5)).toBe('$42.50')
  })
})

describe('short', () => {
  it('elides the middle of an address', () => {
    expect(short(TOKEN)).toBe('0x1234…7890')
  })
})

describe('toCard', () => {
  it('renders a launch event', () => {
    const e: AlertEvent = { type: 'launch', launchpad: 'noxa', token: TOKEN, symbol: 'FOO', name: 'Foo Coin', creator: TOKEN, pool: TOKEN, blockNumber: 5n, transactionHash: '0xabc', at: 0 }
    const card = toCard(e)
    expect(card.severity).toBe('info')
    expect(card.title).toBe('New launch: FOO')
    expect(card.lines).toContain('Foo Coin')
    expect(card.lines).toContain('Launchpad: NOXA (instant v3 pool)')
    expect(card.lines.some((l) => l.startsWith('Pool:'))).toBe(true)
    expect(card.links.find((l) => l.label === 'Tx')?.url).toContain('0xabc')
  })

  it('renders a launch with no pool as still-curving', () => {
    const e: AlertEvent = { type: 'launch', launchpad: 'odyssey', token: TOKEN, symbol: null, name: null, creator: TOKEN, pool: null, blockNumber: 1n, transactionHash: '0x1', at: 0 }
    const card = toCard(e)
    expect(card.title).toBe(`New launch: ${short(TOKEN)}`)
    expect(card.lines).toContain('Trading on the curve until graduation')
  })

  it('renders a graduation event', () => {
    const e: AlertEvent = { type: 'graduation', token: TOKEN, symbol: 'FOO', name: null, pool: TOKEN, blockNumber: 1n, transactionHash: '0x1', at: 0 }
    const card = toCard(e)
    expect(card.severity).toBe('notice')
    expect(card.title).toBe('Graduated: FOO')
  })

  it('renders a whale event with usd and venue formatting', () => {
    const e: AlertEvent = { type: 'whale', source: 'odyssey-curve', token: TOKEN, symbol: 'FOO', side: 'sell', usd: 12_500, trader: TOKEN, blockNumber: 1n, transactionHash: '0x1', at: 0 }
    const card = toCard(e)
    expect(card.title).toBe('Whale sell: $12.5k of FOO')
    expect(card.lines).toContain('Venue: Odyssey bonding curve')
    expect(card.links.some((l) => l.label === 'Trader')).toBe(true)
  })

  it('renders a price_move event, up and down', () => {
    const up: AlertEvent = { type: 'price_move', symbol: 'TSLA', pct: 3.456, fromUsd: 100, toUsd: 103.456, windowS: 900, at: 0 }
    const down: AlertEvent = { type: 'price_move', symbol: 'TSLA', pct: -3.456, fromUsd: 103.456, toUsd: 100, windowS: 900, at: 0 }
    expect(toCard(up).title).toBe('TSLA up 3.46% in 15m')
    expect(toCard(down).title).toBe('TSLA down 3.46% in 15m')
  })

  it('renders a premium event, premium and discount', () => {
    const premium: AlertEvent = { type: 'premium', symbol: 'TSLA', token: TOKEN, premiumPct: 4.2, level: 4, direction: 'premium', dexUsd: 104.2, feedUsd: 100, pool: TOKEN, at: 0 }
    const discount: AlertEvent = { type: 'premium', symbol: 'TSLA', token: TOKEN, premiumPct: -4.2, level: 4, direction: 'discount', dexUsd: 95.8, feedUsd: 100, pool: TOKEN, at: 0 }
    expect(toCard(premium).title).toBe('TSLA trades at a 4.20% premium on-chain')
    expect(toCard(discount).title).toBe('TSLA trades at a 4.20% discount on-chain')
    expect(toCard(discount).lines[1]).toMatch(/below its oracle price/)
  })

  it('renders a holders event with locale-formatted counts', () => {
    const e: AlertEvent = { type: 'holders', token: TOKEN, symbol: 'FOO', milestone: 10_000, count: 10_042, at: 0 }
    const card = toCard(e)
    expect(card.title).toBe('FOO crossed 10,000 holders')
    expect(card.lines).toEqual(['Now at 10,042 holders.'])
  })

  it('renders a liquidity_pull event, with and without a known token', () => {
    const withToken: AlertEvent = { type: 'liquidity_pull', token: TOKEN, symbol: 'FOO', pool: TOKEN, quoteAsset: 'USDG', droppedPct: 42.3, beforeUsd: 100_000, afterUsd: 57_700, at: 0 }
    const card = toCard(withToken)
    expect(card.severity).toBe('warning')
    expect(card.title).toBe(`Liquidity pull: FOO (${short(TOKEN)})`)
    expect(card.lines[0]).toContain('USDG reserves dropped 42.3%')
    expect(card.links.some((l) => l.label === 'Token')).toBe(true)

    const withoutToken: AlertEvent = { type: 'liquidity_pull', token: null, symbol: null, pool: TOKEN, quoteAsset: 'WETH', droppedPct: 10, beforeUsd: 1, afterUsd: 0.9, at: 0 }
    const card2 = toCard(withoutToken)
    expect(card2.title).toBe(`Liquidity pull: ${short(TOKEN)}`)
    expect(card2.links.some((l) => l.label === 'Token')).toBe(false)
  })
})

describe('cardToText / cardToTelegramHtml / cardToDiscordEmbed', () => {
  const card = toCard({ type: 'graduation', token: TOKEN, symbol: 'FOO', name: null, pool: TOKEN, blockNumber: 1n, transactionHash: '0x1', at: 0 })

  it('cardToText joins title, lines, and labeled links', () => {
    const text = cardToText(card)
    expect(text.startsWith('Graduated: FOO\n')).toBe(true)
    expect(text).toContain('Chart: ')
  })

  it('cardToTelegramHtml bolds the title and escapes HTML', () => {
    const unsafe = toCard({ type: 'holders', token: TOKEN, symbol: '<Foo & Bar>', milestone: 1, count: 1, at: 0 })
    const html = cardToTelegramHtml(unsafe)
    expect(html).toContain('<b>&lt;Foo &amp; Bar&gt; crossed 1 holders</b>')
    expect(html).not.toContain('<Foo & Bar>')
  })

  it('cardToDiscordEmbed maps severity to color and formats markdown links', () => {
    const warning = toCard({ type: 'liquidity_pull', token: null, symbol: null, pool: TOKEN, quoteAsset: 'USDG', droppedPct: 50, beforeUsd: 2, afterUsd: 1, at: 0 })
    const embed = cardToDiscordEmbed(warning)
    expect(embed.color).toBe(0xe5484d)
    expect(embed.footer).toEqual({ text: 'hood-alerts · Robinhood Chain 4663' })
    expect(embed.description).toContain(`[Pool](`)

    const notice = cardToDiscordEmbed(card)
    expect(notice.color).toBe(0x30a46c)
    const info = cardToDiscordEmbed(toCard({ type: 'holders', token: TOKEN, symbol: null, milestone: 1, count: 1, at: 0 }))
    expect(info.color).toBe(0x5b5bd6)
  })
})

describe('cardToXPost', () => {
  it('fits a normal card comfortably under the limit and includes the link', () => {
    const e: AlertEvent = { type: 'graduation', token: TOKEN, symbol: 'FOO', name: null, pool: TOKEN, blockNumber: 1n, transactionHash: '0x1', at: 0 }
    const post = cardToXPost(toCard(e))
    expect(post.length).toBeLessThanOrEqual(X_POST_LIMIT)
    expect(post).toContain('Graduated: FOO')
    expect(post.endsWith(toCard(e).links[0]?.url ?? '')).toBe(true)
  })

  it('truncates long text with an ellipsis but never truncates the URL', () => {
    const e: AlertEvent = {
      type: 'launch',
      launchpad: 'noxa',
      token: TOKEN,
      symbol: 'FOO',
      name: 'A'.repeat(400),
      creator: TOKEN,
      pool: TOKEN,
      blockNumber: 5n,
      transactionHash: '0xabc',
      at: 0,
    }
    const card = toCard(e)
    const post = cardToXPost(card)
    const url = card.links[0]?.url as string
    expect(post.length).toBeLessThanOrEqual(X_POST_LIMIT)
    expect(post).toContain('…')
    expect(post.endsWith(url)).toBe(true)
    expect(post).toContain(url) // the full, un-truncated URL is present verbatim
  })

  it('renders a card with no links (title + line only) under the limit', () => {
    const card = { emojiless: true as const, title: 'Short title', lines: ['one line'], links: [], severity: 'info' as const }
    const post = cardToXPost(card)
    expect(post).toBe('Short title: one line')
    expect(post.length).toBeLessThanOrEqual(X_POST_LIMIT)
  })
})

describe('cardToXDigestPost', () => {
  function launchEvent(i: number): AlertEvent {
    return { type: 'launch', launchpad: 'noxa', token: TOKEN, symbol: `T${i}`, name: null, creator: TOKEN, pool: TOKEN, blockNumber: BigInt(i), transactionHash: '0x1', at: 0 }
  }
  function liquidityPullEvent(): AlertEvent {
    return { type: 'liquidity_pull', token: TOKEN, symbol: 'RUG', pool: TOKEN, quoteAsset: 'USDG', droppedPct: 80, beforeUsd: 100_000, afterUsd: 20_000, at: 0 }
  }

  it('picks the highest-severity event and appends a "+N more" count', () => {
    const events = [launchEvent(1), launchEvent(2), liquidityPullEvent(), launchEvent(3)]
    const post = cardToXDigestPost(events)
    expect(post).toContain('Liquidity pull: RUG')
    expect(post).toContain('(+3 more)')
    expect(post.length).toBeLessThanOrEqual(X_POST_LIMIT)
  })

  it('omits the "+N more" suffix for a single event', () => {
    const post = cardToXDigestPost([launchEvent(1)])
    expect(post).not.toContain('more)')
  })

  it('returns an empty string for an empty batch rather than throwing', () => {
    expect(cardToXDigestPost([])).toBe('')
  })
})

describe('digestCards', () => {
  function holdersEvent(i: number): AlertEvent {
    return { type: 'holders', token: TOKEN, symbol: `T${i}`, milestone: i, count: i, at: 0 }
  }

  it('titles by count and caps rendered cards at 10 with an omitted count', () => {
    const events = Array.from({ length: 13 }, (_, i) => holdersEvent(i))
    const digest = digestCards(events)
    expect(digest.title).toBe('Digest: 13 alerts')
    expect(digest.cards).toHaveLength(10)
    expect(digest.omitted).toBe(3)
  })

  it('uses singular phrasing for exactly one alert and omits nothing under 10', () => {
    const digest = digestCards([holdersEvent(1)])
    expect(digest.title).toBe('Digest: 1 alert')
    expect(digest.omitted).toBe(0)
  })
})
