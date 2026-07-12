import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodeDeployData, isAddress } from 'viem'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { HOOD_TOKEN_ABI, HOOD_TOKEN_BYTECODE, HOOD_TOKEN_COMPILER } from '../generated/erc20.js'
import { printResult } from '../output.js'
import { renderKeyValue } from '../ui/table.js'
import { withSpinner } from '../ui/spinner.js'
import { confirm } from '../prompt.js'
import { accent, bold, dim, gray, green, yellow } from '../ui/ansi.js'
import { addr, num } from '../format.js'
import { txUrl, addressUrl } from '../blockscout.js'
import { guardError, usageError } from '../errors.js'

interface TokenConfig {
  name: string
  symbol: string
  decimals?: number
  initialSupply: number
}

export function deployTokenCommand(): Command {
  return new Command('deploy-token')
    .description('Deploy a fixed-supply ERC-20 from a JSON config (direct-rail, no launchpad)')
    .requiredOption('--config <path>', 'path to a JSON file: { name, symbol, decimals?, initialSupply }')
    .option('--execute', 'sign and send (default: print the plan only)', false)
    .action((opts, command) =>
      runWith(command, async (ctx) => {
        await deployToken(ctx, opts)
      }),
    )
}

interface DeployOpts {
  config: string
  execute: boolean
}

async function deployToken(ctx: Context, opts: DeployOpts): Promise<void> {
  const config = readConfig(opts.config)
  const decimals = config.decimals ?? 18

  const deployData = encodeDeployData({
    abi: HOOD_TOKEN_ABI,
    bytecode: HOOD_TOKEN_BYTECODE,
    args: [config.name, config.symbol, decimals, BigInt(config.initialSupply)],
  })

  const plan = {
    network: ctx.network,
    name: config.name,
    symbol: config.symbol,
    decimals,
    initialSupply: config.initialSupply,
    compiler: HOOD_TOKEN_COMPILER.version,
    bytecodeBytes: (deployData.length - 2) / 2,
  }

  if (!opts.execute) {
    printResult(plan, () => renderPlan(plan, false), ctx.json)
    return
  }

  const client = await ctx.wallet()
  if (!ctx.json) process.stdout.write(renderPlan(plan, true) + '\n\n')
  if (!ctx.assumeYes) {
    const ok = await confirm(`Deploy ${config.symbol} (${num(config.initialSupply, 0)} supply) on ${ctx.network}? This costs gas and cannot be undone.`)
    if (!ok) throw guardError('Deploy cancelled.')
  }

  const hash = await withSpinner('Deploying…', () =>
    client.wallet!.deployContract({
      abi: HOOD_TOKEN_ABI,
      bytecode: HOOD_TOKEN_BYTECODE,
      args: [config.name, config.symbol, decimals, BigInt(config.initialSupply)],
      account: client.account!,
      chain: client.chain,
    }),
  )
  const receipt = await withSpinner('Confirming…', () => client.public.waitForTransactionReceipt({ hash }))

  if (!receipt.contractAddress) {
    throw guardError('Deployment transaction confirmed but returned no contract address.', 'Check the transaction on the explorer.')
  }

  const result = {
    ...plan,
    hash,
    status: receipt.status,
    address: receipt.contractAddress,
    explorer: txUrl(ctx.network, hash),
    tokenExplorer: addressUrl(ctx.network, receipt.contractAddress),
  }
  printResult(result, () => renderResult(result), ctx.json)
  if (receipt.status !== 'success') process.exitCode = 1
}

function readConfig(path: string): TokenConfig {
  let raw: string
  try {
    raw = readFileSync(resolve(path), 'utf8')
  } catch {
    throw usageError(`Could not read config file "${path}".`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw usageError(`"${path}" is not valid JSON.`)
  }
  const c = parsed as Partial<TokenConfig>
  if (typeof c.name !== 'string' || !c.name.trim()) throw usageError('Config "name" must be a non-empty string.')
  if (typeof c.symbol !== 'string' || !c.symbol.trim()) throw usageError('Config "symbol" must be a non-empty string.')
  if (c.decimals !== undefined && (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 255)) {
    throw usageError('Config "decimals" must be an integer 0-255.')
  }
  if (!Number.isInteger(c.initialSupply) || (c.initialSupply as number) <= 0) {
    throw usageError('Config "initialSupply" must be a positive whole-token integer.')
  }
  return { name: c.name, symbol: c.symbol, decimals: c.decimals, initialSupply: c.initialSupply as number }
}

function renderPlan(
  p: { network: string; name: string; symbol: string; decimals: number; initialSupply: number; compiler: string; bytecodeBytes: number },
  confirming: boolean,
): string {
  const header = confirming
    ? `${yellow('⚠')}  ${bold('Confirm deploy')} ${dim('· ' + p.network)}`
    : `${accent('◈')} ${bold('Deploy plan')} ${dim('· ' + p.network + ' · add --execute to send')}`
  const pairs: [string, string][] = [
    ['Name', bold(p.name)],
    ['Symbol', bold(p.symbol)],
    ['Decimals', String(p.decimals)],
    ['Supply', num(p.initialSupply, 0) + ' ' + p.symbol],
    ['Compiler', dim(p.compiler)],
    ['Bytecode', dim(p.bytecodeBytes + ' bytes')],
  ]
  return `${header}\n${renderKeyValue(pairs, { labelWidth: 9 })}`
}

function renderResult(r: { address: string; hash: string; status: string; explorer: string; tokenExplorer: string; symbol: string }): string {
  const badge = r.status === 'success' ? green('✓ deployed') : dim('✗ reverted')
  return `${badge}\n${renderKeyValue(
    [
      ['Token', bold(r.symbol) + '  ' + gray(addr(r.address as `0x${string}`))],
      ['Tx', gray(addr(r.hash as `0x${string}`))],
      ['Explorer', gray(r.tokenExplorer)],
    ],
    { labelWidth: 9 },
  )}`
}
