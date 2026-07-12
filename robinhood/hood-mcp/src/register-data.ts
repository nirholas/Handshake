/**
 * Register every read-only data tool on an MCP server. Shared by the stdio and
 * Streamable-HTTP transports so both expose an identical tool surface.
 *
 * Every tool: a precise zod input schema, a one-line description an LLM can
 * route on, real upstream data, and a structured error on failure (never a
 * bare throw across the transport).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  getMultiplier,
  getPortfolio,
  getQuote,
  getRecentLaunches,
  getStockToken,
  getStockTokenByAddress,
  listPricedStockTokens,
  listStockTokens,
  quoteSwap,
  swapAddresses,
  getUsdgBalance,
  formatUsdg,
  watchLaunches,
  FeedNotFoundError,
  StaleFeedError,
  UnknownSymbolError,
  NoRouteError,
} from 'hoodchain'
import type { HoodClient, Launch, LaunchpadName } from 'hoodchain'
import { addressLink, errMessage, isAddress, round, toError, toResult, txLink } from './shared/format.js'
import {
  fetchBlockscoutStats,
  fetchChainTvl,
  fetchGtToken,
  fetchTokenMeta,
  fetchTokenPools,
  fetchTrendingPools,
  searchBlockscout,
  UpstreamError,
} from './shared/upstreams.js'
import type { GtPool } from './shared/upstreams.js'

const ONE_TOKEN = 10n ** 18n // 1 Stock Token, 18 decimals

/** Strip GeckoTerminal's `robinhood_` network prefix from a token id. */
function stripNetworkPrefix(id: string | undefined): string | null {
  if (!id) return null
  const i = id.indexOf('_')
  return i >= 0 ? id.slice(i + 1) : id
}

function numOrNull(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Register all data tools. `client` is a read-only hoodchain client and
 * `network` its network name (used for explorer links + testnet Blockscout).
 */
export function registerDataTools(server: McpServer, client: HoodClient): void {
  const network = client.network
  const chainId = client.chain.id

  // ---------------------------------------------------------- get_chain_stats
  server.registerTool(
    'get_chain_stats',
    {
      title: 'Robinhood Chain stats',
      description:
        'Live Robinhood Chain overview: latest block, gas price, TVL, and network totals ' +
        '(blocks, addresses, transactions, block time). No inputs.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const [blockR, gasR, tvlR, statsR] = await Promise.allSettled([
          client.public.getBlockNumber(),
          client.public.getGasPrice(),
          fetchChainTvl(),
          fetchBlockscoutStats(network),
        ])
        const stats = statsR.status === 'fulfilled' ? statsR.value : null
        return toResult({
          network,
          chainId,
          latestBlock: blockR.status === 'fulfilled' ? blockR.value.toString() : null,
          gasPriceWei: gasR.status === 'fulfilled' ? gasR.value.toString() : null,
          gasPriceGwei: gasR.status === 'fulfilled' ? round(Number(gasR.value) / 1e9, 4) : null,
          tvlUsd: tvlR.status === 'fulfilled' ? tvlR.value : null,
          blockscout: stats
            ? {
                averageBlockTimeMs: stats.average_block_time,
                totalBlocks: stats.total_blocks,
                totalAddresses: stats.total_addresses,
                totalTransactions: stats.total_transactions,
                transactionsToday: stats.transactions_today,
                gasPrices: stats.gas_prices,
                ethPriceUsd: numOrNull(stats.coin_price),
              }
            : null,
          sources: ['robinhood-chain-rpc', 'defillama', 'blockscout'],
          asOf: new Date().toISOString(),
        })
      } catch (e) {
        return toError(`Failed to read chain stats: ${errMessage(e)}`)
      }
    },
  )

  // -------------------------------------------------------- list_stock_tokens
  server.registerTool(
    'list_stock_tokens',
    {
      title: 'List Stock Tokens',
      description:
        'The registry of tokenized-equity Stock Tokens on Robinhood Chain (ticker, name, ' +
        'contract, Chainlink feed). Set pricedOnly to return only tokens with a live feed.',
      inputSchema: {
        pricedOnly: z.boolean().optional().describe('Only tokens with a Chainlink price feed.'),
        limit: z.number().int().positive().max(200).optional().describe('Max entries (default all).'),
        offset: z.number().int().nonnegative().optional().describe('Skip this many (pagination).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pricedOnly, limit, offset }) => {
      const all = pricedOnly ? listPricedStockTokens() : listStockTokens()
      const start = offset ?? 0
      const slice = all.slice(start, limit ? start + limit : undefined)
      return toResult({
        network,
        total: all.length,
        returned: slice.length,
        offset: start,
        tokens: slice.map((t) => ({
          symbol: t.symbol,
          name: t.name,
          address: t.address,
          decimals: t.decimals,
          hasFeed: t.feed !== null,
          feed: t.feed,
          explorer: addressLink(network, t.address),
        })),
      })
    },
  )

  // ---------------------------------------------------------- get_stock_quote
  server.registerTool(
    'get_stock_quote',
    {
      title: 'Get Stock Token quote',
      description:
        'Price a Stock Token by ticker: the Chainlink oracle price, the on-chain Uniswap ' +
        'DEX mid price, the premium/discount between them, and the ERC-8056 multiplier ' +
        '(so you also get the underlying share price).',
      inputSchema: {
        symbol: z.string().min(1).describe('Ticker, e.g. "AAPL" or "TSLA" (case-insensitive).'),
        maxAgeSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Reject the Chainlink answer if older than this (default 3 days; 24/5 feeds).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, maxAgeSeconds }) => {
      let token
      try {
        token = getStockToken(symbol)
      } catch (e) {
        if (e instanceof UnknownSymbolError) {
          return toError(
            `"${symbol}" is not a Stock Token on Robinhood Chain.`,
            'Call list_stock_tokens to see valid tickers.',
          )
        }
        return toError(errMessage(e))
      }

      // Chainlink price (independent of DEX so a stale feed still returns DEX data).
      let chainlink: Record<string, unknown> | null = null
      let chainlinkError: string | null = null
      try {
        const q = await getQuote(client, symbol, maxAgeSeconds ? { maxAgeSeconds } : {})
        chainlink = {
          priceUsd: round(q.priceUsd, 6),
          feed: q.feed,
          roundId: q.roundId.toString(),
          updatedAt: q.updatedAt,
          ageSeconds: q.ageSeconds,
        }
      } catch (e) {
        if (e instanceof FeedNotFoundError) chainlinkError = `no Chainlink feed for ${token.symbol}`
        else if (e instanceof StaleFeedError) chainlinkError = e.message
        else chainlinkError = errMessage(e)
      }

      // ERC-8056 multiplier → underlying share price.
      const multiplier = await getMultiplier(client, symbol)
      const chainlinkPrice = chainlink ? (chainlink.priceUsd as number) : null
      const underlyingSharePriceUsd =
        chainlinkPrice !== null && multiplier && multiplier > 0n
          ? round(chainlinkPrice / (Number(multiplier) / 1e18), 6)
          : null

      // On-chain DEX mid: quote 1 token -> USDG.
      let dexPriceUsd: number | null = null
      let dexError: string | null = null
      try {
        const { usdg } = swapAddresses(client)
        const dq = await quoteSwap(client, { tokenIn: token.address, tokenOut: usdg, amountIn: ONE_TOKEN })
        dexPriceUsd = round(Number(dq.amountOut) / 1e6, 6) // USDG is 6 decimals
      } catch (e) {
        dexError = e instanceof NoRouteError ? 'no Uniswap route to USDG (may trade on Arcus only)' : errMessage(e)
      }

      const premiumPct =
        chainlinkPrice !== null && dexPriceUsd !== null && chainlinkPrice > 0
          ? round(((dexPriceUsd - chainlinkPrice) / chainlinkPrice) * 100, 4)
          : null

      return toResult({
        symbol: token.symbol,
        name: token.name,
        address: token.address,
        network,
        chainlink,
        chainlinkError,
        dexPriceUsd,
        dexError,
        premiumPct,
        premiumNote:
          premiumPct === null
            ? 'premium requires both a Chainlink and a DEX price'
            : 'positive = DEX trades above oracle',
        uiMultiplier: multiplier ? multiplier.toString() : null,
        underlyingSharePriceUsd,
        explorer: addressLink(network, token.address),
        sources: ['chainlink', 'uniswap-v3', 'robinhood-chain-rpc'],
        asOf: new Date().toISOString(),
        disclosure:
          'Stock Tokens are tokenized debt securities (Robinhood Assets (Jersey) Ltd) and may not be ' +
          'offered, sold, or delivered to US persons. This tool is read-only data.',
      })
    },
  )

  // ------------------------------------------------------------- get_portfolio
  server.registerTool(
    'get_portfolio',
    {
      title: 'Get Stock Token portfolio',
      description:
        'Multiplier-correct Stock Token portfolio for any address: per-position token balance, ' +
        'ERC-8056 share-equivalent, USD value, plus the USDG cash balance. Read-only.',
      inputSchema: {
        address: z.string().describe('Wallet address (0x…40 hex) to value.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address }) => {
      if (!isAddress(address)) return toError(`"${address}" is not a valid 0x address.`)
      try {
        const [portfolio, usdgRaw] = await Promise.all([
          getPortfolio(client, address),
          getUsdgBalance(client, address),
        ])
        return toResult({
          owner: portfolio.owner,
          network,
          usdgBalance: formatUsdg(usdgRaw),
          totalStockValueUsd: round(portfolio.totalUsd, 2),
          positionCount: portfolio.positions.length,
          positions: portfolio.positions.map((p) => ({
            symbol: p.symbol,
            address: p.address,
            balanceTokens: round(p.balanceTokens, 8),
            shareEquivalent: round(p.shareEquivalent, 8),
            uiMultiplier: p.uiMultiplier.toString(),
            priceUsd: p.quote ? round(p.quote.priceUsd, 6) : null,
            valueUsd: p.valueUsd === null ? null : round(p.valueUsd, 2),
          })),
          unpricedSymbols: portfolio.unpricedSymbols,
          explorer: addressLink(network, portfolio.owner),
          note: 'valueUsd = balance × feed price (feeds are already multiplier-adjusted; not double-counted).',
          asOf: new Date().toISOString(),
        })
      } catch (e) {
        return toError(`Failed to read portfolio: ${errMessage(e)}`)
      }
    },
  )

  // ----------------------------------------------------------------- get_coin
  server.registerTool(
    'get_coin',
    {
      title: 'Get token / memecoin detail',
      description:
        'Detail for any Robinhood Chain token by contract address: price, 24h volume, ' +
        'liquidity, FDV, holder count, and whether it is a registered Stock Token.',
      inputSchema: {
        address: z.string().describe('Token contract address (0x…40 hex).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address }) => {
      if (!isAddress(address)) return toError(`"${address}" is not a valid 0x address.`)
      try {
        const [metaR, gtR, poolsR] = await Promise.allSettled([
          fetchTokenMeta(network, address),
          fetchGtToken(address),
          fetchTokenPools(address),
        ])
        const meta = metaR.status === 'fulfilled' ? metaR.value : null
        const gt = gtR.status === 'fulfilled' ? gtR.value : null
        const pools = poolsR.status === 'fulfilled' ? poolsR.value : []
        const topPool = pools[0] ?? null
        const stockToken = getStockTokenByAddress(address as `0x${string}`)

        if (!meta && !gt && !topPool) {
          return toError(`No token found at ${address} on Robinhood Chain ${network}.`)
        }

        return toResult({
          address,
          network,
          name: meta?.name ?? gt?.name ?? null,
          symbol: meta?.symbol ?? gt?.symbol ?? null,
          decimals: meta?.decimals ? Number(meta.decimals) : (gt?.decimals ?? null),
          priceUsd: numOrNull(gt?.price_usd) ?? numOrNull(topPool?.attributes.base_token_price_usd),
          fdvUsd: numOrNull(gt?.fdv_usd) ?? numOrNull(topPool?.attributes.fdv_usd),
          marketCapUsd: numOrNull(meta?.circulating_market_cap) ?? numOrNull(topPool?.attributes.market_cap_usd),
          volume24hUsd: numOrNull(gt?.volume_usd?.h24) ?? numOrNull(topPool?.attributes.volume_usd?.h24),
          liquidityUsd: numOrNull(gt?.total_reserve_in_usd) ?? numOrNull(topPool?.attributes.reserve_in_usd),
          holders: meta?.holders_count ? Number(meta.holders_count) : null,
          totalSupply: meta?.total_supply ?? gt?.total_supply ?? null,
          isStockToken: stockToken !== null,
          stockToken: stockToken ? { symbol: stockToken.symbol, name: stockToken.name, feed: stockToken.feed } : null,
          topPool: topPool
            ? { name: topPool.attributes.name, address: topPool.attributes.address, dex: topPool.relationships?.dex?.data?.id ?? null }
            : null,
          poolCount: pools.length,
          explorer: addressLink(network, address),
          sources: ['blockscout', 'geckoterminal', 'hoodchain-registry'],
          asOf: new Date().toISOString(),
        })
      } catch (e) {
        return toError(`Failed to read token: ${errMessage(e)}`)
      }
    },
  )

  // ----------------------------------------------------- list_trending_coins
  server.registerTool(
    'list_trending_coins',
    {
      title: 'List trending coins',
      description:
        'The trending pools on Robinhood Chain right now (memecoins and stocks) with price, ' +
        '24h volume, price change, and liquidity — the pulse of the chain.',
      inputSchema: {
        limit: z.number().int().positive().max(30).optional().describe('How many (default 10, max 30).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      try {
        const pools = await fetchTrendingPools(limit ?? 10)
        return toResult({
          network,
          count: pools.length,
          coins: pools.map((p: GtPool) => ({
            poolName: p.attributes.name,
            poolAddress: p.attributes.address,
            baseTokenAddress: stripNetworkPrefix(p.relationships?.base_token?.data?.id),
            quoteTokenAddress: stripNetworkPrefix(p.relationships?.quote_token?.data?.id),
            priceUsd: numOrNull(p.attributes.base_token_price_usd),
            priceChange24hPct: numOrNull(p.attributes.price_change_percentage?.h24),
            volume24hUsd: numOrNull(p.attributes.volume_usd?.h24),
            liquidityUsd: numOrNull(p.attributes.reserve_in_usd),
            fdvUsd: numOrNull(p.attributes.fdv_usd),
            buys24h: p.attributes.transactions?.h24?.buys ?? null,
            sells24h: p.attributes.transactions?.h24?.sells ?? null,
            createdAt: p.attributes.pool_created_at,
          })),
          source: 'geckoterminal',
          asOf: new Date().toISOString(),
        })
      } catch (e) {
        if (e instanceof UpstreamError && /HTTP 429/.test(e.message)) {
          return toError('GeckoTerminal rate limit hit.', 'Retry in ~60s (public free tier is ~30 req/min).')
        }
        return toError(`Failed to read trending coins: ${errMessage(e)}`)
      }
    },
  )

  // --------------------------------------------------------- get_recent_launches
  server.registerTool(
    'get_recent_launches',
    {
      title: 'Recent launchpad launches',
      description:
        'Recently launched tokens on Robinhood Chain launchpads (NOXA and The Odyssey), ' +
        'newest first, scanned from on-chain logs.',
      inputSchema: {
        lookbackBlocks: z
          .number()
          .int()
          .positive()
          .max(500_000)
          .optional()
          .describe('Blocks to scan back (~30k ≈ 1h; default 30000).'),
        launchpad: z.enum(['noxa', 'odyssey']).optional().describe('Restrict to one launchpad.'),
        limit: z.number().int().positive().max(100).optional().describe('Max launches to return (default 25).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ lookbackBlocks, launchpad, limit }) => {
      try {
        const launches = await getRecentLaunches(client, {
          lookbackBlocks: lookbackBlocks ? BigInt(lookbackBlocks) : undefined,
          launchpad: launchpad as LaunchpadName | undefined,
        })
        const newestFirst = [...launches].reverse().slice(0, limit ?? 25)
        return toResult({
          network,
          scannedBlocks: lookbackBlocks ?? 30_000,
          count: newestFirst.length,
          launches: newestFirst.map((l) => launchJson(l, network)),
          asOf: new Date().toISOString(),
        })
      } catch (e) {
        return toError(`Failed to scan launches: ${errMessage(e)}`)
      }
    },
  )

  // ------------------------------------------------------------ watch_launches
  server.registerTool(
    'watch_launches',
    {
      title: 'Watch for live launches',
      description:
        'Watch NOXA + The Odyssey live for new token launches, blocking up to waitSeconds ' +
        '(or until limit launches are seen), then returns what appeared. Falls back to the ' +
        'most recent launch if none fire in the window.',
      inputSchema: {
        waitSeconds: z.number().int().positive().max(120).optional().describe('How long to watch (default 20, max 120).'),
        launchpad: z.enum(['noxa', 'odyssey']).optional().describe('Restrict to one launchpad.'),
        limit: z.number().int().positive().max(50).optional().describe('Stop early after this many (default 20).'),
        includeRecentIfEmpty: z
          .boolean()
          .optional()
          .describe('If nothing launches in the window, return the latest recent launch (default true).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ waitSeconds, launchpad, limit, includeRecentIfEmpty }) => {
      const seconds = waitSeconds ?? 20
      const max = limit ?? 20
      const seen: Launch[] = []
      try {
        await new Promise<void>((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            unwatch()
            clearTimeout(timer)
            resolve()
          }
          const unwatch = watchLaunches(
            client,
            (l) => {
              seen.push(l)
              if (seen.length >= max) finish()
            },
            { launchpad: launchpad as LaunchpadName | undefined, onError: () => {} },
          )
          const timer = setTimeout(finish, seconds * 1000)
        })

        let source: 'live' | 'recent-fallback' = 'live'
        let launches = seen
        if (seen.length === 0 && (includeRecentIfEmpty ?? true)) {
          const recent = await getRecentLaunches(client, {
            lookbackBlocks: 60_000n,
            launchpad: launchpad as LaunchpadName | undefined,
          })
          launches = recent.slice(-1)
          source = 'recent-fallback'
        }
        return toResult({
          network,
          watchedSeconds: seconds,
          source,
          count: launches.length,
          launches: launches.map((l) => launchJson(l, network)),
          note:
            source === 'recent-fallback'
              ? 'No launch fired during the window; showing the most recent launch instead.'
              : 'Launches observed live during the watch window.',
          asOf: new Date().toISOString(),
        })
      } catch (e) {
        return toError(`Watch failed: ${errMessage(e)}`)
      }
    },
  )

  // ------------------------------------------------------------- search_token
  server.registerTool(
    'search_token',
    {
      title: 'Search tokens',
      description:
        'Find tokens on Robinhood Chain by ticker, name, or contract address — searches the ' +
        'Stock Token registry and the Blockscout index together.',
      inputSchema: {
        query: z.string().min(1).describe('Ticker, name fragment, or 0x address.'),
        limit: z.number().int().positive().max(50).optional().describe('Max results (default 20).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      const cap = limit ?? 20
      const byAddress = new Map<string, Record<string, unknown>>()
      const add = (row: Record<string, unknown>) => {
        const key = String(row.address).toLowerCase()
        if (!byAddress.has(key)) byAddress.set(key, row)
      }

      // 1. Registry matches (ticker/name/address).
      const q = query.toLowerCase()
      for (const t of listStockTokens()) {
        if (
          t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.address.toLowerCase() === q
        ) {
          add({
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            type: 'stock-token',
            isStockToken: true,
            verified: true,
            explorer: addressLink(network, t.address),
          })
        }
      }

      // 2. Blockscout index (tokens/contracts).
      try {
        const items = await searchBlockscout(network, query)
        for (const it of items) {
          const addr = it.address_hash ?? it.address
          if (!addr) continue
          add({
            address: addr,
            symbol: it.symbol ?? null,
            name: it.name ?? null,
            type: it.token_type ? 'token' : (it.type ?? 'address'),
            isStockToken: getStockTokenByAddress(addr as `0x${string}`) !== null,
            verified: Boolean(it.is_smart_contract_verified),
            marketCapUsd: numOrNull(it.circulating_market_cap),
            explorer: addressLink(network, addr),
          })
        }
      } catch (e) {
        // Registry results still return even if Blockscout is unavailable.
        if (byAddress.size === 0) return toError(`Search failed: ${errMessage(e)}`)
      }

      const results = [...byAddress.values()].slice(0, cap)
      return toResult({
        network,
        query,
        count: results.length,
        results,
        sources: ['hoodchain-registry', 'blockscout'],
        asOf: new Date().toISOString(),
      })
    },
  )
}

/** Serialize a launch with explorer links. */
function launchJson(l: Launch, network: HoodClient['network']) {
  return {
    launchpad: l.launchpad,
    token: l.token,
    creator: l.creator,
    pool: l.pool,
    blockNumber: l.blockNumber.toString(),
    transactionHash: l.transactionHash,
    tokenExplorer: addressLink(network, l.token),
    txExplorer: txLink(network, l.transactionHash),
  }
}
