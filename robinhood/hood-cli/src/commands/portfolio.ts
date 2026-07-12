import { Command } from 'commander'
import { formatEther, getAddress, isAddress, type Address } from 'viem'
import { getPortfolio, getUsdgBalance, formatUsdg, type StockPosition } from 'hoodchain'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { printResult } from '../output.js'
import { renderTable, renderKeyValue, type Column } from '../ui/table.js'
import { withSpinner } from '../ui/spinner.js'
import { accent, bold, dim, gray } from '../ui/ansi.js'
import { usd, num, addr } from '../format.js'
import { usageError } from '../errors.js'

export function portfolioCommand(): Command {
  return new Command('portfolio')
    .description('Multiplier-correct Stock Token positions + USD totals for an address')
    .argument('<address>', 'wallet address to inspect')
    .option('--max-age <seconds>', 'max acceptable Chainlink answer age')
    .action((address: string, opts, command) =>
      runWith(command, async (ctx) => {
        await portfolio(ctx, address, opts)
      }),
    )
}

async function portfolio(ctx: Context, address: string, opts: { maxAge?: string }): Promise<void> {
  if (!isAddress(address)) throw usageError(`"${address}" is not a valid address.`)
  const owner = getAddress(address)
  const client = ctx.read()
  const maxAgeSeconds = opts.maxAge ? Number(opts.maxAge) : undefined

  const { port, usdg, eth } = await withSpinner(`Reading ${addr(owner)}…`, async () => {
    const [port, usdg, eth] = await Promise.all([
      getPortfolio(client, owner, maxAgeSeconds ? { maxAgeSeconds } : {}),
      getUsdgBalance(client, owner),
      client.public.getBalance({ address: owner }),
    ])
    return { port, usdg, eth }
  })

  const held = port.positions.filter((p) => p.balance > 0n)
  const usdgFloat = Number(formatUsdg(usdg))
  const grandTotal = port.totalUsd + usdgFloat

  const json = {
    owner,
    network: ctx.network,
    eth: formatEther(eth),
    usdg: formatUsdg(usdg),
    stockValueUsd: port.totalUsd,
    totalUsd: grandTotal,
    unpricedSymbols: port.unpricedSymbols,
    positions: held.map((p) => ({
      symbol: p.symbol,
      address: p.address,
      balance: p.balanceTokens,
      shareEquivalent: p.shareEquivalent,
      priceUsd: p.quote?.priceUsd ?? null,
      valueUsd: p.valueUsd,
    })),
  }

  printResult(json, () => renderPortfolio(owner, held, eth, usdgFloat, port.totalUsd, grandTotal, port.unpricedSymbols, ctx.network), ctx.json)
}

function renderPortfolio(
  owner: Address,
  held: StockPosition[],
  eth: bigint,
  usdg: number,
  stockUsd: number,
  total: number,
  unpriced: string[],
  network: string,
): string {
  const header = `${accent('◈')} ${bold('Portfolio')} ${dim('· ' + addr(owner) + ' · ' + network)}`

  const summary = renderKeyValue(
    [
      ['ETH', num(Number(formatEther(eth)), 6)],
      ['USDG', usd(usdg)],
      ['Stocks', usd(stockUsd)],
      ['Total', bold(usd(total))],
    ],
    { labelWidth: 7 },
  )

  if (held.length === 0) {
    return `${header}\n${summary}\n\n${dim('No Stock Token positions. Fund with `hood swap --sell USDG --buy <ticker>`.')}`
  }

  const sorted = [...held].sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1))
  const columns: Column<StockPosition>[] = [
    { header: 'SYMBOL', priority: 100, cell: (p) => bold(p.symbol) },
    { header: 'BALANCE', align: 'right', priority: 90, cell: (p) => num(p.balanceTokens, 4) },
    { header: 'SHARES', align: 'right', priority: 60, cell: (p) => num(p.shareEquivalent, 4) },
    { header: 'PRICE', align: 'right', priority: 70, cell: (p) => (p.quote ? usd(p.quote.priceUsd) : dim('—')) },
    { header: 'VALUE', align: 'right', priority: 95, cell: (p) => (p.valueUsd !== null ? bold(usd(p.valueUsd)) : dim('unpriced')) },
    { header: 'ADDRESS', priority: 20, cell: (p) => gray(addr(p.address)) },
  ]

  const footNote =
    unpriced.length > 0 ? '\n' + dim(`Unpriced (no fresh feed): ${unpriced.join(', ')}`) : ''
  return `${header}\n${summary}\n\n${renderTable(sorted, columns)}${footNote}`
}
