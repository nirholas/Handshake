/**
 * hood-js — the "just works" layer over the Robinhood Chain SDK.
 *
 * One import, sensible defaults, promise-first, browser and Node. Public RPC
 * by default; no config required to read prices, portfolios, and trending
 * coins. Think `axios` to hoodchain's `http`.
 *
 * @example
 * ```js
 * import hood from 'hood-js'
 * const { usd } = await hood.price('AAPL')
 * ```
 *
 * @packageDocumentation
 */
import {
  aggregatorV3Abi,
  executeSwap,
  FEED_DECIMALS,
  getPortfolio,
  getQuote,
  getStockToken,
  getRecentLaunches,
  MAINNET_EXPLORER_URL,
  quoteSwap,
  watchLaunches,
  type HoodClient,
  type Launch,
  type LaunchpadName,
} from 'hoodchain'
import { formatUnits, isAddress, parseUnits, type Account, type Address, type Transport } from 'viem'
import { custom } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { coins, type CoinsOptions, type TrendingCoin } from './coins.js'
import { badInput, friendly, HoodError, toHoodError, type HoodErrorCode } from './errors.js'
import { resolveToken, type TokenRef } from './tokens.js'
import {
  configure,
  currentNetwork,
  readClient,
  setNetwork,
  writeClient,
  type HoodConfig,
} from './state.js'

const TESTNET_EXPLORER_URL = 'https://explorer.testnet.chain.robinhood.com'

function explorerBase(client: HoodClient): string {
  return client.network === 'testnet' ? TESTNET_EXPLORER_URL : MAINNET_EXPLORER_URL
}

// ---------------------------------------------------------------------------
// prices
// ---------------------------------------------------------------------------

/** A single Stock Token price. */
export interface Price {
  symbol: string
  /** Price of one token in USD, or `null` when the token has no live feed. */
  usd: number | null
  /** When the Chainlink feed last updated, or `null` when unpriced. */
  updatedAt: Date | null
}

/**
 * The live USD price of one Robinhood Chain Stock Token.
 *
 * @example
 * ```js
 * const { symbol, usd, updatedAt } = await hood.price('TSLA')
 * ```
 */
async function price(symbol: string): Promise<Price> {
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    badInput('price(symbol) needs a ticker string like "AAPL".')
  }
  return friendly(async () => {
    const q = await getQuote(readClient(), symbol)
    return { symbol: q.symbol, usd: q.priceUsd, updatedAt: new Date(q.updatedAt * 1000) }
  })
}

/**
 * Live USD prices for many Stock Tokens in one batched multicall. Order is
 * preserved; tokens without a Chainlink feed come back with `usd: null`
 * instead of throwing.
 *
 * @example
 * ```js
 * const [aapl, tsla] = await hood.prices(['AAPL', 'TSLA'])
 * ```
 */
async function prices(symbols: string[]): Promise<Price[]> {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    badInput('prices([symbols]) needs a non-empty array of tickers.')
  }
  return friendly(async () => {
    const client = readClient()
    const entries = symbols.map((s) => {
      if (typeof s !== 'string' || s.trim() === '') badInput('Every symbol must be a non-empty string.')
      const token = getStockToken(s)
      return {
        symbol: token.symbol,
        feed: token.feed,
        feedDecimals: token.feedDecimals ?? FEED_DECIMALS,
      }
    })

    const withFeed = entries.filter((e): e is typeof e & { feed: Address } => e.feed !== null)
    const results =
      withFeed.length > 0
        ? await client.public.multicall({
            contracts: withFeed.map((e) => ({
              address: e.feed,
              abi: aggregatorV3Abi,
              functionName: 'latestRoundData' as const,
            })),
            allowFailure: true,
          })
        : []

    const priced = new Map<string, { usd: number; updatedAt: Date }>()
    withFeed.forEach((e, i) => {
      const r = results[i]
      if (!r || r.status !== 'success') return
      const [, answer, , updatedAt] = r.result as readonly [bigint, bigint, bigint, bigint, bigint]
      if (answer <= 0n || updatedAt === 0n) return
      priced.set(e.symbol, {
        usd: Number(formatUnits(answer, e.feedDecimals)),
        updatedAt: new Date(Number(updatedAt) * 1000),
      })
    })

    return entries.map((e) => {
      const p = priced.get(e.symbol)
      return { symbol: e.symbol, usd: p ? p.usd : null, updatedAt: p ? p.updatedAt : null }
    })
  })
}

// ---------------------------------------------------------------------------
// portfolio
// ---------------------------------------------------------------------------

/** One holding inside a {@link PortfolioResult}. */
export interface PortfolioPosition {
  symbol: string
  address: Address
  /** Raw token balance (float). */
  tokens: number
  /** Multiplier-correct share-equivalent units (ERC-8056 `uiMultiplier`). */
  shares: number
  /** Feed price per token in USD, or `null` when unpriced. */
  price: number | null
  /** USD value of the position, or `null` when unpriced. */
  usd: number | null
}

/** Result of {@link portfolio}. */
export interface PortfolioResult {
  owner: Address
  /** Total USD value across priceable positions. */
  totalUsd: number
  positions: PortfolioPosition[]
  /** Symbols held but not priceable (no feed / stale feed). */
  unpriced: string[]
}

/**
 * Every Stock Token position for a wallet, multiplier-corrected and
 * USD-valued in one multicall sweep.
 *
 * @example
 * ```js
 * const { totalUsd, positions } = await hood.portfolio('0xabc…')
 * ```
 */
async function portfolio(address: string): Promise<PortfolioResult> {
  if (typeof address !== 'string' || !isAddress(address)) {
    badInput('portfolio(address) needs a 0x wallet address.')
  }
  return friendly(async () => {
    const p = await getPortfolio(readClient(), address as Address)
    return {
      owner: p.owner,
      totalUsd: p.totalUsd,
      positions: p.positions.map((pos) => ({
        symbol: pos.symbol,
        address: pos.address,
        tokens: pos.balanceTokens,
        shares: pos.shareEquivalent,
        price: pos.quote ? pos.quote.priceUsd : null,
        usd: pos.valueUsd,
      })),
      unpriced: p.unpricedSymbols,
    }
  })
}

// ---------------------------------------------------------------------------
// launches
// ---------------------------------------------------------------------------

/** A decoded launchpad token launch (friendly shape). */
export interface LaunchEvent {
  launchpad: LaunchpadName
  /** New token contract address. */
  token: Address
  /** Wallet that launched it. */
  creator: Address
  /** Uniswap pool (immediate for NOXA; `null` for Odyssey pre-graduation). */
  pool: Address | null
  /** Block number of the launch. */
  block: number
  /** Launch transaction hash. */
  tx: `0x${string}`
  /** Explorer link to the token. */
  url: string
}

/** Options for {@link launches}. */
export interface LaunchesOptions {
  /** Restrict to one launchpad. Defaults to both NOXA and The Odyssey. */
  launchpad?: LaunchpadName
  /** Stream new launches live via the callback. Requires a callback argument. */
  live?: boolean
  /** For the historical (non-live) call: how many blocks back to scan. */
  lookbackBlocks?: bigint
  /** Poll interval in ms for the live watcher. @defaultValue `2000` */
  pollingInterval?: number
  /** Called when the live watcher errors (it keeps polling). */
  onError?: (error: HoodError) => void
}

/** Callback for streaming launches. */
export type LaunchCallback = (launch: LaunchEvent) => void

function decorateLaunch(client: HoodClient, l: Launch): LaunchEvent {
  return {
    launchpad: l.launchpad,
    token: l.token,
    creator: l.creator,
    pool: l.pool,
    block: Number(l.blockNumber),
    tx: l.transactionHash,
    url: `${explorerBase(client)}/token/${l.token}`,
  }
}

/**
 * New launchpad coins — either the recent history (returns a Promise) or a
 * live stream (pass a callback, returns an unwatch function).
 *
 * @example Recent launches
 * ```js
 * const recent = await hood.launches()
 * ```
 * @example Live stream
 * ```js
 * const stop = hood.launches({ live: true }, (coin) => console.log(coin.token))
 * // later: stop()
 * ```
 */
function launches(callback: LaunchCallback): () => void
function launches(options: LaunchesOptions, callback: LaunchCallback): () => void
function launches(options?: LaunchesOptions): Promise<LaunchEvent[]>
function launches(
  a?: LaunchesOptions | LaunchCallback,
  b?: LaunchCallback,
): Promise<LaunchEvent[]> | (() => void) {
  let options: LaunchesOptions = {}
  let callback: LaunchCallback | undefined
  if (typeof a === 'function') callback = a
  else if (a && typeof a === 'object') options = a
  if (typeof b === 'function') callback = b

  const client = readClient()

  if (options.live && !callback) {
    badInput('launches({ live: true }, cb) needs a callback to stream to.')
  }

  if (callback) {
    const cb = callback
    return watchLaunches(client, (l) => cb(decorateLaunch(client, l)), {
      launchpad: options.launchpad,
      pollingInterval: options.pollingInterval,
      onError: options.onError ? (e) => options.onError!(toHoodError(e)) : undefined,
    })
  }

  return friendly(async () => {
    const list = await getRecentLaunches(client, {
      lookbackBlocks: options.lookbackBlocks,
      launchpad: options.launchpad,
    })
    return list.map((l) => decorateLaunch(client, l))
  })
}

// ---------------------------------------------------------------------------
// quote & swap
// ---------------------------------------------------------------------------

/** Internal payload {@link quote} embeds so {@link swap} can execute it. */
interface QuoteRaw {
  network: 'mainnet' | 'testnet'
  tokenIn: Address
  tokenOut: Address
  amountIn: string
  buyDecimals: number
  sellLabel: string
  buyLabel: string
}

/** A swap quote. Spread it straight into {@link swap} with a `wallet`. */
export interface Quote {
  /** Input token label. */
  sell: string
  /** Output token label. */
  buy: string
  /** Human input amount. */
  sellAmount: string
  /** Human output amount at the quoted price. */
  buyAmount: string
  /** Output per input unit. */
  rate: number
  /** Token path `[in, …hops, out]`. */
  route: Address[]
  /** Internal execution payload — carried for {@link swap}; do not edit. */
  _raw: QuoteRaw
}

function normalizeAmount(amount: number | string): string {
  const str = typeof amount === 'number' ? amount.toString() : String(amount).trim()
  if (!/^\d+(\.\d+)?$/.test(str) || Number(str) <= 0) {
    badInput(`Amount must be a positive number (got "${amount}").`)
  }
  return str
}

/**
 * Quote a swap without a wallet. `sell`/`buy` accept a Stock Token ticker,
 * `"USDG"` / `"WETH"`, or any `0x` token address. `amount` is human units of
 * the sell token.
 *
 * @example
 * ```js
 * const q = await hood.quote({ sell: 'USDG', buy: 'CASHCAT', amount: 100 })
 * console.log(`Get ${q.buyAmount} CASHCAT`)
 * ```
 */
async function quote(args: { sell: TokenRef; buy: TokenRef; amount: number | string }): Promise<Quote> {
  if (!args || args.sell == null || args.buy == null || args.amount == null) {
    badInput('quote needs { sell, buy, amount }.')
  }
  const amountStr = normalizeAmount(args.amount)
  return friendly(async () => {
    const client = readClient()
    const tokenIn = await resolveToken(client, args.sell)
    const tokenOut = await resolveToken(client, args.buy)
    const amountIn = parseUnits(amountStr, tokenIn.decimals)
    const q = await quoteSwap(client, {
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn,
    })
    const buyAmount = formatUnits(q.amountOut, tokenOut.decimals)
    const rate = Number(amountStr) > 0 ? Number(buyAmount) / Number(amountStr) : 0
    return {
      sell: tokenIn.label,
      buy: tokenOut.label,
      sellAmount: amountStr,
      buyAmount,
      rate,
      route: q.route.path,
      _raw: {
        network: client.network,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountIn.toString(),
        buyDecimals: tokenOut.decimals,
        sellLabel: tokenIn.label,
        buyLabel: tokenOut.label,
      },
    }
  })
}

/** A wallet for {@link swap}: a `0x` private key (Node) or EIP-1193 provider. */
export type WalletInput = `0x${string}` | { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

/** Result of a settled {@link swap}. */
export interface SwapResult {
  /** Swap transaction hash. */
  hash: `0x${string}`
  /** Explorer link to the transaction. */
  url: string
  sold: string
  bought: string
  /** Quoted output amount (human units). */
  amountOut: string
  /** Slippage-protected minimum that was enforced on-chain. */
  minReceived: string
  /** Receipt status. */
  status: 'success' | 'reverted'
}

/** Parameters for {@link swap}: a quote spread in, plus a wallet. */
export type SwapParams = Partial<Quote> & {
  wallet: WalletInput
  /** Re-quote inline instead of spreading a quote. */
  sell?: TokenRef
  buy?: TokenRef
  amount?: number | string
  /** Slippage tolerance in percent (e.g. `0.5`). Defaults to 0.5%. */
  slippage?: number
  /** Slippage in basis points; overrides `slippage`. */
  slippageBps?: number
  /** Recipient of the output tokens. Defaults to the wallet address. */
  recipient?: Address
}

async function resolveWallet(wallet: WalletInput): Promise<{ account: Account; transport?: Transport }> {
  if (typeof wallet === 'string') {
    if (!/^0x[0-9a-fA-F]{64}$/.test(wallet)) {
      badInput('A string wallet must be a 0x-prefixed 32-byte private key.')
    }
    return { account: privateKeyToAccount(wallet) }
  }
  if (wallet && typeof wallet.request === 'function') {
    const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as Address[]
    const address = accounts?.[0]
    if (!address) badInput('The injected wallet returned no account. Connect it first.')
    // viem accepts a bare address as a JSON-RPC account on a wallet client.
    return { account: address as unknown as Account, transport: custom(wallet) }
  }
  return badInput('wallet must be a 0x private key or an EIP-1193 provider.')
}

/**
 * Execute a swap. Spread a {@link quote} in and add a `wallet`, or pass
 * `{ sell, buy, amount, wallet }` to quote and swap in one call.
 *
 * Buying a Stock Token requires `hood.config({ acknowledgeEligibility: true })`
 * first (US persons are barred). Approvals are handled automatically.
 *
 * @example
 * ```js
 * const q = await hood.quote({ sell: 'USDG', buy: 'CASHCAT', amount: 100 })
 * const { hash, url } = await hood.swap({ ...q, wallet: process.env.PK })
 * ```
 */
async function swap(params: SwapParams): Promise<SwapResult> {
  if (!params || !('wallet' in params)) badInput('swap needs { ...quote, wallet }.')
  return friendly(async () => {
    const { account, transport } = await resolveWallet(params.wallet)

    let raw = params._raw
    if (!raw) {
      if (params.sell == null || params.buy == null || params.amount == null) {
        badInput('swap needs a quote (spread hood.quote(...)) or { sell, buy, amount }.')
      }
      const q = await quote({ sell: params.sell, buy: params.buy, amount: params.amount })
      raw = q._raw
    }

    if (raw.network !== currentNetwork()) {
      badInput(
        `This quote was made for ${raw.network} but hood is now on ${currentNetwork()}. Re-quote after switching networks.`,
      )
    }

    const client = writeClient(account, transport)
    const slippageBps =
      params.slippageBps ?? (params.slippage != null ? Math.round(params.slippage * 100) : undefined)

    const result = await executeSwap(
      client,
      { tokenIn: raw.tokenIn, tokenOut: raw.tokenOut, amountIn: BigInt(raw.amountIn) },
      { slippageBps, recipient: params.recipient },
    )

    return {
      hash: result.hash,
      url: `${explorerBase(client)}/tx/${result.hash}`,
      sold: raw.sellLabel,
      bought: raw.buyLabel,
      amountOut: formatUnits(result.quote.amountOut, raw.buyDecimals),
      minReceived: formatUnits(result.amountOutMinimum, raw.buyDecimals),
      status: result.receipt.status,
    }
  })
}

// ---------------------------------------------------------------------------
// config & network
// ---------------------------------------------------------------------------

/** The hood-js facade. The default export. */
export interface Hood {
  price: typeof price
  prices: typeof prices
  portfolio: typeof portfolio
  coins: (options?: CoinsOptions) => Promise<TrendingCoin[]>
  launches: typeof launches
  quote: typeof quote
  swap: typeof swap
  /** Point every subsequent call at the given options. Chainable. */
  config: (config: HoodConfig) => Hood
  /** Flip every call to testnet (chain 46630). Chainable. */
  testnet: () => Hood
  /** Flip every call back to mainnet (chain 4663). Chainable. */
  mainnet: () => Hood
}

const hood: Hood = {
  price,
  prices,
  portfolio,
  coins,
  launches,
  quote,
  swap,
  config(config: HoodConfig) {
    configure(config)
    return hood
  },
  testnet() {
    setNetwork('testnet')
    return hood
  },
  mainnet() {
    setNetwork('mainnet')
    return hood
  },
}

export default hood

// Named exports for TypeScript consumers and error handling.
export { HoodError }
export type { HoodErrorCode, HoodConfig, CoinsOptions, TrendingCoin, TokenRef }
