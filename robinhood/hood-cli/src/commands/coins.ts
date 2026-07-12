import { Command } from 'commander'
import { formatEther, type Address } from 'viem'
import {
  getRecentLaunches,
  erc20Abi,
  ODYSSEY_ADDRESSES,
  odysseyTradedEvent,
  type Launch,
} from 'hoodchain'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { printResult } from '../output.js'
import { renderTable, type Column } from '../ui/table.js'
import { withSpinner } from '../ui/spinner.js'
import { accent, bold, dim, gray, green } from '../ui/ansi.js'
import { addr, num } from '../format.js'
import { usageError } from '../errors.js'
import { pMap } from '../pmap.js'

const ODYSSEY_FACTORIES: Address[] = [
  ODYSSEY_ADDRESSES.bondingCurveFactory,
  ODYSSEY_ADDRESSES.reflectionFactory,
  ODYSSEY_ADDRESSES.instantFactory,
]

interface CoinRow {
  token: string
  symbol: string
  creator: string | null
  pool: string | null
  block: string
  trades: number | null
  volumeEth: number | null
}

export function coinsCommand(): Command {
  return new Command('coins')
    .description('Memecoin screener — newest or trending launches')
    .option('--new', 'newest launches (default)', false)
    .option('--trending', 'rank by bonding-curve trade activity', false)
    .option('--lookback <blocks>', 'blocks to scan', '50000')
    .option('--limit <n>', 'rows to show', '20')
    .option('--names', 'resolve token symbols on-chain', false)
    .action((opts, command) =>
      runWith(command, async (ctx) => {
        await coins(ctx, opts)
      }),
    )
}

interface CoinsOpts {
  new: boolean
  trending: boolean
  lookback: string
  limit: string
  names: boolean
}

async function coins(ctx: Context, opts: CoinsOpts): Promise<void> {
  if (ctx.network !== 'mainnet') throw usageError('The launchpads live on mainnet — run without --network testnet.')
  const client = ctx.read()
  const limit = Math.max(1, Number(opts.limit) || 20)
  const lookback = BigInt(opts.lookback || '50000')
  const trending = opts.trending

  const rows = trending
    ? await withSpinner('Ranking by curve activity…', () => trendingRows(ctx, lookback, limit, opts.names))
    : await withSpinner('Fetching newest launches…', () => newRows(ctx, lookback, limit, opts.names))

  printResult(
    { network: ctx.network, mode: trending ? 'trending' : 'new', count: rows.length, coins: rows },
    () => renderScreener(rows, trending),
    ctx.json,
  )
}

async function newRows(ctx: Context, lookback: bigint, limit: number, names: boolean): Promise<CoinRow[]> {
  const launches = await getRecentLaunches(ctx.read(), { lookbackBlocks: lookback })
  const recent = launches.slice(-limit).reverse()
  return pMap(recent, (l) => launchToRow(ctx, l, names), names ? 8 : 1)
}

async function trendingRows(ctx: Context, lookback: bigint, limit: number, names: boolean): Promise<CoinRow[]> {
  const client = ctx.read()
  const latest = await client.public.getBlockNumber()
  const fromBlock = latest > lookback ? latest - lookback : 0n
  const chunk = 10_000n

  const agg = new Map<string, { trades: number; volume: bigint; lastBlock: bigint }>()
  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n
    const logs = await client.public.getLogs({
      address: ODYSSEY_FACTORIES,
      event: odysseyTradedEvent,
      fromBlock: start,
      toBlock: end,
    })
    for (const log of logs) {
      const token = (log.args.token as Address).toLowerCase()
      const quote = (log.args.quoteAmount as bigint) ?? 0n
      const prev = agg.get(token) ?? { trades: 0, volume: 0n, lastBlock: 0n }
      prev.trades += 1
      prev.volume += quote
      if (log.blockNumber > prev.lastBlock) prev.lastBlock = log.blockNumber
      agg.set(token, prev)
    }
  }

  const ranked = [...agg.entries()]
    .map(([token, v]) => ({ token, ...v }))
    .sort((a, b) => (b.trades !== a.trades ? b.trades - a.trades : b.volume > a.volume ? 1 : -1))
    .slice(0, limit)

  return pMap(
    ranked,
    async (r): Promise<CoinRow> => ({
      token: r.token,
      symbol: names ? await symbolOf(ctx, r.token as Address) : '',
      creator: null,
      pool: null,
      block: r.lastBlock.toString(),
      trades: r.trades,
      volumeEth: Number(formatEther(r.volume)),
    }),
    names ? 8 : 1,
  )
}

async function launchToRow(ctx: Context, l: Launch, names: boolean): Promise<CoinRow> {
  return {
    token: l.token,
    symbol: names ? await symbolOf(ctx, l.token) : '',
    creator: l.creator,
    pool: l.pool,
    block: l.blockNumber.toString(),
    trades: null,
    volumeEth: null,
  }
}

function symbolOf(ctx: Context, token: Address): Promise<string> {
  return ctx
    .read()
    .public.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
    .then((s) => String(s))
    .catch(() => '')
}

function renderScreener(rows: CoinRow[], trending: boolean): string {
  const header = `${accent('◈')} ${bold(trending ? 'Trending coins' : 'New coins')} ${dim('· ' + rows.length)}`
  if (rows.length === 0) {
    return `${header}\n${dim(trending ? 'No curve trades in the scanned window.' : 'No launches in the scanned window — widen --lookback.')}`
  }
  const columns: Column<CoinRow>[] = [
    { header: 'TOKEN', priority: 100, cell: (r) => (r.symbol ? bold(r.symbol) : gray(addr(r.token as Address))) },
    { header: 'ADDRESS', priority: 50, cell: (r) => gray(addr(r.token as Address)) },
  ]
  if (trending) {
    columns.push({ header: 'TRADES', align: 'right', priority: 95, cell: (r) => green(String(r.trades)) })
    columns.push({ header: 'VOL (ETH)', align: 'right', priority: 90, cell: (r) => num(r.volumeEth ?? 0, 4) })
  } else {
    columns.push({ header: 'CREATOR', priority: 40, cell: (r) => (r.creator ? gray(addr(r.creator as Address)) : dim('—')) })
    columns.push({ header: 'POOL', priority: 30, cell: (r) => (r.pool ? gray(addr(r.pool as Address)) : dim('curve')) })
  }
  columns.push({ header: 'BLOCK', align: 'right', priority: 20, cell: (r) => dim('#' + r.block) })
  return `${header}\n${renderTable(rows, columns)}`
}
