import { Command } from 'commander'
import { formatUnits, parseUnits } from 'viem'
import { quoteSwap, buildSwapTx, ensureApproval, StockTokenEligibilityError } from 'hoodchain'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { resolveToken } from '../resolve.js'
import { printResult } from '../output.js'
import { renderKeyValue } from '../ui/table.js'
import { withSpinner } from '../ui/spinner.js'
import { confirm } from '../prompt.js'
import { accent, bold, dim, gray, green, yellow } from '../ui/ansi.js'
import { num, addr } from '../format.js'
import { txUrl } from '../blockscout.js'
import { guardError, usageError } from '../errors.js'
import { checkSpendCap } from '../spend-cap.js'
import { getDexPriceUsd } from '../prices.js'
import { warn } from '../output.js'

export function swapCommand(): Command {
  return new Command('swap')
    .description('Quote (default) or execute a Uniswap v3 swap between two tokens')
    .requiredOption('--sell <token>', 'ticker or address to sell (e.g. USDG)')
    .requiredOption('--buy <token>', 'ticker or address to buy')
    .requiredOption('--amount <amount>', 'amount of --sell to spend, in whole tokens')
    .option('--slippage <bps>', 'slippage tolerance in basis points', '50')
    .option('--execute', 'sign and send (default: quote only)', false)
    .action((opts, command) =>
      runWith(command, async (ctx) => {
        await swap(ctx, opts)
      }),
    )
}

interface SwapOpts {
  sell: string
  buy: string
  amount: string
  slippage: string
  execute: boolean
}

async function swap(ctx: Context, opts: SwapOpts): Promise<void> {
  const slippageBps = Number(opts.slippage)
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 5000) {
    throw usageError('--slippage must be a basis-point value between 0 and 5000 (50%).')
  }

  const client = opts.execute ? await ctx.wallet() : ctx.read()
  const [tokenIn, tokenOut] = await Promise.all([resolveToken(client, opts.sell), resolveToken(client, opts.buy)])
  const amountIn = parseUnits(opts.amount, tokenIn.decimals)
  if (amountIn <= 0n) throw usageError('--amount must be greater than zero.')

  const quote = await withSpinner(`Quoting ${tokenIn.symbol} → ${tokenOut.symbol}…`, () =>
    quoteSwap(client, { tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn }),
  )

  const amountOut = formatUnits(quote.amountOut, tokenOut.decimals)
  const minOut = formatUnits((quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n, tokenOut.decimals)
  const rate = Number(amountOut) / Number(opts.amount)

  const summary = {
    network: ctx.network,
    sell: { symbol: tokenIn.symbol, amount: opts.amount },
    buy: { symbol: tokenOut.symbol, amount: amountOut, minimum: minOut },
    rate,
    hops: quote.route.fees.length,
    slippageBps,
  }

  if (!opts.execute) {
    printResult(summary, () => renderQuote(summary, false), ctx.json)
    return
  }

  // maxSpendUsd guard rail: estimate what's being sold in USD (USDG is 1:1;
  // anything else prices off its own DEX quote) and refuse over the cap.
  const estimatedUsd = await estimateSpendUsd(client, tokenIn.symbol, tokenIn.address, tokenIn.decimals, Number(opts.amount))
  if (ctx.config.maxSpendUsd !== undefined && estimatedUsd === null) {
    warn(`Could not verify this swap against your $${ctx.config.maxSpendUsd} spend cap (no price route for ${tokenIn.symbol}) — proceeding.`)
  }
  checkSpendCap({ maxSpendUsd: ctx.config.maxSpendUsd, estimatedUsd })

  // Write path: money-moving action — render the confirmation table and stop
  // for explicit yes/no before signing, per CLAUDE.md's irreversible-action gate.
  if (!ctx.json) process.stdout.write(renderQuote(summary, true) + '\n\n')
  if (!ctx.assumeYes) {
    const ok = await confirm(`Swap ${opts.amount} ${tokenIn.symbol} for ~${num(Number(amountOut), 6)} ${tokenOut.symbol}?`)
    if (!ok) throw guardError('Swap cancelled.')
  }

  try {
    const approvalHash = await withSpinner(`Checking ${tokenIn.symbol} allowance…`, () =>
      ensureApproval(client, tokenIn.address, amountIn),
    )
    if (approvalHash && !ctx.json) process.stderr.write(dim(`Approved router: ${txUrl(ctx.network, approvalHash)}\n`))

    const tx = buildSwapTx(client, quote, { slippageBps })
    const hash = await withSpinner('Sending swap…', () =>
      client.wallet!.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, account: client.account!, chain: client.chain }),
    )
    const receipt = await withSpinner('Confirming…', () => client.public.waitForTransactionReceipt({ hash }))

    const result = { ...summary, hash, status: receipt.status, explorer: txUrl(ctx.network, hash) }
    printResult(result, () => renderResult(result), ctx.json)
    if (receipt.status !== 'success') process.exitCode = 1
  } catch (err) {
    if (err instanceof StockTokenEligibilityError) {
      throw guardError(
        'Stock Token acquisition is gated for non-affirmed operators.',
        'Re-run with --acknowledge-eligibility if you are eligible (not a US/CA/UK/CH person).',
      )
    }
    throw err
  }
}

async function estimateSpendUsd(
  client: Parameters<typeof getDexPriceUsd>[0],
  symbol: string,
  address: `0x${string}`,
  decimals: number,
  amount: number,
): Promise<number | null> {
  if (symbol === 'USDG') return amount
  const perToken = await getDexPriceUsd(client, address, decimals)
  return perToken !== null ? perToken * amount : null
}

function renderQuote(
  s: { network: string; sell: { symbol: string; amount: string }; buy: { symbol: string; amount: string; minimum: string }; rate: number; hops: number; slippageBps: number },
  confirming: boolean,
): string {
  const header = confirming
    ? `${yellow('⚠')}  ${bold('Confirm swap')} ${dim('· ' + s.network)}`
    : `${accent('◈')} ${bold('Swap quote')} ${dim('· ' + s.network + ' · add --execute to send')}`
  const pairs: [string, string][] = [
    ['Sell', bold(s.sell.amount) + ' ' + s.sell.symbol],
    ['Buy', bold(`~${s.buy.amount}`) + ' ' + s.buy.symbol],
    ['Min. received', dim(s.buy.minimum + ' ' + s.buy.symbol + ` (${(s.slippageBps / 100).toFixed(2)}% slippage)`)],
    ['Rate', `1 ${s.sell.symbol} ≈ ${num(s.rate, 6)} ${s.buy.symbol}`],
    ['Route', dim(s.hops === 1 ? 'direct pool' : `${s.hops}-hop route`)],
  ]
  return `${header}\n${renderKeyValue(pairs, { labelWidth: 14 })}`
}

function renderResult(r: { hash: string; status: string; explorer: string; buy: { symbol: string; amount: string } }): string {
  const badge = r.status === 'success' ? green('✓ swap confirmed') : dim('✗ reverted')
  return `${badge}\n${renderKeyValue(
    [
      ['Received', bold(`~${r.buy.amount}`) + ' ' + r.buy.symbol],
      ['Tx', gray(addr(r.hash as `0x${string}`))],
      ['Explorer', gray(r.explorer)],
    ],
    { labelWidth: 9 },
  )}`
}
