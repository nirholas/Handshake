import { Command } from 'commander'
import { listStockTokens, listPricedStockTokens, type StockToken } from 'hoodchain'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { getOracleQuote, getDexPriceUsd } from '../prices.js'
import { printResult } from '../output.js'
import { renderTable, type Column } from '../ui/table.js'
import { withSpinner } from '../ui/spinner.js'
import { accent, bold, dim, gray, truncate } from '../ui/ansi.js'
import { usd, pct, age, addr, num } from '../format.js'
import { usageError } from '../errors.js'
import { pMap } from '../pmap.js'

type SortKey = 'symbol' | 'price' | 'premium'

interface StockRow {
  symbol: string
  name: string
  address: string
  oracleUsd: number | null
  ageSeconds: number | null
  dexUsd: number | null
  premium: number | null
}

export function stocksCommand(): Command {
  return new Command('stocks')
    .description('The full Stock Token board with live Chainlink prices')
    .option('--sort <key>', 'sort by symbol | price | premium (premium implies --dex)', 'symbol')
    .option('--dex', 'also probe Uniswap for DEX price + premium (slower)', false)
    .option('--priced', 'only tokens with a live Chainlink feed', false)
    .option('--limit <n>', 'show at most n rows')
    .action((opts, command) =>
      runWith(command, async (ctx) => {
        await stocks(ctx, opts)
      }),
    )
}

interface StocksOpts {
  sort: string
  dex: boolean
  priced: boolean
  limit?: string
}

async function stocks(ctx: Context, opts: StocksOpts): Promise<void> {
  const sort = opts.sort as SortKey
  if (!['symbol', 'price', 'premium'].includes(sort)) {
    throw usageError(`--sort must be one of: symbol, price, premium (got "${opts.sort}").`)
  }
  const withDex = opts.dex || sort === 'premium'
  const client = ctx.read()
  const tokens: StockToken[] = opts.priced || sort === 'premium' ? listPricedStockTokens() : listStockTokens()

  const rows = await withSpinner(
    withDex ? `Pricing ${tokens.length} tokens (oracle + DEX)…` : `Pricing ${tokens.length} tokens…`,
    () =>
      pMap(
        tokens,
        async (t): Promise<StockRow> => {
          const oracle = t.feed ? await getOracleQuote(client, t.symbol) : null
          const dexUsd = withDex ? await getDexPriceUsd(client, t.address, t.decimals) : null
          const premium = oracle && dexUsd ? (dexUsd - oracle.priceUsd) / oracle.priceUsd : null
          return {
            symbol: t.symbol,
            name: t.name.replace(/\s*•\s*Robinhood Token$/, ''),
            address: t.address,
            oracleUsd: oracle?.priceUsd ?? null,
            ageSeconds: oracle?.ageSeconds ?? null,
            dexUsd,
            premium,
          }
        },
        withDex ? 6 : 16,
      ),
  )

  sortRows(rows, sort)
  const limited = opts.limit ? rows.slice(0, Math.max(0, Number(opts.limit))) : rows

  printResult(
    { network: ctx.network, count: limited.length, tokens: limited },
    () => renderBoard(limited, withDex, ctx.network),
    ctx.json,
  )
}

function sortRows(rows: StockRow[], sort: SortKey): void {
  if (sort === 'symbol') rows.sort((a, b) => a.symbol.localeCompare(b.symbol))
  else if (sort === 'price') rows.sort((a, b) => (b.oracleUsd ?? -1) - (a.oracleUsd ?? -1))
  else rows.sort((a, b) => (b.premium ?? -Infinity) - (a.premium ?? -Infinity))
}

function renderBoard(rows: StockRow[], withDex: boolean, network: string): string {
  const columns: Column<StockRow>[] = [
    { header: 'SYMBOL', cell: (r) => bold(r.symbol), priority: 100 },
    { header: 'PRICE', align: 'right', priority: 90, cell: (r) => (r.oracleUsd !== null ? usd(r.oracleUsd) : dim('—')) },
    { header: 'AGE', align: 'right', priority: 40, cell: (r) => (r.ageSeconds !== null ? dim(age(r.ageSeconds)) : dim('—')) },
    { header: 'NAME', priority: 20, cell: (r) => dim(truncate(r.name, 24)) },
  ]
  if (withDex) {
    columns.splice(2, 0, { header: 'DEX', align: 'right', priority: 70, cell: (r) => (r.dexUsd !== null ? usd(r.dexUsd) : dim('—')) })
    columns.splice(3, 0, { header: 'PREMIUM', align: 'right', priority: 80, cell: (r) => (r.premium !== null ? pct(r.premium) : dim('—')) })
  }
  columns.push({ header: 'ADDRESS', priority: 10, cell: (r) => gray(addr(r.address as `0x${string}`)) })

  const priced = rows.filter((r) => r.oracleUsd !== null).length
  const header = `${accent('◈')} ${bold('Stock Tokens')} ${dim(`· ${network} · ${rows.length} shown · ${priced} priced`)}`
  return `${header}\n${renderTable(rows, columns)}`
}
