/**
 * Register the guarded trading tools on an MCP server. Every mutating tool
 * (execute_swap, transfer_usdg) enforces the same three gates, in order:
 *
 *   1. Eligibility — Stock Token BUYS require HOOD_MCP_ACKNOWLEDGE_ELIGIBILITY=1.
 *   2. Spend caps — the USD value is checked against the per-call and
 *      per-session limits BEFORE anything is signed.
 *   3. Confirm gate — the first call returns a simulation preview (recipient,
 *      amount, token) and requires a second call with `confirm: true`. Nothing
 *      is broadcast until the caller confirms.
 *
 * This mirrors the money-moving confirmation gate in the three.ws CLAUDE.md
 * rules: never let a spend originate without an explicit human/agent yes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { formatUnits, parseUnits, type Address } from 'viem'
import {
  erc20Abi,
  executeSwap,
  formatUsdg,
  getPortfolio,
  getStockToken,
  getStockTokenByAddress,
  getUsdgBalance,
  isStockTokenAddress,
  isStockTokenSymbol,
  parseUsdg,
  quoteSwap,
  swapAddresses,
  transferUsdg,
  TESTNET_STOCK_TOKENS,
  NoRouteError,
  StockTokenEligibilityError,
  UnknownSymbolError,
} from 'hoodchain'
import type { HoodClient } from 'hoodchain'
import { addressLink, errMessage, isAddress, round, sameAddress, toError, toResult, txLink } from './shared/format.js'
import type { SpendLedger, TradingConfig } from './shared/trading-env.js'

/** A resolved token reference: address, decimals, and a display symbol. */
interface ResolvedToken {
  address: Address
  decimals: number
  symbol: string
  isStockToken: boolean
}

/**
 * Resolve a token reference — an address, a Stock Token ticker, or one of the
 * shortcuts USDG / WETH / ETH — to its address + decimals on the client's
 * network. Reads decimals on-chain for unknown ERC-20 addresses.
 */
async function resolveToken(client: HoodClient, ref: string): Promise<ResolvedToken> {
  const { usdg, weth } = swapAddresses(client)
  const upper = ref.trim().toUpperCase()

  if (upper === 'USDG') return { address: usdg, decimals: 6, symbol: 'USDG', isStockToken: false }
  if (upper === 'WETH' || upper === 'ETH') return { address: weth, decimals: 18, symbol: 'WETH', isStockToken: false }

  if (isAddress(ref)) {
    const stock = client.network === 'mainnet' ? getStockTokenByAddress(ref as Address) : null
    if (stock) return { address: stock.address, decimals: stock.decimals, symbol: stock.symbol, isStockToken: true }
    const decimals = await client.public.readContract({ address: ref as Address, abi: erc20Abi, functionName: 'decimals' })
    return { address: ref as Address, decimals: Number(decimals), symbol: ref.slice(0, 8), isStockToken: false }
  }

  // Ticker → Stock Token.
  if (client.network === 'testnet') {
    const addr = (TESTNET_STOCK_TOKENS as Record<string, Address>)[upper]
    if (addr) return { address: addr, decimals: 18, symbol: upper, isStockToken: false }
  } else if (isStockTokenSymbol(ref)) {
    const t = getStockToken(ref)
    return { address: t.address, decimals: t.decimals, symbol: t.symbol, isStockToken: true }
  }
  throw new UnknownSymbolError(ref)
}

/**
 * Value `amountIn` of `tokenIn` in USD (USDG). USDG is face value; anything
 * else is quoted into USDG. Returns `null` when the value cannot be determined
 * (no price route) — callers MUST reject rather than treat null as zero.
 */
async function valueInUsd(client: HoodClient, tokenIn: ResolvedToken, amountInRaw: bigint): Promise<number | null> {
  const { usdg } = swapAddresses(client)
  if (sameAddress(tokenIn.address, usdg)) return Number(formatUnits(amountInRaw, 6))
  try {
    const q = await quoteSwap(client, { tokenIn: tokenIn.address, tokenOut: usdg, amountIn: amountInRaw })
    return Number(formatUnits(q.amountOut, 6))
  } catch {
    return null
  }
}

/**
 * Register trading tools. `ledger` tracks session spend; `config` carries the
 * caps and eligibility flag. The client MUST have a wallet account.
 */
export function registerTradingTools(
  server: McpServer,
  client: HoodClient,
  config: TradingConfig,
  ledger: SpendLedger,
): void {
  const network = client.network
  const account = client.account
  if (!account) throw new Error('registerTradingTools requires a wallet-backed client')
  const walletAddress = account.address

  // -------------------------------------------------------- get_my_portfolio
  server.registerTool(
    'get_my_portfolio',
    {
      title: 'My portfolio',
      description:
        "This wallet's holdings on Robinhood Chain: native ETH (gas), USDG cash, and every " +
        'Stock Token position with multiplier-correct USD value. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const [portfolio, usdgRaw, ethRaw] = await Promise.all([
          getPortfolio(client, walletAddress),
          getUsdgBalance(client, walletAddress),
          client.public.getBalance({ address: walletAddress }),
        ])
        return toResult({
          address: walletAddress,
          network,
          ethBalance: formatUnits(ethRaw, 18),
          usdgBalance: formatUsdg(usdgRaw),
          totalStockValueUsd: round(portfolio.totalUsd, 2),
          positions: portfolio.positions.map((p) => ({
            symbol: p.symbol,
            balanceTokens: round(p.balanceTokens, 8),
            shareEquivalent: round(p.shareEquivalent, 8),
            valueUsd: p.valueUsd === null ? null : round(p.valueUsd, 2),
          })),
          unpricedSymbols: portfolio.unpricedSymbols,
          explorer: addressLink(network, walletAddress),
          asOf: new Date().toISOString(),
        })
      } catch (e) {
        return toError(`Failed to read portfolio: ${errMessage(e)}`)
      }
    },
  )

  // ----------------------------------------------------------- get_swap_quote
  server.registerTool(
    'get_swap_quote',
    {
      title: 'Get swap quote',
      description:
        'Quote a Uniswap swap on Robinhood Chain without signing: best route, expected output, ' +
        'minimum received at your slippage, and the USD value of the input. Tokens are ' +
        'addresses, Stock Token tickers, or USDG/WETH.',
      inputSchema: {
        tokenIn: z.string().describe('Input token: address, ticker (e.g. TSLA), or USDG/WETH.'),
        tokenOut: z.string().describe('Output token: address, ticker, or USDG/WETH.'),
        amountIn: z.string().describe('Human amount of tokenIn, e.g. "100" or "0.05".'),
        slippageBps: z.number().int().min(1).max(5000).optional().describe('Slippage tolerance in bps (default 50 = 0.5%).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tokenIn, tokenOut, amountIn, slippageBps }) => {
      try {
        const [ti, to] = await Promise.all([resolveToken(client, tokenIn), resolveToken(client, tokenOut)])
        const amountInRaw = parseUnits(amountIn, ti.decimals)
        const quote = await quoteSwap(client, { tokenIn: ti.address, tokenOut: to.address, amountIn: amountInRaw })
        const bps = slippageBps ?? 50
        const minOut = (quote.amountOut * BigInt(10_000 - bps)) / 10_000n
        const outHuman = Number(formatUnits(quote.amountOut, to.decimals))
        const inHuman = Number(amountIn)
        const usd = await valueInUsd(client, ti, amountInRaw)
        return toResult({
          network,
          tokenIn: { ref: tokenIn, symbol: ti.symbol, address: ti.address },
          tokenOut: { ref: tokenOut, symbol: to.symbol, address: to.address },
          amountIn,
          amountOut: formatUnits(quote.amountOut, to.decimals),
          minReceived: formatUnits(minOut, to.decimals),
          executionRate: inHuman > 0 ? round(outHuman / inHuman, 8) : null,
          rateLabel: `${to.symbol} per ${ti.symbol}`,
          inputValueUsd: usd === null ? null : round(usd, 4),
          slippageBps: bps,
          route: quote.route.path,
          feeTiers: quote.route.fees,
          gasEstimate: quote.gasEstimate.toString(),
          asOf: new Date().toISOString(),
        })
      } catch (e) {
        if (e instanceof UnknownSymbolError) return toError(`Unknown token: ${e.message}`)
        if (e instanceof NoRouteError) return toError('No Uniswap route between those tokens.', e.message)
        return toError(`Quote failed: ${errMessage(e)}`)
      }
    },
  )

  // ------------------------------------------------------------- execute_swap
  server.registerTool(
    'execute_swap',
    {
      title: 'Execute a swap (guarded)',
      description:
        'Swap tokens on Robinhood Chain. First call returns a SIMULATION and requires confirm=true ' +
        'to broadcast. Spend is hard-capped in USD; Stock Token BUYS require eligibility. ' +
        'Approves the router automatically if needed.',
      inputSchema: {
        tokenIn: z.string().describe('Input token: address, ticker, or USDG/WETH.'),
        tokenOut: z.string().describe('Output token: address, ticker, or USDG/WETH.'),
        amountIn: z.string().describe('Human amount of tokenIn to spend, e.g. "10".'),
        slippageBps: z.number().int().min(1).max(5000).optional().describe('Slippage tolerance in bps (default 50).'),
        confirm: z.boolean().optional().describe('Must be true to actually broadcast. Omit/false to preview.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ tokenIn, tokenOut, amountIn, slippageBps, confirm }) => {
      try {
        const [ti, to] = await Promise.all([resolveToken(client, tokenIn), resolveToken(client, tokenOut)])
        const amountInRaw = parseUnits(amountIn, ti.decimals)

        // Gate 1: eligibility for Stock Token acquisition (mainnet only).
        if (network === 'mainnet' && isStockTokenAddress(to.address) && !config.acknowledgeEligibility) {
          return toError(
            `Buying the Stock Token ${to.symbol} requires eligibility acknowledgement.`,
            'Set HOOD_MCP_ACKNOWLEDGE_ELIGIBILITY=1 only if you are NOT a US/CA/UK/CH person. ' +
              'Stock Tokens are tokenized debt securities barred to US persons.',
          )
        }

        const quote = await quoteSwap(client, { tokenIn: ti.address, tokenOut: to.address, amountIn: amountInRaw })
        const bps = slippageBps ?? 50
        const minOut = (quote.amountOut * BigInt(10_000 - bps)) / 10_000n

        // Gate 2: value the spend and enforce caps. On mainnet, fail closed if
        // the spend cannot be valued (real money — never spend an unvaluable
        // asset under an automated cap). On testnet, assets are valueless play
        // money with no USD price, so an unvaluable spend counts as $0 notional
        // and the confirm gate below remains the real guard.
        const usd = await valueInUsd(client, ti, amountInRaw)
        let usdForCap: number
        if (usd === null) {
          if (network === 'mainnet') {
            return toError(
              `Cannot value ${amountIn} ${ti.symbol} in USD (no price route), so the spend cap cannot be enforced.`,
              'Swaps whose input has no USDG price route are blocked for safety on mainnet.',
            )
          }
          usdForCap = 0
        } else {
          usdForCap = usd
        }
        try {
          ledger.assertWithinCaps(usdForCap)
        } catch (capErr) {
          return toError(errMessage(capErr))
        }

        const preview = {
          action: 'swap',
          network,
          from: walletAddress,
          spend: `${amountIn} ${ti.symbol}`,
          spendValueUsd: usd === null ? null : round(usd, 4),
          spendValueNote: usd === null ? 'testnet — no USD price available' : undefined,
          receiveEstimate: `${formatUnits(quote.amountOut, to.decimals)} ${to.symbol}`,
          minReceived: `${formatUnits(minOut, to.decimals)} ${to.symbol}`,
          route: quote.route.path,
          slippageBps: bps,
          caps: {
            perCallUsd: config.maxSpendPerCallUsd,
            sessionRemainingUsd: round(ledger.sessionRemaining, 4),
          },
        }

        // Gate 3: confirm gate.
        if (confirm !== true) {
          return toResult({
            ...preview,
            confirmed: false,
            message:
              `SIMULATION ONLY — nothing was signed. To broadcast, call execute_swap again with the ` +
              `same arguments and confirm=true. This will send ${amountIn} ${ti.symbol} ($${round(usd, 4)}) ` +
              `from ${walletAddress}.`,
          })
        }

        const { hash, receipt, amountOutMinimum } = await executeSwap(
          client,
          { tokenIn: ti.address, tokenOut: to.address, amountIn: amountInRaw },
          { slippageBps: bps },
        )
        ledger.recordSpend(usd)
        return toResult({
          ...preview,
          confirmed: true,
          status: receipt.status,
          transactionHash: hash,
          amountOutMinimum: formatUnits(amountOutMinimum, to.decimals),
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          explorer: txLink(network, hash),
          sessionSpentUsd: round(ledger.spent, 4),
        })
      } catch (e) {
        if (e instanceof StockTokenEligibilityError) {
          return toError('Stock Token acquisition blocked by eligibility gate.', 'Set HOOD_MCP_ACKNOWLEDGE_ELIGIBILITY=1 only if eligible.')
        }
        if (e instanceof UnknownSymbolError) return toError(`Unknown token: ${e.message}`)
        if (e instanceof NoRouteError) return toError('No Uniswap route between those tokens.', e.message)
        return toError(`Swap failed: ${errMessage(e)}`)
      }
    },
  )

  // ------------------------------------------------------------ transfer_usdg
  server.registerTool(
    'transfer_usdg',
    {
      title: 'Transfer USDG (guarded)',
      description:
        'Send USDG to an address. First call returns a preview and requires confirm=true to ' +
        'broadcast. The amount is hard-capped in USD by the same spend limits.',
      inputSchema: {
        to: z.string().describe('Recipient address (0x…40 hex).'),
        amount: z.string().describe('Human USDG amount, e.g. "5.00".'),
        confirm: z.boolean().optional().describe('Must be true to actually broadcast. Omit/false to preview.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ to, amount, confirm }) => {
      if (!isAddress(to)) return toError(`"${to}" is not a valid 0x address.`)
      let amountRaw: bigint
      try {
        amountRaw = parseUsdg(amount)
      } catch {
        return toError(`"${amount}" is not a valid USDG amount.`)
      }
      if (amountRaw <= 0n) return toError('Amount must be greater than zero.')

      const usd = Number(amount)
      try {
        ledger.assertWithinCaps(usd)
      } catch (capErr) {
        return toError(errMessage(capErr))
      }

      const preview = {
        action: 'transfer',
        network,
        from: walletAddress,
        to,
        amount: `${amount} USDG`,
        valueUsd: round(usd, 4),
        caps: { perCallUsd: config.maxSpendPerCallUsd, sessionRemainingUsd: round(ledger.sessionRemaining, 4) },
      }

      if (confirm !== true) {
        return toResult({
          ...preview,
          confirmed: false,
          message:
            `SIMULATION ONLY — nothing was signed. To broadcast, call transfer_usdg again with the ` +
            `same arguments and confirm=true. This will send ${amount} USDG from ${walletAddress} to ${to}.`,
        })
      }

      try {
        const hash = await transferUsdg(client, to as Address, amountRaw)
        const receipt = await client.public.waitForTransactionReceipt({ hash })
        ledger.recordSpend(usd)
        return toResult({
          ...preview,
          confirmed: true,
          status: receipt.status,
          transactionHash: hash,
          blockNumber: receipt.blockNumber.toString(),
          explorer: txLink(network, hash),
          sessionSpentUsd: round(ledger.spent, 4),
        })
      } catch (e) {
        return toError(`Transfer failed: ${errMessage(e)}`)
      }
    },
  )
}
