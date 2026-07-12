import { Command } from 'commander'
import { decodeEventLog, formatEther, formatGwei, isHash, type Address, type Hash } from 'viem'
import { erc20Abi, getStockTokenByAddress } from 'hoodchain'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { printResult } from '../output.js'
import { renderKeyValue } from '../ui/table.js'
import { withSpinner } from '../ui/spinner.js'
import { accent, bold, dim, gray, green, red } from '../ui/ansi.js'
import { addr, num, tokenAmount, timestamp } from '../format.js'
import { fetchTx, txUrl } from '../blockscout.js'
import { notFoundError, usageError } from '../errors.js'
import { pMap } from '../pmap.js'

interface TransferLine {
  token: Address
  symbol: string | null
  from: Address
  to: Address
  value: string
}

export function txCommand(): Command {
  return new Command('tx')
    .description('Decode a transaction: status, transfers, gas, method')
    .argument('<hash>', 'transaction hash')
    .action((hash: string, _opts, command) =>
      runWith(command, async (ctx) => {
        await tx(ctx, hash)
      }),
    )
}

async function tx(ctx: Context, hash: string): Promise<void> {
  if (!isHash(hash)) throw usageError(`"${hash}" is not a 32-byte transaction hash.`)
  const client = ctx.read()

  const { transaction, receipt, block, meta } = await withSpinner('Fetching transaction…', async () => {
    const transaction = await client.public.getTransaction({ hash: hash as Hash }).catch(() => null)
    if (!transaction) throw notFoundError(`No transaction ${hash} on ${ctx.network}.`)
    const [receipt, meta] = await Promise.all([
      client.public.getTransactionReceipt({ hash: hash as Hash }).catch(() => null),
      fetchTx(ctx.network, hash),
    ])
    const block = receipt
      ? await client.public.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null)
      : null
    return { transaction, receipt, block, meta }
  })

  interface RawTransfer {
    token: Address
    from: Address
    to: Address
    rawValue: bigint
    knownSymbol: string | null
    knownDecimals: number | null
  }
  const raw: RawTransfer[] = []
  for (const log of receipt?.logs ?? []) {
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics })
      if (decoded.eventName !== 'Transfer') continue
      const args = decoded.args as unknown as { from: Address; to: Address; value: bigint }
      const known = ctx.network === 'mainnet' ? getStockTokenByAddress(log.address) : null
      raw.push({
        token: log.address,
        from: args.from,
        to: args.to,
        rawValue: args.value,
        knownSymbol: known?.symbol ?? null,
        knownDecimals: known?.decimals ?? null,
      })
    } catch {
      /* not an ERC-20 Transfer — skip */
    }
  }

  // Resolve symbol + decimals for unknown tokens (WETH, USDG, memecoins, …)
  // straight off the contract, so amounts read in real units, not raw wei.
  const unknownAddresses = [...new Set(raw.filter((r) => r.knownSymbol === null).map((r) => r.token.toLowerCase()))]
  const resolved = new Map<string, { symbol: string; decimals: number }>()
  await pMap(
    unknownAddresses,
    async (lower) => {
      const address = raw.find((r) => r.token.toLowerCase() === lower)!.token
      const [symbol, decimals] = await Promise.all([
        client.public.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
        client.public.readContract({ address, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
      ])
      resolved.set(lower, { symbol: String(symbol), decimals: Number(decimals) })
    },
    8,
  )

  const transfers: TransferLine[] = raw.map((r) => {
    const known = r.knownSymbol !== null && r.knownDecimals !== null
    const meta = known ? { symbol: r.knownSymbol as string, decimals: r.knownDecimals as number } : resolved.get(r.token.toLowerCase())
    return {
      token: r.token,
      symbol: meta?.symbol ?? null,
      from: r.from,
      to: r.to,
      value: meta ? tokenAmount(r.rawValue, meta.decimals) : r.rawValue.toString(),
    }
  })

  const status = receipt ? (receipt.status === 'success' ? 'success' : 'reverted') : 'pending'
  const gasUsed = receipt?.gasUsed ?? 0n
  const gasPrice = receipt?.effectiveGasPrice ?? transaction.gasPrice ?? 0n
  const feeEth = formatEther(gasUsed * gasPrice)

  const json = {
    hash,
    network: ctx.network,
    status,
    block: receipt?.blockNumber?.toString() ?? null,
    timestamp: block ? Number(block.timestamp) : null,
    from: transaction.from,
    to: transaction.to,
    valueEth: formatEther(transaction.value),
    nonce: transaction.nonce,
    method: meta?.decoded_input?.method_call ?? meta?.method ?? null,
    gasUsed: gasUsed.toString(),
    gasPriceGwei: formatGwei(gasPrice),
    feeEth,
    transfers,
    explorer: txUrl(ctx.network, hash),
  }

  printResult(json, () => renderTx(json, status, transfers), ctx.json)
}

function renderTx(
  j: { hash: string; from: Address | null; to: Address | null; valueEth: string; nonce: number; method: string | null; block: string | null; timestamp: number | null; gasUsed: string; gasPriceGwei: string; feeEth: string; explorer: string },
  status: string,
  transfers: TransferLine[],
): string {
  const statusBadge = status === 'success' ? green('● success') : status === 'reverted' ? red('● reverted') : dim('● pending')
  const header = `${accent('◈')} ${bold('Transaction')} ${dim(addr(j.hash as `0x${string}`))}  ${statusBadge}`

  const pairs: [string, string][] = [
    ['From', gray(j.from ? addr(j.from) : '—')],
    ['To', gray(j.to ? addr(j.to) : dim('contract creation'))],
    ['Value', j.valueEth === '0' ? dim('0 ETH') : bold(num(Number(j.valueEth), 8) + ' ETH')],
    ['Method', j.method ? bold(j.method) : dim('—')],
    ['Block', j.block ? '#' + j.block : dim('pending')],
    ['When', j.timestamp ? dim(timestamp(j.timestamp)) : dim('—')],
    ['Gas used', dim(num(Number(j.gasUsed), 0) + ` @ ${num(Number(j.gasPriceGwei), 4)} gwei`)],
    ['Fee', num(Number(j.feeEth), 8) + ' ETH'],
    ['Explorer', gray(j.explorer)],
  ]

  let out = `${header}\n${renderKeyValue(pairs, { labelWidth: 9 })}`
  if (transfers.length) {
    const lines = transfers.map(
      (t) =>
        `  ${gray(addr(t.from))} ${dim('→')} ${gray(addr(t.to))}  ${bold(t.value)} ${t.symbol ? accent(t.symbol) : gray(addr(t.token))}`,
    )
    out += `\n\n${dim('Token transfers')}\n${lines.join('\n')}`
  }
  return out
}
