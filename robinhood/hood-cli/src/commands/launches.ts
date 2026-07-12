import { Command } from 'commander'
import { getRecentLaunches, watchLaunches, erc20Abi, type Launch, type LaunchpadName } from 'hoodchain'
import type { Address } from 'viem'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { printResult } from '../output.js'
import { renderTable, type Column } from '../ui/table.js'
import { withSpinner } from '../ui/spinner.js'
import { liveRegion } from '../ui/live.js'
import { accent, bold, dim, gray, green } from '../ui/ansi.js'
import { addr } from '../format.js'
import { usageError } from '../errors.js'
import { pMap } from '../pmap.js'

interface LaunchRow {
  launchpad: LaunchpadName
  token: string
  symbol: string
  creator: string
  pool: string | null
  block: string
  tx: string
}

export function launchesCommand(): Command {
  return new Command('launches')
    .description('Recent memecoin launches from NOXA and The Odyssey')
    .option('--follow', 'stream new launches live', false)
    .option('--launchpad <name>', 'noxa | odyssey (default: both)')
    .option('--lookback <blocks>', 'blocks to scan for the snapshot', '30000')
    .option('--limit <n>', 'max rows in the snapshot', '25')
    .option('--names', 'resolve each token symbol on-chain', false)
    .action((opts, command) =>
      runWith(command, async (ctx) => {
        await launches(ctx, opts)
      }),
    )
}

interface LaunchesOpts {
  follow: boolean
  launchpad?: string
  lookback: string
  limit: string
  names: boolean
}

function validLaunchpad(v?: string): LaunchpadName | undefined {
  if (!v) return undefined
  if (v !== 'noxa' && v !== 'odyssey') throw usageError('--launchpad must be "noxa" or "odyssey".')
  return v
}

async function launches(ctx: Context, opts: LaunchesOpts): Promise<void> {
  const client = ctx.read()
  const launchpad = validLaunchpad(opts.launchpad)

  if (opts.follow) {
    if (ctx.network !== 'mainnet') throw usageError('Launch watching runs on mainnet (the launchpads are mainnet-only).')
    await follow(ctx, launchpad, opts.names)
    return
  }

  const raw = await withSpinner('Scanning launchpad logs…', () =>
    getRecentLaunches(client, { lookbackBlocks: BigInt(opts.lookback || '30000'), launchpad }),
  )
  const recent = raw.slice(-Math.max(1, Number(opts.limit) || 25)).reverse()
  const rows = await withSpinner('Building feed…', () =>
    pMap(recent, (l) => toRow(ctx, l, opts.names), opts.names ? 8 : 1),
  )

  printResult(
    { network: ctx.network, count: rows.length, launches: rows },
    () => renderFeed(rows, ctx.network),
    ctx.json,
  )
}

async function toRow(ctx: Context, l: Launch, resolveNames: boolean): Promise<LaunchRow> {
  let symbol = ''
  if (resolveNames) {
    symbol = await ctx
      .read()
      .public.readContract({ address: l.token, abi: erc20Abi, functionName: 'symbol' })
      .then((s) => String(s))
      .catch(() => '')
  }
  return {
    launchpad: l.launchpad,
    token: l.token,
    symbol,
    creator: l.creator,
    pool: l.pool,
    block: l.blockNumber.toString(),
    tx: l.transactionHash,
  }
}

async function follow(ctx: Context, launchpad: LaunchpadName | undefined, resolveNames: boolean): Promise<void> {
  const client = ctx.read()
  process.stderr.write(dim(`Watching ${launchpad ?? 'NOXA + Odyssey'} for new launches — Ctrl-C to stop\n`))
  const unwatch = watchLaunches(
    client,
    (l) => {
      void toRow(ctx, l, resolveNames).then((r) => {
        if (ctx.json) {
          process.stdout.write(JSON.stringify(r) + '\n')
        } else {
          const name = r.symbol ? bold(r.symbol) + ' ' : ''
          process.stdout.write(
            `${green('▲')} ${dim(r.launchpad.padEnd(7))} ${name}${gray(addr(r.token as Address))} ${dim('by')} ${gray(addr(r.creator as Address))} ${dim('#' + r.block)}\n`,
          )
        }
      })
    },
    { launchpad, onError: (e) => process.stderr.write(dim(`(watch retry: ${e.message})\n`)) },
  )
  const shutdown = () => {
    unwatch()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise(() => {})
}

function renderFeed(rows: LaunchRow[], network: string): string {
  const header = `${accent('◈')} ${bold('Launches')} ${dim(`· ${network} · ${rows.length}`)}`
  if (rows.length === 0) {
    return `${header}\n${dim('No launches in the scanned window. Widen it with --lookback, or --follow to stream new ones.')}`
  }
  const columns: Column<LaunchRow>[] = [
    { header: 'BLOCK', align: 'right', priority: 90, cell: (r) => dim('#' + r.block) },
    { header: 'PAD', priority: 100, cell: (r) => (r.launchpad === 'noxa' ? accent('NOXA') : bold('Odyssey')) },
    { header: 'TOKEN', priority: 95, cell: (r) => (r.symbol ? bold(r.symbol) : gray(addr(r.token as Address))) },
    { header: 'ADDRESS', priority: 50, cell: (r) => gray(addr(r.token as Address)) },
    { header: 'CREATOR', priority: 40, cell: (r) => gray(addr(r.creator as Address)) },
    { header: 'POOL', priority: 30, cell: (r) => (r.pool ? gray(addr(r.pool as Address)) : dim('curve')) },
  ]
  return `${header}\n${renderTable(rows, columns)}`
}
