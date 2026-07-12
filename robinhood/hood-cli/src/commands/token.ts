import { Command } from 'commander'
import { getMultiplier, erc20Abi } from 'hoodchain'
import { runWith } from '../action.js'
import type { Context } from '../context.js'
import { getOracleQuote, getDexPriceUsd } from '../prices.js'
import { printResult } from '../output.js'
import { renderKeyValue } from '../ui/table.js'
import { withSpinner } from '../ui/spinner.js'
import { accent, bold, dim, gray } from '../ui/ansi.js'
import { usd, num, addr, age } from '../format.js'
import { fetchToken, addressUrl } from '../blockscout.js'
import { resolveToken } from '../resolve.js'

export function tokenCommand(): Command {
  return new Command('token')
    .description('Inspect a token: metadata, supply, multiplier, price')
    .argument('<address>', 'token address or ticker')
    .action((address: string, _opts, command) =>
      runWith(command, async (ctx) => {
        await token(ctx, address)
      }),
    )
}

async function token(ctx: Context, input: string): Promise<void> {
  const client = ctx.read()
  const resolved = await resolveToken(client, input)

  const { meta, multiplier, oracle, dexUsd, totalSupply } = await withSpinner(`Reading ${resolved.symbol}…`, async () => {
    const [meta, multiplier, oracle, dexUsd, totalSupply] = await Promise.all([
      fetchToken(ctx.network, resolved.address),
      resolved.isStock ? getMultiplier(client, resolved.symbol) : Promise.resolve(null),
      resolved.hasFeed ? getOracleQuote(client, resolved.symbol) : Promise.resolve(null),
      getDexPriceUsd(client, resolved.address, resolved.decimals),
      client.public
        .readContract({ address: resolved.address, abi: erc20Abi, functionName: 'totalSupply' })
        .catch(() => null) as Promise<bigint | null>,
    ])
    return { meta, multiplier, oracle, dexUsd, totalSupply }
  })

  const json = {
    address: resolved.address,
    symbol: meta?.symbol ?? resolved.symbol,
    name: meta?.name ?? null,
    decimals: resolved.decimals,
    isStockToken: resolved.isStock,
    totalSupply: totalSupply !== null ? Number(totalSupply) / 10 ** resolved.decimals : null,
    holders: meta?.holders_count ? Number(meta.holders_count) : meta?.holders ? Number(meta.holders) : null,
    uiMultiplier: multiplier !== null ? Number(multiplier) / 1e18 : null,
    oracleUsd: oracle?.priceUsd ?? null,
    oracleAgeSeconds: oracle?.ageSeconds ?? null,
    dexUsd,
    explorer: addressUrl(ctx.network, resolved.address),
  }

  printResult(json, () => renderToken(json, resolved.isStock), ctx.json)
}

function renderToken(
  j: {
    address: string
    symbol: string
    name: string | null
    decimals: number
    isStockToken: boolean
    totalSupply: number | null
    holders: number | null
    uiMultiplier: number | null
    oracleUsd: number | null
    oracleAgeSeconds: number | null
    dexUsd: number | null
    explorer: string
  },
  isStock: boolean,
): string {
  const header = `${accent('◈')} ${bold(j.symbol)} ${dim(j.name ? '· ' + j.name : '')}`
  const pairs: [string, string][] = [
    ['Address', gray(addr(j.address as `0x${string}`))],
    ['Decimals', String(j.decimals)],
    ['Supply', j.totalSupply !== null ? num(j.totalSupply, 0) : dim('—')],
    ['Holders', j.holders !== null ? num(j.holders, 0) : dim('—')],
  ]
  if (isStock) {
    pairs.push(['Multiplier', j.uiMultiplier !== null ? `${num(j.uiMultiplier, 6)}×` : dim('n/a')])
    pairs.push(['Oracle', j.oracleUsd !== null ? bold(usd(j.oracleUsd)) : dim('no feed')])
    if (j.oracleAgeSeconds !== null) pairs.push(['Updated', dim(age(j.oracleAgeSeconds) + ' ago')])
  }
  pairs.push(['DEX price', j.dexUsd !== null ? usd(j.dexUsd) : dim('no pool')])
  pairs.push(['Explorer', gray(j.explorer)])
  return `${header}\n${renderKeyValue(pairs, { labelWidth: 10 })}`
}
