/**
 * On-chain read helpers for the refresh pipeline. All reads go through the
 * public Robinhood Chain RPC via viem (multicall3-batched) or the raw
 * JSON-RPC layer in rpc.mjs (log scans, storage slots, simulations).
 */

import { createPublicClient, http, parseAbi, getAddress } from 'viem'
import { robinhood } from 'viem/chains'
import { MAINNET_ADDRESSES } from 'hoodchain'
import { rpc, rpcBatch } from './rpc.mjs'

export const CHAIN_ID = 4663

/** EIP-1967 beacon slot: bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1). */
export const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'

/**
 * Chain-level Chainlink feeds (proxy addresses from the official Chainlink
 * reference-data directory for robinhood-mainnet, re-verified on-chain by
 * verifyUsdFeeds() on every refresh: description() must match and the
 * answer must be positive).
 */
export const USD_FEEDS = {
  eth: { address: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', description: 'ETH / USD' },
  usdg: { address: '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2', description: 'USDG / USD' },
}

export const client = createPublicClient({
  chain: robinhood,
  transport: http(undefined, { retryCount: 5, retryDelay: 800 }),
  batch: { multicall: { batchSize: 4096, wait: 25 } },
})

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
])

export const stockAbi = parseAbi(['function uiMultiplier() view returns (uint256)'])

export const feedAbi = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

export const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
])

export const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

/** Chunked viem multicall (allowFailure) so one huge batch cannot time out. */
export async function multicallChunked(contracts, { chunk = 250 } = {}) {
  const results = []
  for (let i = 0; i < contracts.length; i += chunk) {
    const slice = contracts.slice(i, i + chunk)
    const part = await client.multicall({ contracts: slice, allowFailure: true })
    results.push(...part)
  }
  return results
}

/** Read symbol/name/decimals for many tokens. Returns Map(lowercased address -> identity | null). */
export async function readIdentities(addresses) {
  const contracts = addresses.flatMap((address) => [
    { address, abi: erc20Abi, functionName: 'symbol' },
    { address, abi: erc20Abi, functionName: 'name' },
    { address, abi: erc20Abi, functionName: 'decimals' },
  ])
  const results = await multicallChunked(contracts)
  const map = new Map()
  addresses.forEach((address, i) => {
    const [sym, name, dec] = [results[i * 3], results[i * 3 + 1], results[i * 3 + 2]]
    if (sym.status !== 'success' || name.status !== 'success' || dec.status !== 'success') {
      map.set(address.toLowerCase(), null)
      return
    }
    map.set(address.toLowerCase(), { symbol: sym.result, name: name.result, decimals: Number(dec.result) })
  })
  return map
}

/** eth_getStorageAt beacon slot for many proxies, batched. Map(lower addr -> beacon address | null). */
export async function readBeacons(addresses) {
  const map = new Map()
  const BATCH = 25
  for (let i = 0; i < addresses.length; i += BATCH) {
    const slice = addresses.slice(i, i + BATCH)
    const results = await rpcBatch(
      slice.map((address) => ({ method: 'eth_getStorageAt', params: [address, EIP1967_BEACON_SLOT, 'latest'] })),
    )
    slice.forEach((address, j) => {
      const raw = results[j]?.result
      if (typeof raw === 'string' && raw.length === 66 && raw !== `0x${'0'.repeat(64)}`) {
        map.set(address.toLowerCase(), getAddress(`0x${raw.slice(26)}`))
      } else {
        map.set(address.toLowerCase(), null)
      }
    })
  }
  return map
}

/**
 * Verify the two USD feeds on-chain and return current prices as floats.
 * Throws if a description mismatches or an answer is non-positive; a wrong
 * feed would poison every liquidity valuation downstream.
 */
export async function verifyUsdFeeds() {
  const out = {}
  for (const [key, feed] of Object.entries(USD_FEEDS)) {
    const [description, decimals, round] = await Promise.all([
      client.readContract({ address: feed.address, abi: feedAbi, functionName: 'description' }),
      client.readContract({ address: feed.address, abi: feedAbi, functionName: 'decimals' }),
      client.readContract({ address: feed.address, abi: feedAbi, functionName: 'latestRoundData' }),
    ])
    if (description !== feed.description) {
      throw new Error(`feed ${feed.address}: description "${description}" != expected "${feed.description}"`)
    }
    const answer = round[1]
    if (answer <= 0n) throw new Error(`feed ${feed.address} (${description}): non-positive answer ${answer}`)
    out[key] = { ...feed, decimals: Number(decimals), price: Number(answer) / 10 ** Number(decimals) }
  }
  return out
}

/**
 * Simulated sell: QuoterV2 quote of selling one whole token into the quote
 * asset through the token's own pool. QuoterV2 executes the swap in an
 * eth_call and reverts when the pool cannot fill it.
 */
export async function simulateSellQuote({ token, quoteToken, fee, decimals }) {
  try {
    const { result } = await client.simulateContract({
      address: MAINNET_ADDRESSES.quoterV2,
      abi: quoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: token,
          tokenOut: quoteToken,
          amountIn: 10n ** BigInt(decimals),
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
    return { ok: result[0] >= 0n, amountOut: result[0] }
  } catch (error) {
    return { ok: false, error: String(error?.shortMessage ?? error?.message ?? error) }
  }
}

/**
 * Simulated transfer: eth_call token.transfer(recipient, 1) with `from` set
 * to a live top holder. A token whose plain holders cannot transfer is a
 * honeypot and is excluded.
 */
export async function simulateTransfer({ token, holder }) {
  // 0x…1001: a fresh, code-less recipient (never a burn/blocked sentinel).
  const recipient = '0x0000000000000000000000000000000000001001'
  const data = `0xa9059cbb${recipient.slice(2).padStart(64, '0')}${(1n).toString(16).padStart(64, '0')}`
  try {
    const result = await rpc('eth_call', [{ from: holder, to: token, data }, 'latest'])
    // ERC-20 transfer returns bool true; some tokens return no data (pre-standard). Revert = failure.
    if (result === '0x' || result === '0x0'.padEnd(66, '0')) return { ok: result === '0x' }
    return { ok: BigInt(result) === 1n }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
