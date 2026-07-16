import { Bot, type Context } from 'grammy'
import { logger } from '../logger.js'
import type { Commands } from '../commands/commands.js'
import type { AlertEvent } from '../engine/events.js'
import { cardToTelegramHtml, digestCards, toCard } from '../format/cards.js'
import type { Transport } from './types.js'

const COMMANDS = ['start', 'help', 'watch', 'unwatch', 'list', 'threshold', 'digest', 'quiet', 'premium'] as const

const COMMAND_DESCRIPTIONS: Record<(typeof COMMANDS)[number], string> = {
  start: 'What this bot does',
  help: 'Full command reference',
  watch: 'Watch launches, whales, a ticker, or a token address',
  unwatch: 'Stop watching something (or all)',
  list: 'Your subscriptions and settings',
  threshold: 'Change a subscription threshold',
  digest: 'Batch alerts into digests: digest on 60',
  quiet: 'Quiet hours in UTC: quiet 22 7',
  premium: 'Premium status and upgrade',
}

/**
 * Telegram transport (grammY, long polling). Group chats restrict config
 * commands to admins; alerts render as HTML cards with preview disabled.
 *
 * `buildTelegramBot` is separated from the transport so tests can exercise the
 * full update-handling path offline via `bot.handleUpdate()` with an api
 * transformer capturing outgoing calls (grammY's documented testing pattern).
 */
export function buildTelegramBot(token: string, commands: Commands): Bot {
  const bot = new Bot(token)

  const isAdmin = async (ctx: Context): Promise<boolean> => {
    if (ctx.chat?.type === 'private') return true
    if (!ctx.chat || !ctx.from) return false
    try {
      const member = await ctx.getChatMember(ctx.from.id)
      return member.status === 'administrator' || member.status === 'creator'
    } catch {
      return false
    }
  }

  for (const command of COMMANDS) {
    bot.command(command, async (ctx) => {
      const args = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean)
      const reply = commands.handle(
        {
          platform: 'telegram',
          chatId: String(ctx.chat.id),
          ...(ctx.chat.type === 'private'
            ? ctx.from?.username
              ? { chatTitle: ctx.from.username }
              : {}
            : { chatTitle: ctx.chat.title }),
          isGroup: ctx.chat.type !== 'private',
          isAdmin: await isAdmin(ctx),
        },
        command,
        args,
      )
      await ctx.reply(reply.text, { link_preview_options: { is_disabled: true } })
    })
  }

  // Unknown slash commands get help, not silence.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    if (!text.startsWith('/')) return
    const name = text.slice(1).split(/[\s@]/)[0] ?? ''
    if ((COMMANDS as readonly string[]).includes(name)) return
    await ctx.reply(`Unknown command /${name}. Try /help`)
  })

  bot.catch((err) => logger.error({ err: String(err.error) }, 'telegram update error'))
  return bot
}

export class TelegramTransport implements Transport {
  readonly platform = 'telegram' as const
  private readonly bot: Bot

  constructor(token: string, commands: Commands) {
    this.bot = buildTelegramBot(token, commands)
  }

  async sendAlert(chatId: string, event: AlertEvent): Promise<void> {
    await this.bot.api.sendMessage(chatId, cardToTelegramHtml(toCard(event)), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
  }

  async sendDigest(chatId: string, events: AlertEvent[]): Promise<void> {
    const digest = digestCards(events)
    const blocks = digest.cards.map(cardToTelegramHtml)
    const omitted = digest.omitted > 0 ? `\n\n…and ${digest.omitted} more.` : ''
    await this.bot.api.sendMessage(chatId, `<b>${digest.title}</b>\n\n${blocks.join('\n\n')}${omitted}`, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
  }

  async start(): Promise<void> {
    await this.bot.api.setMyCommands(
      COMMANDS.map((c) => ({ command: c, description: COMMAND_DESCRIPTIONS[c] })),
    )
    // Long polling in the background; runner errors restart via bot.start's internals.
    void this.bot.start({
      onStart: (me) => logger.info({ username: me.username }, 'telegram bot online'),
    })
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }
}
