import { MAINNET_EXPLORER_URL } from 'hoodchain'
import type { AlertEvent } from '../engine/events.js'

/** A platform-neutral alert card; each transport renders it natively. */
export interface AlertCard {
  emojiless: true
  title: string
  lines: string[]
  links: Array<{ label: string; url: string }>
  severity: 'info' | 'notice' | 'warning'
}

const MARKETS = 'https://three.ws/markets/robinhood'

export function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function tokenLabel(symbol: string | null, token: string): string {
  return symbol ? `${symbol} (${short(token)})` : short(token)
}

function coinLinks(token: string, tx?: string): AlertCard['links'] {
  const links = [
    { label: 'Chart', url: `${MARKETS}/coin/${token}` },
    { label: 'Token', url: `${MAINNET_EXPLORER_URL}/token/${token}` },
  ]
  if (tx) links.push({ label: 'Tx', url: `${MAINNET_EXPLORER_URL}/tx/${tx}` })
  return links
}

/** Render any engine event into a card. */
export function toCard(e: AlertEvent): AlertCard {
  switch (e.type) {
    case 'launch': {
      const pad = e.launchpad === 'noxa' ? 'NOXA (instant v3 pool)' : 'The Odyssey (bonding curve)'
      return {
        emojiless: true,
        severity: 'info',
        title: `New launch: ${e.symbol ?? short(e.token)}`,
        lines: [
          ...(e.name ? [e.name] : []),
          `Launchpad: ${pad}`,
          `Creator: ${short(e.creator)}`,
          ...(e.pool ? [`Pool: ${short(e.pool)}`] : ['Trading on the curve until graduation']),
          `Block ${e.blockNumber}`,
        ],
        links: coinLinks(e.token, e.transactionHash),
      }
    }
    case 'graduation':
      return {
        emojiless: true,
        severity: 'notice',
        title: `Graduated: ${e.symbol ?? short(e.token)}`,
        lines: [
          ...(e.name ? [e.name] : []),
          'Odyssey curve filled; liquidity migrated to a locked Uniswap v3 pool.',
          `Pool: ${short(e.pool)}`,
        ],
        links: coinLinks(e.token, e.transactionHash),
      }
    case 'whale':
      return {
        emojiless: true,
        severity: 'notice',
        title: `Whale ${e.side}: ${usd(e.usd)} of ${e.symbol ?? short(e.token)}`,
        lines: [
          `Venue: ${e.source === 'odyssey-curve' ? 'Odyssey bonding curve' : 'Uniswap v3'}`,
          `Trader: ${short(e.trader)}`,
          `Block ${e.blockNumber}`,
        ],
        links: [
          ...coinLinks(e.token, e.transactionHash),
          { label: 'Trader', url: `${MAINNET_EXPLORER_URL}/address/${e.trader}` },
        ],
      }
    case 'price_move': {
      const dir = e.pct >= 0 ? 'up' : 'down'
      return {
        emojiless: true,
        severity: 'info',
        title: `${e.symbol} ${dir} ${Math.abs(e.pct).toFixed(2)}% in ${Math.round(e.windowS / 60)}m`,
        lines: [`$${e.fromUsd.toFixed(2)} -> $${e.toUsd.toFixed(2)} (Chainlink, 24/5 feed)`],
        links: [{ label: 'Chart', url: `${MARKETS}/stock/${e.symbol}` }],
      }
    }
    case 'premium': {
      const word = e.direction === 'premium' ? 'premium' : 'discount'
      return {
        emojiless: true,
        severity: 'notice',
        title: `${e.symbol} trades at a ${Math.abs(e.premiumPct).toFixed(2)}% ${word} on-chain`,
        lines: [
          `DEX mid: $${e.dexUsd.toFixed(2)} vs Chainlink: $${e.feedUsd.toFixed(2)}`,
          e.direction === 'premium'
            ? 'On-chain buyers are paying above the oracle price.'
            : 'The token trades below its oracle price on-chain.',
          `Pool: ${short(e.pool)}`,
        ],
        links: [
          { label: 'Chart', url: `${MARKETS}/stock/${e.symbol}` },
          { label: 'Pool', url: `${MAINNET_EXPLORER_URL}/address/${e.pool}` },
        ],
      }
    }
    case 'holders':
      return {
        emojiless: true,
        severity: 'info',
        title: `${e.symbol ?? short(e.token)} crossed ${e.milestone.toLocaleString('en-US')} holders`,
        lines: [`Now at ${e.count.toLocaleString('en-US')} holders.`],
        links: coinLinks(e.token),
      }
    case 'liquidity_pull':
      return {
        emojiless: true,
        severity: 'warning',
        title: `Liquidity pull: ${tokenLabel(e.symbol, e.token ?? e.pool)}`,
        lines: [
          `${e.quoteAsset} reserves dropped ${e.droppedPct.toFixed(1)}% (${usd(e.beforeUsd)} -> ${usd(e.afterUsd)}).`,
          'This is an early rug warning, not proof; check the pool before acting.',
        ],
        links: [
          { label: 'Pool', url: `${MAINNET_EXPLORER_URL}/address/${e.pool}` },
          ...(e.token ? coinLinks(e.token) : []),
        ],
      }
  }
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Telegram HTML rendering of a card. */
export function cardToTelegramHtml(card: AlertCard): string {
  const links = card.links.map((l) => `<a href="${l.url}">${escapeHtml(l.label)}</a>`).join(' · ')
  return [`<b>${escapeHtml(card.title)}</b>`, ...card.lines.map(escapeHtml), links].join('\n')
}

/** Plain-text rendering (console transport + logs). */
export function cardToText(card: AlertCard): string {
  return [card.title, ...card.lines, ...card.links.map((l) => `${l.label}: ${l.url}`)].join('\n')
}

/** Discord embed data for a card (matches discord.js APIEmbed). */
export function cardToDiscordEmbed(card: AlertCard): {
  title: string
  description: string
  color: number
  footer: { text: string }
} {
  const color = card.severity === 'warning' ? 0xe5484d : card.severity === 'notice' ? 0x30a46c : 0x5b5bd6
  const links = card.links.map((l) => `[${l.label}](${l.url})`).join(' · ')
  return {
    title: card.title,
    description: [...card.lines, '', links].join('\n'),
    color,
    footer: { text: 'hood-alerts · Robinhood Chain 4663' },
  }
}

/** A compact digest rendering: one block per event, capped. */
export function digestCards(events: AlertEvent[]): { title: string; cards: AlertCard[]; omitted: number } {
  const cards = events.slice(0, 10).map(toCard)
  return {
    title: `Digest: ${events.length} alert${events.length === 1 ? '' : 's'}`,
    cards,
    omitted: Math.max(0, events.length - 10),
  }
}
