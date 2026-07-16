import { isStockTokenSymbol } from 'hoodchain'
import type { AlertEvent } from './events.js'

/**
 * Subscription topics:
 *
 * - `launches` / `launches:noxa` / `launches:odyssey` — new token launches
 * - `graduations` — Odyssey curves migrating to Uniswap v3
 * - `whales` — trades >= threshold USD, chain-wide (threshold = USD)
 * - `premiums` — Stock Token DEX premium/discount vs Chainlink (threshold = %, premium tier)
 * - `rugs` — liquidity pulls (threshold = % of quote reserves, premium tier)
 * - `token:0x…` — per-token: whales, graduation, holders, liquidity pulls
 * - `stock:SYMBOL` — per-stock: price moves + premium/discount crossings
 */
export type ParsedTopic =
  | { kind: 'launches'; launchpad: 'noxa' | 'odyssey' | null }
  | { kind: 'graduations' }
  | { kind: 'whales' }
  | { kind: 'premiums' }
  | { kind: 'rugs' }
  | { kind: 'token'; address: `0x${string}` }
  | { kind: 'stock'; symbol: string }

/** Topics only premium subscribers may watch. */
export const PREMIUM_TOPICS = new Set(['premiums', 'rugs'])

/** Parse a stored topic string. Returns null for unknown/corrupt topics. */
export function parseTopic(topic: string): ParsedTopic | null {
  if (topic === 'launches') return { kind: 'launches', launchpad: null }
  if (topic === 'launches:noxa') return { kind: 'launches', launchpad: 'noxa' }
  if (topic === 'launches:odyssey') return { kind: 'launches', launchpad: 'odyssey' }
  if (topic === 'graduations') return { kind: 'graduations' }
  if (topic === 'whales') return { kind: 'whales' }
  if (topic === 'premiums') return { kind: 'premiums' }
  if (topic === 'rugs') return { kind: 'rugs' }
  if (topic.startsWith('token:')) {
    const address = topic.slice(6)
    if (/^0x[0-9a-f]{40}$/.test(address)) return { kind: 'token', address: address as `0x${string}` }
    return null
  }
  if (topic.startsWith('stock:')) {
    const symbol = topic.slice(6)
    if (/^[A-Z0-9.]{1,12}$/.test(symbol)) return { kind: 'stock', symbol }
    return null
  }
  return null
}

/**
 * Resolve a user-typed watch target into a canonical topic string.
 * Accepts: launches[:pad], graduations, whales, premiums, rugs, a 0x address,
 * or a Stock Token ticker.
 */
export type ResolvedTarget = { ok: true; topic: string } | { ok: false; error: string }

export function resolveWatchTarget(input: string): ResolvedTarget {
  const raw = input.trim()
  const lower = raw.toLowerCase()
  if (['launches', 'launch'].includes(lower)) return { ok: true, topic: 'launches' }
  if (lower === 'launches:noxa' || lower === 'noxa') return { ok: true, topic: 'launches:noxa' }
  if (lower === 'launches:odyssey' || lower === 'odyssey') return { ok: true, topic: 'launches:odyssey' }
  if (['graduations', 'graduation', 'grads'].includes(lower)) return { ok: true, topic: 'graduations' }
  if (['whales', 'whale'].includes(lower)) return { ok: true, topic: 'whales' }
  if (['premiums', 'premium', 'arb', 'arbs'].includes(lower)) return { ok: true, topic: 'premiums' }
  if (['rugs', 'rug', 'liquidity'].includes(lower)) return { ok: true, topic: 'rugs' }
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return { ok: true, topic: `token:${raw.toLowerCase()}` }
  const symbol = raw.toUpperCase()
  if (/^[A-Z0-9.]{1,12}$/.test(symbol)) {
    if (isStockTokenSymbol(symbol)) return { ok: true, topic: `stock:${symbol}` }
    return {
      ok: false,
      error:
        `"${symbol}" is not a Robinhood Chain Stock Token ticker. ` +
        'To watch a memecoin, use its contract address (0x…).',
    }
  }
  return { ok: false, error: `Cannot watch "${raw}". Try launches, graduations, whales, premiums, rugs, a ticker, or a 0x address.` }
}

/** Default threshold for a topic (null = no threshold semantics). */
export function defaultThreshold(
  topic: ParsedTopic,
  defaults: { whaleUsd: number; premiumPct: number; rugPct: number; pricePct: number },
): number | null {
  switch (topic.kind) {
    case 'whales':
      return defaults.whaleUsd
    case 'premiums':
      return defaults.premiumPct
    case 'rugs':
      return defaults.rugPct
    case 'stock':
      return defaults.pricePct
    case 'token':
      return defaults.whaleUsd
    default:
      return null
  }
}

/**
 * Does `event` match a subscription on `topic` with `threshold`?
 * Threshold semantics: whales/token = min USD; premiums/stock = min percent;
 * rugs = min dropped percent.
 */
export function matches(topic: ParsedTopic, threshold: number | null, event: AlertEvent): boolean {
  switch (topic.kind) {
    case 'launches':
      return event.type === 'launch' && (topic.launchpad === null || event.launchpad === topic.launchpad)
    case 'graduations':
      return event.type === 'graduation'
    case 'whales':
      return event.type === 'whale' && event.usd >= (threshold ?? 0)
    case 'premiums':
      return event.type === 'premium' && Math.abs(event.premiumPct) >= (threshold ?? 0)
    case 'rugs':
      return event.type === 'liquidity_pull' && event.droppedPct >= (threshold ?? 0)
    case 'token': {
      const addr = topic.address
      if (event.type === 'whale') return event.token.toLowerCase() === addr && event.usd >= (threshold ?? 0)
      if (event.type === 'graduation') return event.token.toLowerCase() === addr
      if (event.type === 'holders') return event.token.toLowerCase() === addr
      if (event.type === 'liquidity_pull') return event.token?.toLowerCase() === addr
      return false
    }
    case 'stock': {
      if (event.type === 'price_move') return event.symbol === topic.symbol && Math.abs(event.pct) >= (threshold ?? 0)
      if (event.type === 'premium') return event.symbol === topic.symbol && Math.abs(event.premiumPct) >= (threshold ?? 0)
      return false
    }
  }
}
