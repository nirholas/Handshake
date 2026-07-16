import type { Config } from '../config.js'
import type { EntitlementRepo } from '../db/entitlements.js'
import type { Platform, SubscriberRepo } from '../db/subscribers.js'
import { defaultThreshold, parseTopic, PREMIUM_TOPICS, resolveWatchTarget } from '../engine/topics.js'

/** Free tier allows this many concurrent subscriptions. */
export const FREE_MAX_SUBSCRIPTIONS = 3

/** Who is issuing the command, resolved by the transport. */
export interface CommandContext {
  platform: Platform
  chatId: string
  chatTitle?: string
  /** Group chats restrict config commands to admins. */
  isGroup: boolean
  isAdmin: boolean
}

/** Platform-neutral reply; transports handle their own markup/escaping. */
export interface CommandReply {
  text: string
}

export interface CommandDeps {
  subscribers: SubscriberRepo
  entitlements: EntitlementRepo
  config: Config
  /** Called after any change to token: watches (detector lifecycle sync). */
  notifyWatchChange: () => void
}

const HELP = `hood-alerts: real-time Robinhood Chain alerts.

watch <what> [threshold]
  launches            every new token (add noxa/odyssey to filter)
  graduations         Odyssey curves migrating to Uniswap v3
  whales [usd]        trades >= usd, chain-wide (default 5000)
  premiums [pct]      Stock Token DEX premium/discount vs Chainlink (premium tier)
  rugs [pct]          liquidity-pull rug warnings (premium tier)
  <TICKER>            a Stock Token: price moves + premium crossings (e.g. TSLA)
  <0x address>        a memecoin: whale trades, graduation, holders, liquidity

unwatch <what|all>    stop watching
list                  your subscriptions
threshold <what> <n>  change a subscription's threshold
digest on|off [min]   batch alerts into digests (default 60 min)
quiet <from> <to>     quiet hours in UTC (e.g. quiet 22 7); quiet off
premium               premium status + how to upgrade
help                  this message

Free tier: ${FREE_MAX_SUBSCRIPTIONS} subscriptions, alerts batched to 60s.
Premium: unlimited, real-time, plus the premiums + rugs detectors.`

function requireAdmin(ctx: CommandContext): CommandReply | null {
  if (ctx.isGroup && !ctx.isAdmin) {
    return { text: 'Only group admins can change alert settings here.' }
  }
  return null
}

function describeTopic(topic: string, threshold: number | null): string {
  const parsed = parseTopic(topic)
  if (!parsed) return topic
  switch (parsed.kind) {
    case 'launches':
      return parsed.launchpad ? `launches (${parsed.launchpad})` : 'launches (all launchpads)'
    case 'graduations':
      return 'graduations'
    case 'whales':
      return `whales >= $${(threshold ?? 0).toLocaleString('en-US')}`
    case 'premiums':
      return `stock premium/discount >= ${threshold ?? 0}%`
    case 'rugs':
      return `liquidity pulls >= ${threshold ?? 0}%`
    case 'token':
      return `token ${parsed.address.slice(0, 6)}…${parsed.address.slice(-4)} (whales >= $${(threshold ?? 0).toLocaleString('en-US')}, graduation, holders, liquidity)`
    case 'stock':
      return `${parsed.symbol} (moves/premium >= ${threshold ?? 0}%)`
  }
}

/**
 * The shared command router. Both bots parse their native command format into
 * (command, args) and call this; replies render per platform. Keeping it pure
 * and platform-free is what makes the whole UX unit-testable offline.
 */
export class Commands {
  constructor(private readonly deps: CommandDeps) {}

  handle(ctx: CommandContext, command: string, args: string[]): CommandReply {
    switch (command) {
      case 'start':
        return {
          text:
            'This bot alerts on Robinhood Chain activity: launches, graduations, whale trades, ' +
            'Stock Token price moves, on-chain premium/discount arbitrage, holder milestones, and ' +
            'liquidity pulls.\n\nYou watch nothing yet. Try: watch launches\nFull reference: help',
        }
      case 'help':
        return { text: HELP }
      case 'watch':
        return requireAdmin(ctx) ?? this.watch(ctx, args)
      case 'unwatch':
        return requireAdmin(ctx) ?? this.unwatch(ctx, args)
      case 'list':
        return this.list(ctx)
      case 'threshold':
        return requireAdmin(ctx) ?? this.threshold(ctx, args)
      case 'digest':
        return requireAdmin(ctx) ?? this.digest(ctx, args)
      case 'quiet':
        return requireAdmin(ctx) ?? this.quiet(ctx, args)
      case 'premium':
        return this.premium(ctx)
      default:
        return { text: `Unknown command "${command}". Try: help` }
    }
  }

  private watch(ctx: CommandContext, args: string[]): CommandReply {
    if (args.length === 0) {
      return { text: 'What should I watch? Examples:\nwatch launches\nwatch whales 10000\nwatch TSLA\nwatch 0x… (a token address)\nSee: help' }
    }
    const first = args[0] as string
    const second = args[1]
    // "watch launches noxa" sugar
    const target = (first.toLowerCase() === 'launches' && (second === 'noxa' || second === 'odyssey'))
      ? `launches:${second}`
      : first
    const resolved = resolveWatchTarget(target)
    if (!resolved.ok) return { text: resolved.error }
    const topic = resolved.topic
    const parsed = parseTopic(topic)
    if (!parsed) return { text: `Cannot watch "${first}".` }

    const premium = this.deps.entitlements.isPremium(ctx.platform, ctx.chatId)
    if (PREMIUM_TOPICS.has(topic) && !premium) {
      return {
        text:
          `"${topic}" is a premium detector (the ${topic === 'premiums' ? 'Stock Token arbitrage signal' : 'rug early-warning'}). ` +
          'Upgrade with: premium',
      }
    }
    const subscriber = this.deps.subscribers.ensure(ctx.platform, ctx.chatId, ctx.chatTitle)
    if (!premium && this.deps.subscribers.count(subscriber.id) >= FREE_MAX_SUBSCRIPTIONS) {
      return {
        text:
          `Free tier is capped at ${FREE_MAX_SUBSCRIPTIONS} subscriptions. ` +
          'Unwatch something (unwatch <what>) or go unlimited with: premium',
      }
    }

    const d = this.deps.config.detectors
    const thresholdArg = Number(target === first ? second : args[2])
    const threshold = Number.isFinite(thresholdArg) && thresholdArg > 0
      ? thresholdArg
      : defaultThreshold(parsed, {
          whaleUsd: d.whaleDefaultUsd,
          premiumPct: d.premiumDefaultPct,
          rugPct: d.rugDefaultPct,
          pricePct: d.priceDefaultPct,
        })
    this.deps.subscribers.subscribe(subscriber.id, topic, threshold)
    if (parsed.kind === 'token') this.deps.notifyWatchChange()
    return { text: `Watching ${describeTopic(topic, threshold)}.` }
  }

  private unwatch(ctx: CommandContext, args: string[]): CommandReply {
    const subscriber = this.deps.subscribers.get(ctx.platform, ctx.chatId)
    if (!subscriber || this.deps.subscribers.count(subscriber.id) === 0) {
      return { text: 'You watch nothing yet. Try: watch launches' }
    }
    if (args.length === 0) return { text: 'Unwatch what? Use: unwatch <what> or unwatch all (see list)' }
    if ((args[0] as string).toLowerCase() === 'all') {
      const n = this.deps.subscribers.unsubscribeAll(subscriber.id)
      this.deps.notifyWatchChange()
      return { text: `Removed ${n} subscription${n === 1 ? '' : 's'}.` }
    }
    const resolved = resolveWatchTarget(args[0] as string)
    if (!resolved.ok) return { text: resolved.error }
    const removed = this.deps.subscribers.unsubscribe(subscriber.id, resolved.topic)
    if (!removed) return { text: `You were not watching ${args[0]}. See: list` }
    if (parseTopic(resolved.topic)?.kind === 'token') this.deps.notifyWatchChange()
    return { text: `Stopped watching ${describeTopic(resolved.topic, null)}.` }
  }

  private list(ctx: CommandContext): CommandReply {
    const subscriber = this.deps.subscribers.get(ctx.platform, ctx.chatId)
    const subs = subscriber ? this.deps.subscribers.list(subscriber.id) : []
    if (subs.length === 0) {
      return { text: 'You watch nothing yet. Try: watch launches\nOr: watch whales 10000, watch TSLA' }
    }
    const premium = this.deps.entitlements.isPremium(ctx.platform, ctx.chatId)
    const lines = subs.map((s, i) => `${i + 1}. ${describeTopic(s.topic, s.threshold)}`)
    const s = subscriber as NonNullable<typeof subscriber>
    const settings = [
      premium ? 'tier: premium' : `tier: free (${subs.length}/${FREE_MAX_SUBSCRIPTIONS})`,
      s.digest ? `digest: every ${Math.round(s.digestIntervalS / 60)}m` : 'digest: off',
      s.quietStart !== null && s.quietEnd !== null ? `quiet: ${s.quietStart}:00-${s.quietEnd}:00 UTC` : 'quiet: off',
    ]
    return { text: `Watching:\n${lines.join('\n')}\n\n${settings.join(' · ')}` }
  }

  private threshold(ctx: CommandContext, args: string[]): CommandReply {
    if (args.length < 2) return { text: 'Usage: threshold <what> <value>. Example: threshold whales 25000' }
    const subscriber = this.deps.subscribers.get(ctx.platform, ctx.chatId)
    if (!subscriber) return { text: 'You watch nothing yet. Try: watch launches' }
    const resolved = resolveWatchTarget(args[0] as string)
    if (!resolved.ok) return { text: resolved.error }
    const value = Number(args[1])
    if (!Number.isFinite(value) || value <= 0) return { text: `"${args[1]}" is not a positive number.` }
    const ok = this.deps.subscribers.setThreshold(subscriber.id, resolved.topic, value)
    if (!ok) return { text: `You are not watching ${args[0]}. Watch it first: watch ${args[0]} ${value}` }
    return { text: `Updated: ${describeTopic(resolved.topic, value)}.` }
  }

  private digest(ctx: CommandContext, args: string[]): CommandReply {
    const mode = (args[0] ?? '').toLowerCase()
    if (mode !== 'on' && mode !== 'off') return { text: 'Usage: digest on [minutes] or digest off' }
    const subscriber = this.deps.subscribers.ensure(ctx.platform, ctx.chatId, ctx.chatTitle)
    if (mode === 'off') {
      this.deps.subscribers.setDigest(subscriber.id, false)
      return { text: 'Digest off: alerts deliver as they happen (60s batching on the free tier).' }
    }
    const minutes = Number(args[1] ?? 60)
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
      return { text: 'Digest interval must be 1-1440 minutes.' }
    }
    this.deps.subscribers.setDigest(subscriber.id, true, Math.round(minutes) * 60)
    return { text: `Digest on: alerts batch every ${Math.round(minutes)} minutes.` }
  }

  private quiet(ctx: CommandContext, args: string[]): CommandReply {
    const subscriber = this.deps.subscribers.ensure(ctx.platform, ctx.chatId, ctx.chatTitle)
    if ((args[0] ?? '').toLowerCase() === 'off') {
      this.deps.subscribers.setQuietHours(subscriber.id, null, null)
      return { text: 'Quiet hours off.' }
    }
    const start = Number(args[0])
    const end = Number(args[1])
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 0 || end > 23) {
      return { text: 'Usage: quiet <from> <to> in UTC hours 0-23 (e.g. quiet 22 7), or quiet off' }
    }
    this.deps.subscribers.setQuietHours(subscriber.id, start, end)
    return { text: `Quiet hours set: ${start}:00-${end}:00 UTC. Alerts batch and deliver after.` }
  }

  private premium(ctx: CommandContext): CommandReply {
    const { config } = this.deps
    const remaining = this.deps.entitlements.remainingS(ctx.platform, ctx.chatId)
    const status =
      remaining > 0
        ? `Premium active: ${Math.ceil(remaining / 86_400)} day${remaining > 86_400 ? 's' : ''} left.`
        : 'You are on the free tier.'
    const purchasable = config.payTo !== null && (config.facilitatorUrl !== null || config.settlerKey !== null)
    if (!purchasable) {
      return {
        text:
          `${status}\n\nPremium purchases are not configured on this instance. ` +
          'Self-hosters: set HOOD402_PAY_TO plus a facilitator or settler key (see the self-host guide).',
      }
    }
    const url = `${config.publicUrl}/premium/activate?platform=${ctx.platform}&chat=${encodeURIComponent(ctx.chatId)}`
    return {
      text:
        `${status}\n\nPremium: unlimited subscriptions, real-time delivery, plus the Stock Token ` +
        `arbitrage (premiums) and rug early-warning (rugs) detectors.\n` +
        `Price: ${config.premiumPriceUsdg} USDG for ${config.premiumDays} days, paid on Robinhood Chain via x402.\n\n` +
        `Pay with any x402 client (hood402, x402-fetch):\nPOST ${url}\n` +
        `The endpoint answers 402 with payment instructions; your client signs a USDG ` +
        `transferWithAuthorization and premium activates the moment it settles.\n` +
        `Guide: https://nirholas.github.io/hood-alerts/premium.html`,
    }
  }
}
