import { Command } from 'commander'
import { getStockToken } from 'hoodchain'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { getPriceRow, type PriceRow } from '../prices.js'
import { resolveToken } from '../resolve.js'
import { printResult } from '../output.js'
import { renderKeyValue } from '../ui/table.js'
import { liveRegion } from '../ui/live.js'
import { withSpinner } from '../ui/spinner.js'
import { accent, bold, dim, gray } from '../ui/ansi.js'
import { usd, pct, age, addr } from '../format.js'
import { EXIT } from '../errors.js'

export function priceCommand(): Command {
  return new Command('price')
    .description('Chainlink oracle price + DEX price + premium for a Stock Token')
    .argument('<symbol>', 'ticker (AAPL) or token address')
    .option('--watch', 'live-updating view (repaints in place)', false)
    .option('--interval <ms>', 'refresh interval for --watch', '4000')
    .option('--max-age <seconds>', 'max acceptable Chainlink answer age')
    .option('--no-dex', 'skip the Uniswap price probe (oracle only)')
    .action((symbol: string, opts, command) =>
      runWith(command, async (ctx) => {
        await price(ctx, symbol, opts)
      }),
    )
}

interface PriceOpts {
  watch: boolean
  interval: string
  maxAge?: string
  dex: boolean
}

async function price(ctx: Context, symbol: string, opts: PriceOpts): Promise<void> {
  const client = ctx.read()
  const token = await resolveToken(client, symbol)
  const maxAgeSeconds = opts.maxAge ? Number(opts.maxAge) : undefined

  const fetchRow = () =>
    getPriceRow(client, token.symbol, token.address, {
      maxAgeSeconds,
      withDex: opts.dex,
      decimals: token.decimals,
    })

  if (!opts.watch) {
    const row = await withSpinner(`Pricing ${token.symbol}…`, () => fetchRow())
    printResult(row, () => renderPrice(row, token.symbol, ctx.network), ctx.json)
    if (row.oracleUsd === null && row.dexUsd === null) process.exitCode = EXIT.NOT_FOUND
    return
  }

  // --watch: repaint in place. JSON mode streams one object per tick.
  const interval = Math.max(1000, Number(opts.interval) || 4000)
  const region = liveRegion()
  const tick = async () => {
    try {
      const row = await fetchRow()
      if (ctx.json) process.stdout.write(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n')
      else region.render(renderPrice(row, token.symbol, ctx.network, true))
    } catch {
      /* transient RPC hiccup — keep the last frame, retry next tick */
    }
  }
  await tick()
  const timer = setInterval(tick, interval)
  const shutdown = () => {
    clearInterval(timer)
    region.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise(() => {}) // run until interrupted
}

function renderPrice(row: PriceRow, symbol: string, network: string, watch = false): string {
  const pairs: [string, string][] = []
  pairs.push(['Oracle', row.oracleUsd !== null ? bold(usd(row.oracleUsd)) : dim('no fresh feed')])
  if (row.oracleAgeSeconds !== null) pairs.push(['Updated', dim(age(row.oracleAgeSeconds) + ' ago')])
  pairs.push(['DEX', row.dexUsd !== null ? usd(row.dexUsd) : dim('no pool')])
  pairs.push(['Premium', row.premium !== null ? pct(row.premium) : dim('—')])
  pairs.push(['Token', gray(addr(row.address))])

  const header = `${accent('◈')} ${bold(symbol)} ${dim('· Robinhood Chain ' + network)}`
  const foot = watch ? '\n' + dim('  ⟳ live · Ctrl-C to stop') : ''
  return `${header}\n${renderKeyValue(pairs, { labelWidth: 8 })}${foot}`
}
