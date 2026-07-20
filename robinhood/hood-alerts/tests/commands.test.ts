import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db/index.js'
import { EntitlementRepo } from '../src/db/entitlements.js'
import { SubscriberRepo } from '../src/db/subscribers.js'
import { Commands, FREE_MAX_SUBSCRIPTIONS, type CommandContext } from '../src/commands/commands.js'
import type { Config } from '../src/config.js'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: undefined,
    dbPath: ':memory:',
    port: 8080,
    publicUrl: 'http://localhost:8080',
    telegramToken: null,
    discordToken: null,
    discordAppId: null,
    xMode: undefined,
    xApiKey: null,
    xApiSecret: null,
    xAccessToken: null,
    xAccessSecret: null,
    xactionsUrl: null,
    xactionsToken: null,
    xTopics: [],
    premiumRail: 'hood402',
    payTo: null,
    facilitatorUrl: null,
    settlerKey: null,
    premiumPriceUsdg: '5',
    premiumDays: 30,
    detectors: {
      whaleFloorUsd: 1000,
      whaleDefaultUsd: 5000,
      priceWindowS: 900,
      priceDefaultPct: 2,
      premiumPollS: 60,
      premiumDefaultPct: 2,
      rugDefaultPct: 30,
    },
    ...overrides,
  }
}

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return { platform: 'telegram', chatId: 'chat-1', isGroup: false, isAdmin: false, ...overrides }
}

let db: Db
let subscribers: SubscriberRepo
let entitlements: EntitlementRepo
let notified: number
let commands: Commands

function build(configOverrides: Partial<Config> = {}): Commands {
  return new Commands({
    subscribers,
    entitlements,
    config: makeConfig(configOverrides),
    notifyWatchChange: () => {
      notified += 1
    },
  })
}

beforeEach(() => {
  db = openDb(':memory:')
  subscribers = new SubscriberRepo(db)
  entitlements = new EntitlementRepo(db)
  notified = 0
  commands = build()
})

afterEach(() => {
  db.close()
})

describe('Commands.handle: start/help/unknown', () => {
  it('start greets and points at help', () => {
    expect(commands.handle(ctx(), 'start', []).text).toMatch(/You watch nothing yet/)
  })

  it('help lists every command and the free tier cap', () => {
    const text = commands.handle(ctx(), 'help', []).text
    expect(text).toContain('watch <what>')
    expect(text).toContain(`Free tier: ${FREE_MAX_SUBSCRIPTIONS} subscriptions`)
  })

  it('an unknown command points at help', () => {
    expect(commands.handle(ctx(), 'nonsense', []).text).toBe('Unknown command "nonsense". Try: help')
  })
})

describe('Commands.handle: watch', () => {
  it('prompts with examples when called with no args', () => {
    expect(commands.handle(ctx(), 'watch', []).text).toMatch(/What should I watch/)
  })

  it('subscribes to a fixed topic with its default threshold', () => {
    const reply = commands.handle(ctx(), 'watch', ['whales'])
    expect(reply.text).toBe('Watching whales >= $5,000.')
    const s = subscribers.get('telegram', 'chat-1')
    expect(s).not.toBeNull()
    expect(subscribers.list(s!.id)).toEqual([expect.objectContaining({ topic: 'whales', threshold: 5000 })])
  })

  it('accepts an explicit threshold', () => {
    const reply = commands.handle(ctx(), 'watch', ['whales', '25000'])
    expect(reply.text).toBe('Watching whales >= $25,000.')
  })

  it('applies the "watch launches noxa/odyssey" sugar', () => {
    expect(commands.handle(ctx(), 'watch', ['launches', 'noxa']).text).toBe('Watching launches (noxa).')
    const s = subscribers.get('telegram', 'chat-1')!
    expect(subscribers.list(s.id)[0]?.topic).toBe('launches:noxa')
  })

  it('rejects an unwatchable target with the resolver error', () => {
    const reply = commands.handle(ctx(), 'watch', ['!!!'])
    expect(reply.text).toMatch(/Cannot watch/)
  })

  it('gates premium-only topics for free-tier subscribers', () => {
    const reply = commands.handle(ctx(), 'watch', ['premiums'])
    expect(reply.text).toMatch(/premium detector/)
    expect(reply.text).toMatch(/Stock Token arbitrage signal/)
    const s = subscribers.get('telegram', 'chat-1')
    expect(s).toBeNull() // never got as far as ensure()
  })

  it('allows a premium subscriber to watch a premium-only topic', () => {
    entitlements.activate('telegram', 'chat-1', 86_400)
    const reply = commands.handle(ctx(), 'watch', ['rugs'])
    expect(reply.text).toBe('Watching liquidity pulls >= 30%.')
  })

  it('caps free-tier subscriptions at FREE_MAX_SUBSCRIPTIONS', () => {
    commands.handle(ctx(), 'watch', ['whales'])
    commands.handle(ctx(), 'watch', ['launches'])
    commands.handle(ctx(), 'watch', ['graduations'])
    const reply = commands.handle(ctx(), 'watch', ['TSLA'])
    expect(reply.text).toMatch(/Free tier is capped at 3 subscriptions/)
  })

  it('premium subscribers are not capped', () => {
    entitlements.activate('telegram', 'chat-1', 86_400)
    commands.handle(ctx(), 'watch', ['whales'])
    commands.handle(ctx(), 'watch', ['launches'])
    commands.handle(ctx(), 'watch', ['graduations'])
    const reply = commands.handle(ctx(), 'watch', ['TSLA'])
    expect(reply.text).toBe('Watching TSLA (moves/premium >= 2%).')
  })

  it('watching a token topic notifies the watch-change callback', () => {
    const addr = '0x1234567890123456789012345678901234567890'
    commands.handle(ctx(), 'watch', [addr])
    expect(notified).toBe(1)
  })

  it('watching a non-token topic does not notify', () => {
    commands.handle(ctx(), 'watch', ['whales'])
    expect(notified).toBe(0)
  })

  it('requires admin in a group chat', () => {
    const reply = commands.handle(ctx({ isGroup: true, isAdmin: false }), 'watch', ['whales'])
    expect(reply.text).toBe('Only group admins can change alert settings here.')
  })

  it('allows a group admin', () => {
    const reply = commands.handle(ctx({ isGroup: true, isAdmin: true }), 'watch', ['whales'])
    expect(reply.text).toBe('Watching whales >= $5,000.')
  })
})

describe('Commands.handle: unwatch', () => {
  it('says nothing watched yet if the subscriber has never subscribed', () => {
    expect(commands.handle(ctx(), 'unwatch', ['whales']).text).toMatch(/You watch nothing yet/)
  })

  it('prompts for a target when called with no args and something is watched', () => {
    commands.handle(ctx(), 'watch', ['whales'])
    expect(commands.handle(ctx(), 'unwatch', []).text).toMatch(/Unwatch what\?/)
  })

  it('removes a specific subscription', () => {
    commands.handle(ctx(), 'watch', ['whales'])
    const reply = commands.handle(ctx(), 'unwatch', ['whales'])
    expect(reply.text).toBe('Stopped watching whales >= $0.')
  })

  it('reports when the target was never watched', () => {
    commands.handle(ctx(), 'watch', ['whales'])
    const reply = commands.handle(ctx(), 'unwatch', ['launches'])
    expect(reply.text).toMatch(/You were not watching launches/)
  })

  it('unwatch all removes everything and reports the count', () => {
    commands.handle(ctx(), 'watch', ['whales'])
    commands.handle(ctx(), 'watch', ['launches'])
    const reply = commands.handle(ctx(), 'unwatch', ['all'])
    expect(reply.text).toBe('Removed 2 subscriptions.')
    expect(commands.handle(ctx(), 'list', []).text).toMatch(/You watch nothing yet/)
  })

  it('unwatching a token topic notifies the watch-change callback', () => {
    const addr = '0x1234567890123456789012345678901234567890'
    commands.handle(ctx(), 'watch', [addr])
    notified = 0
    commands.handle(ctx(), 'unwatch', [addr])
    expect(notified).toBe(1)
  })
})

describe('Commands.handle: list', () => {
  it('reports nothing watched for a fresh chat', () => {
    expect(commands.handle(ctx(), 'list', []).text).toMatch(/You watch nothing yet/)
  })

  it('lists subscriptions with tier/digest/quiet settings', () => {
    commands.handle(ctx(), 'watch', ['whales', '5000'])
    const reply = commands.handle(ctx(), 'list', [])
    expect(reply.text).toContain('1. whales >= $5,000')
    expect(reply.text).toContain('tier: free (1/3)')
    expect(reply.text).toContain('digest: off')
    expect(reply.text).toContain('quiet: off')
  })

  it('reflects premium tier and custom digest/quiet settings', () => {
    entitlements.activate('telegram', 'chat-1', 86_400)
    commands.handle(ctx(), 'watch', ['whales'])
    commands.handle(ctx(), 'digest', ['on', '90'])
    commands.handle(ctx(), 'quiet', ['22', '7'])
    const reply = commands.handle(ctx(), 'list', [])
    expect(reply.text).toContain('tier: premium')
    expect(reply.text).toContain('digest: every 90m')
    expect(reply.text).toContain('quiet: 22:00-7:00 UTC')
  })
})

describe('Commands.handle: threshold', () => {
  it('requires two args', () => {
    expect(commands.handle(ctx(), 'threshold', ['whales']).text).toMatch(/Usage: threshold/)
  })

  it('errors when the subscriber has no subscriptions at all', () => {
    expect(commands.handle(ctx(), 'threshold', ['whales', '1']).text).toMatch(/You watch nothing yet/)
  })

  it('errors on a non-positive value', () => {
    commands.handle(ctx(), 'watch', ['whales'])
    expect(commands.handle(ctx(), 'threshold', ['whales', '-5']).text).toBe('"-5" is not a positive number.')
  })

  it('errors when not watching that specific target', () => {
    commands.handle(ctx(), 'watch', ['whales'])
    expect(commands.handle(ctx(), 'threshold', ['launches', '1']).text).toMatch(/You are not watching launches/)
  })

  it('updates an existing subscription threshold', () => {
    commands.handle(ctx(), 'watch', ['whales'])
    const reply = commands.handle(ctx(), 'threshold', ['whales', '99000'])
    expect(reply.text).toBe('Updated: whales >= $99,000.')
  })
})

describe('Commands.handle: digest', () => {
  it('rejects an invalid mode', () => {
    expect(commands.handle(ctx(), 'digest', ['maybe']).text).toMatch(/Usage: digest on/)
  })

  it('turns digest on with a default of 60 minutes', () => {
    expect(commands.handle(ctx(), 'digest', ['on']).text).toBe('Digest on: alerts batch every 60 minutes.')
  })

  it('turns digest on with a custom interval', () => {
    expect(commands.handle(ctx(), 'digest', ['on', '15']).text).toBe('Digest on: alerts batch every 15 minutes.')
  })

  it('rejects an out-of-range interval', () => {
    expect(commands.handle(ctx(), 'digest', ['on', '0']).text).toMatch(/1-1440 minutes/)
    expect(commands.handle(ctx(), 'digest', ['on', '1441']).text).toMatch(/1-1440 minutes/)
  })

  it('turns digest off', () => {
    commands.handle(ctx(), 'digest', ['on'])
    expect(commands.handle(ctx(), 'digest', ['off']).text).toMatch(/Digest off/)
  })
})

describe('Commands.handle: quiet', () => {
  it('sets a quiet window', () => {
    expect(commands.handle(ctx(), 'quiet', ['22', '7']).text).toBe('Quiet hours set: 22:00-7:00 UTC. Alerts batch and deliver after.')
  })

  it('rejects an out-of-range or non-integer hour', () => {
    expect(commands.handle(ctx(), 'quiet', ['24', '7']).text).toMatch(/Usage: quiet/)
    expect(commands.handle(ctx(), 'quiet', ['a', '7']).text).toMatch(/Usage: quiet/)
  })

  it('turns quiet hours off', () => {
    commands.handle(ctx(), 'quiet', ['22', '7'])
    expect(commands.handle(ctx(), 'quiet', ['off']).text).toBe('Quiet hours off.')
  })
})

describe('Commands.handle: premium', () => {
  it('reports free tier and unconfigured purchases by default', () => {
    const reply = commands.handle(ctx(), 'premium', [])
    expect(reply.text).toMatch(/You are on the free tier/)
    expect(reply.text).toMatch(/not configured on this instance/)
  })

  it('reports remaining days when active', () => {
    entitlements.activate('telegram', 'chat-1', 3 * 86_400)
    const reply = commands.handle(ctx(), 'premium', [])
    expect(reply.text).toMatch(/Premium active: 3 days left/)
  })

  it('gives purchase instructions when a facilitator is configured', () => {
    commands = build({ payTo: '0x4022de2D36C334E73C7a108805Cea11C0564f402', facilitatorUrl: 'https://facilitator.example' })
    const reply = commands.handle(ctx(), 'premium', [])
    expect(reply.text).toMatch(/POST http:\/\/localhost:8080\/premium\/activate\?platform=telegram&chat=chat-1/)
    expect(reply.text).toMatch(/5 USDG for 30 days/)
  })

  it('gives purchase instructions when a settler key is configured', () => {
    commands = build({ payTo: '0x4022de2D36C334E73C7a108805Cea11C0564f402', settlerKey: '0xdeadbeef' as `0x${string}` })
    expect(commands.handle(ctx(), 'premium', []).text).toMatch(/POST /)
  })

  it('premium status is readable without admin rights in a group', () => {
    const reply = commands.handle(ctx({ isGroup: true, isAdmin: false }), 'premium', [])
    expect(reply.text).toMatch(/free tier/)
  })
})
