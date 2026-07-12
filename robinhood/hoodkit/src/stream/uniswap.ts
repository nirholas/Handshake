import { getAddress, type Abi, type Address, type Hash, type Log } from 'viem'
import { MAINNET_ADDRESSES, TESTNET_ADDRESSES, V3_FEE_TIERS, type HoodClient } from 'hoodchain'

/** Uniswap v3 `Swap` event — the one every pool emits per trade. */
export const uniswapV3SwapEvent = {
  type: 'event',
  name: 'Swap',
  inputs: [
    { name: 'sender', type: 'address', indexed: true },
    { name: 'recipient', type: 'address', indexed: true },
    { name: 'amount0', type: 'int256', indexed: false },
    { name: 'amount1', type: 'int256', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
  ],
} as const

/** Minimal pool metadata ABI (token0/token1/fee). */
export const uniswapV3PoolMetaAbi = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
] as const satisfies Abi

/** ERC-20 `decimals` reader (some pool tokens aren't in the Stock Token registry). */
export const erc20DecimalsAbi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const satisfies Abi

const factoryGetPoolAbi = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
    outputs: [{ type: 'address' }],
  },
] as const satisfies Abi

const ZERO = '0x0000000000000000000000000000000000000000'
const Q96 = 2n ** 96n

/** Static metadata for a discovered pool. */
export interface PoolInfo {
  pool: Address
  token0: Address
  token1: Address
  fee: number
  decimals0: number
  decimals1: number
}

/** A decoded Uniswap v3 swap. */
export interface SwapEvent {
  pool: Address
  /** token0 delta (signed, raw units): negative = pool paid out token0. */
  amount0: bigint
  /** token1 delta (signed, raw units). */
  amount1: bigint
  /** `true` when the trader bought token0 (pool's token0 went out, i.e. amount0 < 0). */
  buysToken0: boolean
  /** Executed price of token0 denominated in token1, decimal-adjusted (human units). */
  price: number
  /** |amount0| in human units. */
  volume0: number
  /** |amount1| in human units. */
  volume1: number
  /** Pool spot price after the swap, from `sqrtPriceX96` (token0 in token1, human units). */
  spotPrice: number
  sqrtPriceX96: bigint
  liquidity: bigint
  tick: number
  blockNumber: bigint
  logIndex: number
  transactionHash: Hash
  sender: Address
  recipient: Address
}

function toHuman(raw: bigint, decimals: number): number {
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const divisor = 10 ** decimals
  return (negative ? -1 : 1) * (Number(abs) / divisor)
}

/** Convert a pool `sqrtPriceX96` to the human price of token0 in token1. */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  if (sqrtPriceX96 <= 0n) return 0
  const sqrt = Number(sqrtPriceX96) / Number(Q96)
  return sqrt * sqrt * 10 ** (decimals0 - decimals1)
}

function addr(client: HoodClient): { factory: Address; weth: Address; usdg: Address } {
  return client.network === 'testnet'
    ? { factory: TESTNET_ADDRESSES.uniswapV3Factory, weth: TESTNET_ADDRESSES.weth, usdg: TESTNET_ADDRESSES.usdg }
    : { factory: MAINNET_ADDRESSES.uniswapV3Factory, weth: MAINNET_ADDRESSES.weth, usdg: MAINNET_ADDRESSES.usdg }
}

/** Read a pool's token0/token1/fee and both token decimals in one multicall. */
export async function loadPoolInfo(client: HoodClient, pool: Address): Promise<PoolInfo> {
  const [token0, token1, fee] = await client.public.multicall({
    contracts: [
      { address: pool, abi: uniswapV3PoolMetaAbi, functionName: 'token0' },
      { address: pool, abi: uniswapV3PoolMetaAbi, functionName: 'token1' },
      { address: pool, abi: uniswapV3PoolMetaAbi, functionName: 'fee' },
    ],
    allowFailure: false,
  })
  const [decimals0, decimals1] = await client.public.multicall({
    contracts: [
      { address: token0, abi: erc20DecimalsAbi, functionName: 'decimals' },
      { address: token1, abi: erc20DecimalsAbi, functionName: 'decimals' },
    ],
    allowFailure: false,
  })
  return {
    pool: getAddress(pool),
    token0: getAddress(token0),
    token1: getAddress(token1),
    fee: Number(fee),
    decimals0: Number(decimals0),
    decimals1: Number(decimals1),
  }
}

/**
 * Discover the live Uniswap v3 pools for `token`, probed against WETH and USDG
 * across every fee tier. Only pools the factory actually created are returned.
 */
export async function discoverPools(client: HoodClient, token: Address): Promise<PoolInfo[]> {
  const { factory, weth, usdg } = addr(client)
  const quotes = [weth, usdg].filter((q) => q.toLowerCase() !== token.toLowerCase())
  const probes: { quote: Address; fee: number }[] = []
  for (const quote of quotes) for (const fee of V3_FEE_TIERS) probes.push({ quote, fee })

  const pools = await client.public.multicall({
    contracts: probes.map((p) => ({
      address: factory,
      abi: factoryGetPoolAbi,
      functionName: 'getPool' as const,
      args: [token, p.quote, p.fee] as const,
    })),
    allowFailure: true,
  })

  const found: Address[] = []
  pools.forEach((res) => {
    if (res.status === 'success' && res.result && res.result !== ZERO) found.push(res.result as Address)
  })
  const unique = [...new Set(found.map((a) => a.toLowerCase()))].map((a) => getAddress(a as Address))
  return Promise.all(unique.map((pool) => loadPoolInfo(client, pool)))
}

/** Decode a raw viem `Swap` log against a known pool's decimals. */
export function decodeSwapLog(log: Log, info: PoolInfo): SwapEvent | null {
  const args = (log as unknown as { args?: Record<string, unknown> }).args
  if (!args) return null
  const amount0 = args.amount0 as bigint
  const amount1 = args.amount1 as bigint
  const sqrtPriceX96 = args.sqrtPriceX96 as bigint
  if (amount0 === undefined || amount1 === undefined) return null

  const volume0 = Math.abs(toHuman(amount0, info.decimals0))
  const volume1 = Math.abs(toHuman(amount1, info.decimals1))
  const price = volume0 > 0 ? volume1 / volume0 : sqrtPriceX96ToPrice(sqrtPriceX96, info.decimals0, info.decimals1)

  return {
    pool: info.pool,
    amount0,
    amount1,
    buysToken0: amount0 < 0n,
    price,
    volume0,
    volume1,
    spotPrice: sqrtPriceX96ToPrice(sqrtPriceX96, info.decimals0, info.decimals1),
    sqrtPriceX96,
    liquidity: (args.liquidity as bigint) ?? 0n,
    tick: Number((args.tick as bigint | number) ?? 0),
    blockNumber: log.blockNumber ?? 0n,
    logIndex: log.logIndex ?? 0,
    transactionHash: (log.transactionHash ?? ('0x' as Hash)) as Hash,
    sender: (args.sender as Address) ?? ZERO,
    recipient: (args.recipient as Address) ?? ZERO,
  }
}
