/**
 * Resolve a user-supplied token reference — a ticker (`AAPL`, `USDG`, `WETH`),
 * a special name, or a raw `0x` address — into an on-chain token descriptor.
 * Symbols resolve without a network round-trip; raw addresses are read from the
 * ERC-20 contract.
 */
import { getAddress, isAddress, type Address } from 'viem'
import {
  MAINNET_ADDRESSES,
  TESTNET_ADDRESSES,
  TESTNET_STOCK_TOKENS,
  USDG_DECIMALS,
  STOCK_TOKEN_DECIMALS,
  erc20Abi,
  getStockToken,
  getStockTokenByAddress,
  isStockTokenSymbol,
  isStockTokenAddress,
  type HoodClient,
} from 'hoodchain'
import { notFoundError, usageError } from './errors.js'

export interface ResolvedToken {
  address: Address
  symbol: string
  decimals: number
  /** Whether this is a canonical Stock Token (drives the eligibility gate). */
  isStock: boolean
  /** Whether it carries a Chainlink feed (mainnet stocks only). */
  hasFeed: boolean
}

/** Resolve a token reference for the client's network. */
export async function resolveToken(client: HoodClient, input: string): Promise<ResolvedToken> {
  const raw = input.trim()
  const upper = raw.toUpperCase()
  const testnet = client.network === 'testnet'

  // Stablecoin + wrapped native shorthands.
  if (upper === 'USDG') {
    return {
      address: testnet ? TESTNET_ADDRESSES.usdg : MAINNET_ADDRESSES.usdg,
      symbol: 'USDG',
      decimals: USDG_DECIMALS,
      isStock: false,
      hasFeed: false,
    }
  }
  if (upper === 'WETH' || upper === 'ETH') {
    return {
      address: testnet ? TESTNET_ADDRESSES.weth : MAINNET_ADDRESSES.weth,
      symbol: 'WETH',
      decimals: 18,
      isStock: false,
      hasFeed: false,
    }
  }

  // Stock tickers.
  if (testnet) {
    const t = (TESTNET_STOCK_TOKENS as Record<string, Address>)[upper]
    if (t) return { address: t, symbol: upper, decimals: STOCK_TOKEN_DECIMALS, isStock: true, hasFeed: false }
  } else if (isStockTokenSymbol(upper)) {
    const token = getStockToken(upper)
    return {
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      isStock: true,
      hasFeed: token.feed !== null,
    }
  }

  // Raw address — read metadata on-chain.
  if (isAddress(raw)) {
    const address = getAddress(raw)
    const known = client.network === 'mainnet' ? getStockTokenByAddress(address) : null
    if (known) {
      return {
        address,
        symbol: known.symbol,
        decimals: known.decimals,
        isStock: true,
        hasFeed: known.feed !== null,
      }
    }
    const [symbol, decimals] = await Promise.all([
      client.public
        .readContract({ address, abi: erc20Abi, functionName: 'symbol' })
        .catch(() => 'TOKEN') as Promise<string>,
      client.public
        .readContract({ address, abi: erc20Abi, functionName: 'decimals' })
        .catch(() => 18) as Promise<number>,
    ])
    return {
      address,
      symbol,
      decimals: Number(decimals),
      isStock: client.network === 'mainnet' ? isStockTokenAddress(address) : false,
      hasFeed: false,
    }
  }

  if (raw.startsWith('0x')) throw usageError(`"${raw}" is not a valid address.`)
  throw notFoundError(
    `Unknown token "${raw}".`,
    testnet
      ? `Testnet tokens: USDG, WETH, ${Object.keys(TESTNET_STOCK_TOKENS).join(', ')}, or a 0x address.`
      : 'Use a Stock Token ticker (run `hood stocks`), USDG, WETH, or a 0x address.',
  )
}
