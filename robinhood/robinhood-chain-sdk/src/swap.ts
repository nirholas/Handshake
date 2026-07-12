import {
  encodeFunctionData,
  encodePacked,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import { erc20Abi, quoterV2Abi, swapRouter02Abi, swapRouterAbi } from './abis.js'
import { MAINNET_ADDRESSES, TESTNET_ADDRESSES, V3_FEE_TIERS } from './addresses.js'
import type { HoodClient } from './client.js'
import {
  NoAccountError,
  NoRouteError,
  StockTokenEligibilityError,
} from './errors.js'
import { isStockTokenAddress } from './registry/index.js'

/**
 * Uniswap v3 swaps on Robinhood Chain.
 *
 * Works for memecoins and Stock Tokens alike. **Stock Token eligibility:**
 * Stock Tokens are tokenized debt securities (issuer: Robinhood Assets
 * (Jersey) Ltd) and may not be offered, sold, or delivered to US persons
 * (additional limits: Canada, UK, Switzerland). The restriction is legal and
 * front-end enforced, not contract-level. Any swap whose OUTPUT is a
 * canonical Stock Token therefore throws {@link StockTokenEligibilityError}
 * unless the client was created with `acknowledgeStockTokenEligibility:
 * true`, which is the operator's affirmation of eligibility. Selling a Stock
 * Token and displaying data are never gated.
 *
 * Router flavors (verified on-chain): mainnet routes through `SwapRouter02`
 * (no deadline in the params struct — enforced via `multicall(deadline,
 * data)`); the testnet community deployment uses the classic `SwapRouter`
 * (deadline inside the struct). `buildSwapTx` handles both.
 */

/** Router/quoter/WETH set used for swaps on the client's network. */
export function swapAddresses(client: HoodClient): {
  quoterV2: Address
  router: Address
  routerKind: 'swapRouter02' | 'swapRouter'
  weth: Address
  usdg: Address
} {
  if (client.network === 'testnet') {
    return {
      quoterV2: TESTNET_ADDRESSES.quoterV2,
      router: TESTNET_ADDRESSES.swapRouter,
      routerKind: 'swapRouter',
      weth: TESTNET_ADDRESSES.weth,
      usdg: TESTNET_ADDRESSES.usdg,
    }
  }
  return {
    quoterV2: MAINNET_ADDRESSES.quoterV2,
    router: MAINNET_ADDRESSES.swapRouter02,
    routerKind: 'swapRouter02',
    weth: MAINNET_ADDRESSES.weth,
    usdg: MAINNET_ADDRESSES.usdg,
  }
}

/** A candidate route: direct single-pool hop or two hops via an intermediate. */
export interface SwapRoute {
  /** Pool fee tiers along the route (one entry per hop). */
  fees: number[]
  /** Token path: `[tokenIn, ...intermediates, tokenOut]`. */
  path: Address[]
  /** Uniswap encoded path (`token(20) fee(3) token(20)...`). */
  encodedPath: Hex
}

/** A quote for a concrete route. */
export interface SwapQuote {
  route: SwapRoute
  amountIn: bigint
  amountOut: bigint
  /** QuoterV2's gas estimate for the swap. */
  gasEstimate: bigint
}

/** Options for {@link quoteSwap}. */
export interface QuoteSwapOptions {
  /**
   * Intermediate tokens tried for two-hop routes when quoting. Defaults to
   * the network's WETH and USDG.
   */
  intermediates?: Address[]
  /** Restrict single-hop probing to these fee tiers. Defaults to all four v3 tiers. */
  feeTiers?: readonly number[]
}

function encodePath(path: Address[], fees: number[]): Hex {
  const types: ('address' | 'uint24')[] = []
  const values: (Address | number)[] = []
  path.forEach((token, i) => {
    types.push('address')
    values.push(token)
    if (i < fees.length) {
      types.push('uint24')
      values.push(fees[i] as number)
    }
  })
  return encodePacked(types, values)
}

/**
 * Quote the best route from `tokenIn` to `tokenOut` for `amountIn`.
 *
 * Probes every fee tier for a direct hop, plus two-hop routes through WETH
 * and USDG (0.05%/0.3% legs), all via QuoterV2 `eth_call` simulation, and
 * returns the route with the highest output. Pools that exist without
 * liquidity revert inside the quoter and are simply skipped.
 *
 * @throws {@link NoRouteError} when no probed route can fill the swap.
 *
 * @example Quote 100 USDG → WETH on mainnet
 * ```ts
 * const quote = await quoteSwap(hood, {
 *   tokenIn: MAINNET_ADDRESSES.usdg,
 *   tokenOut: MAINNET_ADDRESSES.weth,
 *   amountIn: parseUsdg('100'),
 * })
 * ```
 */
export async function quoteSwap(
  client: HoodClient,
  args: { tokenIn: Address; tokenOut: Address; amountIn: bigint },
  options: QuoteSwapOptions = {},
): Promise<SwapQuote> {
  const { quoterV2, weth, usdg } = swapAddresses(client)
  const { tokenIn, tokenOut, amountIn } = args
  const feeTiers = options.feeTiers ?? V3_FEE_TIERS

  const candidates: SwapRoute[] = []
  for (const fee of feeTiers) {
    candidates.push({ fees: [fee], path: [tokenIn, tokenOut], encodedPath: encodePath([tokenIn, tokenOut], [fee]) })
  }
  const intermediates = (options.intermediates ?? [weth, usdg]).filter(
    (mid) => mid.toLowerCase() !== tokenIn.toLowerCase() && mid.toLowerCase() !== tokenOut.toLowerCase(),
  )
  for (const mid of intermediates) {
    for (const feeA of [500, 3000]) {
      for (const feeB of [500, 3000]) {
        candidates.push({
          fees: [feeA, feeB],
          path: [tokenIn, mid, tokenOut],
          encodedPath: encodePath([tokenIn, mid, tokenOut], [feeA, feeB]),
        })
      }
    }
  }

  const results = await Promise.all(
    candidates.map(async (route): Promise<SwapQuote | null> => {
      try {
        if (route.fees.length === 1) {
          const { result } = await client.public.simulateContract({
            address: quoterV2,
            abi: quoterV2Abi,
            functionName: 'quoteExactInputSingle',
            args: [
              {
                tokenIn,
                tokenOut,
                amountIn,
                fee: route.fees[0] as number,
                sqrtPriceLimitX96: 0n,
              },
            ],
          })
          return { route, amountIn, amountOut: result[0], gasEstimate: result[3] }
        }
        const { result } = await client.public.simulateContract({
          address: quoterV2,
          abi: quoterV2Abi,
          functionName: 'quoteExactInput',
          args: [route.encodedPath, amountIn],
        })
        return { route, amountIn, amountOut: result[0], gasEstimate: result[3] }
      } catch {
        return null
      }
    }),
  )

  const best = results
    .filter((q): q is SwapQuote => q !== null && q.amountOut > 0n)
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0))[0]
  if (!best) {
    throw new NoRouteError(
      tokenIn,
      tokenOut,
      `no direct pool (fees ${feeTiers.join('/')}) or two-hop route via ${intermediates.length} intermediates produced output for amountIn=${amountIn}`,
    )
  }
  return best
}

/** Options for {@link buildSwapTx} / {@link executeSwap}. */
export interface SwapTxOptions {
  /**
   * Slippage tolerance in basis points applied to the quoted output.
   * @defaultValue `50` (0.5%)
   */
  slippageBps?: number
  /**
   * Seconds until the swap transaction expires.
   * @defaultValue `600` (10 minutes)
   */
  deadlineSeconds?: number
  /** Recipient of the output tokens. Defaults to the client's account. */
  recipient?: Address
}

/** A ready-to-send swap transaction. */
export interface SwapTx {
  to: Address
  data: Hex
  value: bigint
  /** Quoted output the calldata's minimum was derived from. */
  quote: SwapQuote
  /** `amountOutMinimum` embedded in the calldata. */
  amountOutMinimum: bigint
  deadline: bigint
}

/**
 * Build swap calldata for the network's canonical router from a quote.
 *
 * The caller must hold `quote.amountIn` of the input token and have approved
 * the router for it (see {@link ensureApproval}).
 *
 * @throws {@link StockTokenEligibilityError} when the output token is a
 * canonical Stock Token and the client did not acknowledge eligibility.
 */
export function buildSwapTx(client: HoodClient, quote: SwapQuote, options: SwapTxOptions = {}): SwapTx {
  const { router, routerKind } = swapAddresses(client)
  const tokenOut = quote.route.path[quote.route.path.length - 1] as Address

  if (client.network === 'mainnet' && isStockTokenAddress(tokenOut) && !client.acknowledgeStockTokenEligibility) {
    throw new StockTokenEligibilityError()
  }

  const recipient = options.recipient ?? client.account?.address
  if (!recipient) throw new NoAccountError('buildSwapTx (or pass options.recipient)')

  const slippageBps = options.slippageBps ?? 50
  const amountOutMinimum = (quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (options.deadlineSeconds ?? 600))
  const singleHop = quote.route.fees.length === 1

  let data: Hex
  if (routerKind === 'swapRouter') {
    // Classic SwapRouter: deadline lives in the params struct.
    data = singleHop
      ? encodeFunctionData({
          abi: swapRouterAbi,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: quote.route.path[0] as Address,
              tokenOut,
              fee: quote.route.fees[0] as number,
              recipient,
              deadline,
              amountIn: quote.amountIn,
              amountOutMinimum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
      : encodeFunctionData({
          abi: swapRouterAbi,
          functionName: 'exactInput',
          args: [
            {
              path: quote.route.encodedPath,
              recipient,
              deadline,
              amountIn: quote.amountIn,
              amountOutMinimum,
            },
          ],
        })
  } else {
    // SwapRouter02: wrap the call in multicall(deadline, [data]).
    const inner = singleHop
      ? encodeFunctionData({
          abi: swapRouter02Abi,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: quote.route.path[0] as Address,
              tokenOut,
              fee: quote.route.fees[0] as number,
              recipient,
              amountIn: quote.amountIn,
              amountOutMinimum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
      : encodeFunctionData({
          abi: swapRouter02Abi,
          functionName: 'exactInput',
          args: [
            {
              path: quote.route.encodedPath,
              recipient,
              amountIn: quote.amountIn,
              amountOutMinimum,
            },
          ],
        })
    data = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: 'multicall',
      args: [deadline, [inner]],
    })
  }

  return { to: router, data, value: 0n, quote, amountOutMinimum, deadline }
}

/**
 * Ensure the router is approved to spend `amountIn` of the input token,
 * sending an `approve` transaction only when the current allowance is short.
 * Returns the approval tx hash, or `null` when no approval was needed.
 */
export async function ensureApproval(
  client: HoodClient,
  token: Address,
  amount: bigint,
): Promise<Hash | null> {
  if (!client.wallet || !client.account) throw new NoAccountError('ensureApproval')
  const { router } = swapAddresses(client)
  const allowance = await client.public.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [client.account.address, router],
  })
  if (allowance >= amount) return null
  const hash = await client.wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [router, amount],
  })
  await client.public.waitForTransactionReceipt({ hash })
  return hash
}

/**
 * Quote, build, approve (if needed), send, and confirm a swap in one call.
 *
 * @returns The swap transaction hash and the receipt.
 *
 * @example Swap 0.0001 WETH → NFLX on testnet
 * ```ts
 * const { hash, receipt, quote } = await executeSwap(hood, {
 *   tokenIn: TESTNET_ADDRESSES.weth,
 *   tokenOut: TESTNET_STOCK_TOKENS.NFLX,
 *   amountIn: parseEther('0.0001'),
 * })
 * ```
 */
export async function executeSwap(
  client: HoodClient,
  args: { tokenIn: Address; tokenOut: Address; amountIn: bigint },
  options: SwapTxOptions & QuoteSwapOptions = {},
) {
  if (!client.wallet || !client.account) throw new NoAccountError('executeSwap')
  const quote = await quoteSwap(client, args, options)
  const tx = buildSwapTx(client, quote, options)
  await ensureApproval(client, args.tokenIn, args.amountIn)
  const hash = await client.wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    account: client.account,
    chain: client.chain,
  })
  const receipt = await client.public.waitForTransactionReceipt({ hash })
  return { hash, receipt, quote, amountOutMinimum: tx.amountOutMinimum }
}
