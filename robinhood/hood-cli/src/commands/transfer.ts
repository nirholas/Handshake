import { Command } from 'commander'
import { formatEther, formatUnits, getAddress, isAddress, parseEther, parseUnits } from 'viem'
import { erc20Abi } from 'hoodchain'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { resolveToken } from '../resolve.js'
import { printResult } from '../output.js'
import { renderKeyValue } from '../ui/table.js'
import { withSpinner } from '../ui/spinner.js'
import { confirm } from '../prompt.js'
import { bold, dim, gray, green, yellow } from '../ui/ansi.js'
import { addr } from '../format.js'
import { txUrl } from '../blockscout.js'
import { guardError, usageError } from '../errors.js'
import { checkSpendCap } from '../spend-cap.js'
import { getDexPriceUsd } from '../prices.js'
import { MAINNET_ADDRESSES, TESTNET_ADDRESSES } from 'hoodchain'
import { warn } from '../output.js'

export function transferCommand(): Command {
  return new Command('transfer')
    .description('Send ETH or an ERC-20 token to an address')
    .requiredOption('--to <address>', 'recipient address')
    .requiredOption('--amount <amount>', 'amount to send, in whole tokens')
    .option('--token <token>', 'ticker or address to send (default: native ETH)')
    .action((opts, command) =>
      runWith(command, async (ctx) => {
        await transfer(ctx, opts)
      }),
    )
}

interface TransferOpts {
  to: string
  amount: string
  token?: string
}

async function transfer(ctx: Context, opts: TransferOpts): Promise<void> {
  if (!isAddress(opts.to)) throw usageError(`"${opts.to}" is not a valid recipient address.`)
  const to = getAddress(opts.to)
  const client = await ctx.wallet()

  const isNative = !opts.token
  const symbol = isNative ? 'ETH' : (await resolveToken(client, opts.token as string)).symbol
  const tokenInfo = isNative ? null : await resolveToken(client, opts.token as string)
  const amount = isNative ? parseEther(opts.amount) : parseUnits(opts.amount, tokenInfo!.decimals)
  if (amount <= 0n) throw usageError('--amount must be greater than zero.')

  const balance = isNative
    ? await client.public.getBalance({ address: client.account!.address })
    : await client.public.readContract({ address: tokenInfo!.address, abi: erc20Abi, functionName: 'balanceOf', args: [client.account!.address] })
  if (balance < amount) {
    throw guardError(
      `Insufficient balance: hold ${formatBalance(balance, isNative, tokenInfo?.decimals)} ${symbol}, need ${opts.amount}.`,
    )
  }

  // maxSpendUsd guard rail: USDG is 1:1, native ETH/other tokens price off
  // their own DEX quote against USDG.
  const spendToken = isNative ? (ctx.network === 'testnet' ? TESTNET_ADDRESSES.weth : MAINNET_ADDRESSES.weth) : tokenInfo!.address
  const estimatedUsd = await estimateSpendUsd(client, symbol, spendToken, isNative ? 18 : tokenInfo!.decimals, Number(opts.amount))
  if (ctx.config.maxSpendUsd !== undefined && estimatedUsd === null) {
    warn(`Could not verify this transfer against your $${ctx.config.maxSpendUsd} spend cap (no price route for ${symbol}) — proceeding.`)
  }
  checkSpendCap({ maxSpendUsd: ctx.config.maxSpendUsd, estimatedUsd })

  if (!ctx.json) {
    process.stdout.write(
      renderConfirm({ to, amount: opts.amount, symbol, network: ctx.network }) + '\n\n',
    )
  }
  if (!ctx.assumeYes) {
    const ok = await confirm(`Send ${opts.amount} ${symbol} to ${addr(to)}?`)
    if (!ok) throw guardError('Transfer cancelled.')
  }

  const hash = await withSpinner('Sending…', () =>
    isNative
      ? client.wallet!.sendTransaction({ to, value: amount, account: client.account!, chain: client.chain })
      : client.wallet!.writeContract({ address: tokenInfo!.address, abi: erc20Abi, functionName: 'transfer', args: [to, amount], account: client.account!, chain: client.chain }),
  )
  const receipt = await withSpinner('Confirming…', () => client.public.waitForTransactionReceipt({ hash }))

  const result = { to, amount: opts.amount, symbol, hash, status: receipt.status, explorer: txUrl(ctx.network, hash) }
  printResult(result, () => renderResult(result), ctx.json)
  if (receipt.status !== 'success') process.exitCode = 1
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

function formatBalance(balance: bigint, isNative: boolean, decimals?: number): string {
  return isNative ? formatEther(balance) : formatUnits(balance, decimals ?? 18)
}

function renderConfirm(s: { to: string; amount: string; symbol: string; network: string }): string {
  const header = `${yellow('⚠')}  ${bold('Confirm transfer')} ${dim('· ' + s.network)}`
  const pairs: [string, string][] = [
    ['Amount', bold(s.amount) + ' ' + s.symbol],
    ['To', gray(s.to)],
  ]
  return `${header}\n${renderKeyValue(pairs, { labelWidth: 7 })}`
}

function renderResult(r: { to: string; amount: string; symbol: string; hash: string; status: string; explorer: string }): string {
  const badge = r.status === 'success' ? green('✓ transfer confirmed') : dim('✗ reverted')
  return `${badge}\n${renderKeyValue(
    [
      ['Sent', bold(r.amount) + ' ' + r.symbol + ' → ' + addr(r.to as `0x${string}`)],
      ['Tx', gray(addr(r.hash as `0x${string}`))],
      ['Explorer', gray(r.explorer)],
    ],
    { labelWidth: 9 },
  )}`
}
