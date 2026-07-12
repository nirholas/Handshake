import {
  erc20Abi,
  getStockToken,
  isStockTokenSymbol,
  MAINNET_ADDRESSES,
  STOCK_TOKEN_DECIMALS,
  TESTNET_ADDRESSES,
  TESTNET_STOCK_TOKENS,
  USDG_DECIMALS,
  type HoodClient,
} from 'hoodchain'
import { isAddress, type Address } from 'viem'
import { badInput, friendly } from './errors.js'

/** A resolved token: its on-chain address, decimals, and display label. */
export interface ResolvedToken {
  address: Address
  decimals: number
  /** Human label — the ticker for known tokens, else a shortened address. */
  label: string
}

/**
 * A token reference accepted across the API. Either:
 * - a Stock Token ticker (`'AAPL'`, `'TSLA'`, case-insensitive),
 * - `'USDG'` / `'WETH'` / `'ETH'` (WETH),
 * - or a raw `0x…` contract address (any memecoin / ERC-20).
 */
export type TokenRef = string

function netAddresses(client: HoodClient) {
  return client.network === 'testnet' ? TESTNET_ADDRESSES : MAINNET_ADDRESSES
}

/**
 * Resolve a {@link TokenRef} into an address + decimals. Known symbols resolve
 * offline; unknown addresses read `decimals()` on-chain once.
 */
export async function resolveToken(client: HoodClient, ref: TokenRef): Promise<ResolvedToken> {
  if (typeof ref !== 'string' || ref.trim() === '') {
    badInput('Token must be a ticker ("AAPL"), "USDG"/"WETH"/"ETH", or a 0x address.')
  }
  const token = ref.trim()
  const upper = token.toUpperCase()

  if (upper === 'USDG') {
    return { address: netAddresses(client).usdg, decimals: USDG_DECIMALS, label: 'USDG' }
  }
  if (upper === 'WETH' || upper === 'ETH') {
    return { address: netAddresses(client).weth, decimals: 18, label: 'WETH' }
  }

  if (isAddress(token)) {
    const decimals = await friendly(() =>
      client.public.readContract({ address: token as Address, abi: erc20Abi, functionName: 'decimals' }),
    )
    return { address: token as Address, decimals: Number(decimals), label: shorten(token) }
  }

  // Testnet Stock Tokens are a fixed faucet set, not the mainnet registry.
  if (client.network === 'testnet') {
    const addr = (TESTNET_STOCK_TOKENS as Record<string, Address>)[upper]
    if (addr) return { address: addr, decimals: STOCK_TOKEN_DECIMALS, label: upper }
    badInput(
      `"${token}" is not a testnet token. Testnet Stock Tokens are ${Object.keys(TESTNET_STOCK_TOKENS).join(', ')}, plus "USDG"/"WETH" or a 0x address.`,
    )
  }

  if (isStockTokenSymbol(upper)) {
    const st = getStockToken(upper)
    return { address: st.address, decimals: st.decimals, label: st.symbol }
  }

  badInput(`"${token}" is not a known Stock Token, "USDG"/"WETH", or a 0x address.`)
}

/** Whether a {@link TokenRef} names a canonical mainnet Stock Token. */
export function isStockRef(client: HoodClient, ref: string): boolean {
  if (isAddress(ref)) return false
  const upper = ref.trim().toUpperCase()
  if (upper === 'USDG' || upper === 'WETH' || upper === 'ETH') return false
  return client.network === 'testnet'
    ? upper in TESTNET_STOCK_TOKENS
    : isStockTokenSymbol(upper)
}

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
