import { Command } from 'commander'
import { formatEther, getAddress, isAddress, type Address } from 'viem'
import { watchTransfers } from 'hoodchain'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { accent, bold, dim, gray, green, red } from '../ui/ansi.js'
import { addr, tokenAmount } from '../format.js'
import { resolveToken } from '../resolve.js'
import { usageError } from '../errors.js'

export function watchCommand(): Command {
  return new Command('watch')
    .description('Live activity stream for an address or a token (ERC-20 transfers + native ETH)')
    .argument('<addrOrToken>', 'wallet address, token address, or ticker to watch')
    .option('--token', 'treat the argument as a token (stream ALL transfers of it)', false)
    .action((target: string, opts, command) =>
      runWith(command, async (ctx) => {
        await watch(ctx, target, opts)
      }),
    )
}

async function watch(ctx: Context, target: string, opts: { token: boolean }): Promise<void> {
  const client = ctx.read()

  if (opts.token || !isAddress(target)) {
    const token = await resolveToken(client, target)
    process.stderr.write(dim(`Watching ${token.symbol} transfers (${addr(token.address)}) — Ctrl-C to stop\n`))
    const unwatch = watchTransfers(client, { token: token.address }, (t) => {
      if (ctx.json) {
        process.stdout.write(JSON.stringify({ ...t, value: t.value.toString() }) + '\n')
      } else {
        process.stdout.write(
          `${gray(addr(t.from))} ${dim('→')} ${gray(addr(t.to))}  ${bold(tokenAmount(t.value, token.decimals))} ${accent(token.symbol)}  ${dim('#' + t.blockNumber)}\n`,
        )
      }
    })
    return runUntilInterrupt(unwatch)
  }

  // Address mode: stream native ETH in/out plus every Stock Token transfer touching it.
  if (ctx.network !== 'mainnet') throw usageError('Address-mode watch needs the mainnet Stock Token registry — pass --token for a specific testnet token.')
  const owner = getAddress(target)
  process.stderr.write(dim(`Watching ${addr(owner)} for activity — Ctrl-C to stop\n`))

  const unwatchEth = client.public.watchBlocks({
    onBlock: async (block) => {
      // Cheap native-ETH activity check: scan the block's transactions touching owner.
      for (const txHash of block.transactions) {
        const tx = await client.public.getTransaction({ hash: txHash }).catch(() => null)
        if (!tx) continue
        if (tx.from.toLowerCase() !== owner.toLowerCase() && tx.to?.toLowerCase() !== owner.toLowerCase()) continue
        if (tx.value === 0n) continue
        const out = tx.from.toLowerCase() === owner.toLowerCase()
        const line = `${out ? red('↑') : green('↓')} ${bold(formatEther(tx.value))} ETH  ${dim(out ? 'to' : 'from')} ${gray(addr(out ? (tx.to as Address) : tx.from))}  ${dim('#' + block.number)}`
        if (ctx.json) process.stdout.write(JSON.stringify({ kind: 'eth', hash: tx.hash, from: tx.from, to: tx.to, valueEth: formatEther(tx.value), block: block.number.toString() }) + '\n')
        else process.stdout.write(line + '\n')
      }
    },
  })

  // Stream Stock Token transfers touching the address (widest-reach single watcher: USDG).
  const { MAINNET_ADDRESSES } = await import('hoodchain')
  const unwatchUsdg = watchTransfers(client, { token: MAINNET_ADDRESSES.usdg }, (t) => {
    if (t.from.toLowerCase() !== owner.toLowerCase() && t.to.toLowerCase() !== owner.toLowerCase()) return
    const out = t.from.toLowerCase() === owner.toLowerCase()
    if (ctx.json) {
      process.stdout.write(JSON.stringify({ kind: 'usdg', ...t, value: t.value.toString() }) + '\n')
    } else {
      process.stdout.write(
        `${out ? red('↑') : green('↓')} ${bold(tokenAmount(t.value, 6))} USDG  ${dim(out ? 'to' : 'from')} ${gray(addr(out ? t.to : t.from))}  ${dim('#' + t.blockNumber)}\n`,
      )
    }
  })

  return runUntilInterrupt(() => {
    unwatchEth()
    unwatchUsdg()
  })
}

function runUntilInterrupt(unwatch: () => void): Promise<void> {
  const shutdown = () => {
    unwatch()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return new Promise(() => {})
}
