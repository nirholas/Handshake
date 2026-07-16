import {
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
  type TextBasedChannel,
} from 'discord.js'
import { logger } from '../logger.js'
import type { Commands } from '../commands/commands.js'
import type { AlertEvent } from '../engine/events.js'
import { cardToDiscordEmbed, digestCards, toCard } from '../format/cards.js'
import type { Transport } from './types.js'

/**
 * Slash-command definitions, exported so tests can validate the registration
 * JSON offline (discord.js builders throw on invalid definitions at build
 * time, which is the platform's local validation path).
 */
export function buildSlashCommands(): Array<SlashCommandBuilder | SlashCommandOptionsOnlyBuilder> {
  const watch = new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Watch launches, whales, a Stock Token ticker, or a token address')
    .addStringOption((o) =>
      o
        .setName('what')
        .setDescription('launches | graduations | whales | premiums | rugs | TSLA | 0x…')
        .setRequired(true),
    )
    .addNumberOption((o) => o.setName('threshold').setDescription('USD for whales/tokens, percent for premiums/rugs/stocks'))
  const unwatch = new SlashCommandBuilder()
    .setName('unwatch')
    .setDescription('Stop watching something')
    .addStringOption((o) => o.setName('what').setDescription('The watch target, or "all"').setRequired(true))
  const list = new SlashCommandBuilder().setName('list').setDescription('Your subscriptions and settings')
  const threshold = new SlashCommandBuilder()
    .setName('threshold')
    .setDescription('Change a subscription threshold')
    .addStringOption((o) => o.setName('what').setDescription('The watch target').setRequired(true))
    .addNumberOption((o) => o.setName('value').setDescription('New threshold').setRequired(true))
  const digest = new SlashCommandBuilder()
    .setName('digest')
    .setDescription('Batch alerts into periodic digests')
    .addStringOption((o) =>
      o.setName('mode').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    )
    .addIntegerOption((o) => o.setName('minutes').setDescription('Digest interval in minutes (default 60)'))
  const quiet = new SlashCommandBuilder()
    .setName('quiet')
    .setDescription('Quiet hours in UTC (alerts batch and deliver after)')
    .addIntegerOption((o) => o.setName('from').setDescription('Start hour UTC 0-23'))
    .addIntegerOption((o) => o.setName('to').setDescription('End hour UTC 0-23'))
    .addStringOption((o) => o.setName('mode').setDescription('"off" to disable').addChoices({ name: 'off', value: 'off' }))
  const premium = new SlashCommandBuilder().setName('premium').setDescription('Premium status and upgrade')
  const help = new SlashCommandBuilder().setName('help').setDescription('Full command reference')
  return [watch, unwatch, list, threshold, digest, quiet, premium, help]
}

/** Map a Discord interaction onto the shared (command, args) shape. */
export function interactionToCommand(i: ChatInputCommandInteraction): { command: string; args: string[] } {
  const name = i.commandName
  const args: string[] = []
  if (name === 'watch') {
    args.push(i.options.getString('what', true))
    const t = i.options.getNumber('threshold')
    if (t !== null) args.push(String(t))
  } else if (name === 'unwatch') {
    args.push(i.options.getString('what', true))
  } else if (name === 'threshold') {
    args.push(i.options.getString('what', true), String(i.options.getNumber('value', true)))
  } else if (name === 'digest') {
    args.push(i.options.getString('mode', true))
    const m = i.options.getInteger('minutes')
    if (m !== null) args.push(String(m))
  } else if (name === 'quiet') {
    const mode = i.options.getString('mode')
    if (mode === 'off') args.push('off')
    else {
      const from = i.options.getInteger('from')
      const to = i.options.getInteger('to')
      if (from !== null) args.push(String(from))
      if (to !== null) args.push(String(to))
    }
  }
  return { command: name, args }
}

export class DiscordTransport implements Transport {
  readonly platform = 'discord' as const
  private readonly client: Client
  private readonly rest: REST

  constructor(
    private readonly token: string,
    private readonly appId: string,
    commands: Commands,
  ) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] })
    this.rest = new REST({ version: '10' }).setToken(token)

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return
      try {
        const { command, args } = interactionToCommand(interaction)
        const isAdmin =
          interaction.inGuild() === false ||
          interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true
        const reply = commands.handle(
          {
            platform: 'discord',
            chatId: interaction.channelId,
            ...(interaction.guild ? { chatTitle: interaction.guild.name } : {}),
            isGroup: interaction.inGuild(),
            isAdmin,
          },
          command,
          args,
        )
        await interaction.reply({ content: reply.text, ephemeral: command === 'premium' })
      } catch (error) {
        logger.error({ err: String(error) }, 'discord interaction failed')
        if (interaction.isRepliable() && !interaction.replied) {
          await interaction.reply({ content: 'Something went wrong handling that command. Try again.', ephemeral: true }).catch(() => undefined)
        }
      }
    })
    this.client.on('error', (error) => logger.error({ err: String(error) }, 'discord client error'))
  }

  private async channel(chatId: string): Promise<TextBasedChannel> {
    const ch = await this.client.channels.fetch(chatId)
    if (!ch || !ch.isTextBased() || !('send' in ch)) throw new Error(`channel ${chatId} is not sendable`)
    return ch
  }

  async sendAlert(chatId: string, event: AlertEvent): Promise<void> {
    const ch = await this.channel(chatId)
    if ('send' in ch) await ch.send({ embeds: [cardToDiscordEmbed(toCard(event))] })
  }

  async sendDigest(chatId: string, events: AlertEvent[]): Promise<void> {
    const digest = digestCards(events)
    const ch = await this.channel(chatId)
    const embeds = digest.cards.slice(0, 10).map(cardToDiscordEmbed)
    const content = digest.omitted > 0 ? `${digest.title} (${digest.omitted} omitted)` : digest.title
    if ('send' in ch) await ch.send({ content, embeds })
  }

  async start(): Promise<void> {
    const body = buildSlashCommands().map((c) => c.toJSON())
    await this.rest.put(Routes.applicationCommands(this.appId), { body })
    await this.client.login(this.token)
    logger.info({ appId: this.appId }, 'discord bot online')
  }

  async stop(): Promise<void> {
    await this.client.destroy()
  }
}
