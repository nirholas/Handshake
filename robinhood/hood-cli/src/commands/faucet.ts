import { Command } from 'commander'
import { formatEther, formatUnits } from 'viem'
import { TESTNET_ADDRESSES, TESTNET_STOCK_TOKENS, erc20Abi } from 'hoodchain'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { printResult } from '../output.js'
import { renderKeyValue } from '../ui/table.js'
import { withSpinner } from '../ui/spinner.js'
import { accent, bold, dim, gray, underline } from '../ui/ansi.js'
import { num } from '../format.js'
import { usageError } from '../errors.js'

const FAUCET_URL = 'https://faucet.testnet.chain.robinhood.com/'
const CHAINLINK_FAUCET_URL = 'https://faucets.chain.link/robinhood-testnet'

export function faucetCommand(): Command {
  return new Command('faucet')
    .description('Print testnet faucet instructions + current testnet balances')
    .action((_opts, command) =>
      runWith(command, async (ctx) => {
        await faucet(ctx)
      }),
    )
}

async function faucet(ctx: Context): Promise<void> {
  if (ctx.network !== 'testnet') {
    throw usageError('The faucet is testnet-only.', 'Re-run with --network testnet.')
  }

  let address: string | null = null
  let balances: { eth: string; tokens: { symbol: string; balance: string }[] } | null = null
  try {
    const client = await ctx.wallet()
    address = client.account!.address
    balances = await withSpinner('Reading testnet balances…', async () => {
      const owner = client.account!.address
      const [eth, ...tokenBalances] = await Promise.all([
        client.public.getBalance({ address: owner }),
        ...Object.entries(TESTNET_STOCK_TOKENS).map(([symbol, token]) =>
          client.public
            .readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
            .then((b) => ({ symbol, balance: formatUnits(b, 18) })),
        ),
      ])
      return { eth: formatEther(eth), tokens: tokenBalances }
    })
  } catch {
    // No wallet configured — instructions only, no balance section.
  }

  const json = {
    network: 'testnet',
    chainId: 46630,
    faucetUrl: FAUCET_URL,
    chainlinkFaucetUrl: CHAINLINK_FAUCET_URL,
    note: 'The faucet requires Cloudflare Turnstile + Google Sign-In in a real browser and cannot be automated from a CLI. One claim per 24h drips testnet ETH plus 5 of each: TSLA, AMZN, PLTR, NFLX, AMD.',
    address,
    balances,
  }

  printResult(json, () => renderFaucet(json), ctx.json)
}

function renderFaucet(j: {
  faucetUrl: string
  chainlinkFaucetUrl: string
  address: string | null
  balances: { eth: string; tokens: { symbol: string; balance: string }[] } | null
}): string {
  const header = `${accent('◈')} ${bold('Testnet faucet')} ${dim('· chain 46630')}`
  const instructions = [
    dim('The faucet needs a browser session (Cloudflare Turnstile + Google Sign-In) —'),
    dim('this cannot be automated from a CLI. Claim once per 24h at:'),
    '',
    `  ${underline(j.faucetUrl)}`,
    `  ${dim('Chainlink ETH top-up:')} ${underline(j.chainlinkFaucetUrl)}`,
    '',
    dim('Each claim drips testnet ETH + 5 of each: TSLA, AMZN, PLTR, NFLX, AMD.'),
  ].join('\n')

  if (!j.address || !j.balances) {
    return `${header}\n${instructions}\n\n${dim('No wallet configured — run `hood config set wallet` to see your testnet balances here.')}`
  }

  const rows: [string, string][] = [['ETH', num(Number(j.balances.eth), 6)]]
  for (const t of j.balances.tokens) rows.push([t.symbol, num(Number(t.balance), 4)])

  return `${header}\n${instructions}\n\n${dim('Wallet ' + j.address)}\n${renderKeyValue(rows, { labelWidth: 6 })}`
}
