/**
 * 12 — Telegram price bot: /price AAPL, /trending.
 *
 * A deployable-on-the-free-tier grammY bot backed by hoodchain. `/price` reads
 * one Stock Token's Chainlink feed; `/trending` scans recent NOXA + Odyssey
 * launches and lists the newest tokens. Long-polling — no webhook, no server,
 * runs anywhere Node runs (Railway/Fly/Render free tiers, or your laptop).
 *
 * Run: TELEGRAM_BOT_TOKEN=... node index.js
 */
import { Bot } from 'grammy'
import { createHoodClient, getQuote, getRecentLaunches, listStockTokens } from 'hoodchain'

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error('✗ TELEGRAM_BOT_TOKEN is not set.')
  console.error('  Create a bot with @BotFather on Telegram, then:')
  console.error('  TELEGRAM_BOT_TOKEN=123456:ABC-... node index.js')
  process.exit(1)
}

const hood = createHoodClient()
const bot = new Bot(token)

bot.command('start', (ctx) =>
  ctx.reply(
    'Robinhood Chain price bot.\n\n' +
      '/price AAPL — Chainlink price for a Stock Token\n' +
      '/trending — newest NOXA / Odyssey launches',
  ),
)

bot.command('price', async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase()
  if (!symbol) return ctx.reply('usage: /price AAPL')
  try {
    const q = await getQuote(hood, symbol, { maxAgeSeconds: 7 * 24 * 3600 })
    const ageH = (q.ageSeconds / 3600).toFixed(1)
    await ctx.reply(`${q.symbol}  $${q.priceUsd.toFixed(2)}  (updated ${ageH}h ago)`)
  } catch (err) {
    await ctx.reply(`Couldn't price ${symbol}: ${err.message}`)
  }
})

bot.command('trending', async (ctx) => {
  await ctx.reply('Scanning recent launches…')
  const launches = await getRecentLaunches(hood, { lookbackBlocks: 200_000n, chunkSize: 50_000n })
  if (launches.length === 0) return ctx.reply('No launches in the recent window.')
  const lines = launches
    .slice(-8)
    .reverse()
    .map((l) => `${l.launchpad}  ${l.token.slice(0, 10)}…  block ${l.blockNumber}`)
  await ctx.reply(`Newest launches (of ${launches.length} scanned):\n\n${lines.join('\n')}`)
})

bot.catch((err) => console.error('bot error:', err.message))

console.log(`Registry loaded: ${listStockTokens().length} Stock Tokens.`)
console.log('Starting long-polling…')
bot.start({ onStart: (me) => console.log(`✓ @${me.username} is live.`) })
