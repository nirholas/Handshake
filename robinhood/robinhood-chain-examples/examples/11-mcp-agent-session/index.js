/**
 * 11 — MCP agent session: drive Robinhood Chain through the Model Context Protocol.
 *
 * Every other example in this repo imports `hoodchain` directly. An LLM agent
 * cannot do that: it can only call tools its host has been given. `hood-mcp` is
 * the bridge — an MCP server that exposes the same chain reads as protocol
 * tools, so Claude Code, Claude Desktop, Cursor, or any MCP-speaking host can
 * ask Robinhood Chain questions without a line of chain code.
 *
 * This file is the client half of that conversation, written out longhand:
 * spawn the real `hood-mcp` data server over stdio, complete the MCP
 * initialize handshake, list the tools it advertises, then call three of them
 * and print what comes back. It is exactly what an agent host does internally,
 * with the protocol traffic made visible.
 *
 *   node index.js                 # handshake + tool list + three real calls
 *   node index.js --symbol TSLA   # price a different Stock Token
 *   node index.js --list-only     # stop after the tool inventory
 *
 * Reads only. No wallet, no key, no funds: every tool used here is annotated
 * `readOnlyHint: true` on the server, and the trading tools live in a separate
 * server binary you have to opt into. Nothing in the output is fabricated; if
 * the RPC is unreachable the tool returns an error and this script prints it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)

/** Parse `--flag value` / `--flag` pairs out of argv. */
function parseArgs(argv) {
  const args = { symbol: 'AAPL', listOnly: false, network: 'mainnet' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--symbol') args.symbol = argv[++i] ?? args.symbol
    else if (arg === '--network') args.network = argv[++i] ?? args.network
    else if (arg === '--list-only') args.listOnly = true
  }
  return args
}

/**
 * Resolve the hood-mcp data server entry point.
 *
 * Prefers the installed package (`npm install` puts it in node_modules), and
 * falls back to a sibling checkout so the example still runs in this monorepo
 * before hood-mcp is installed from npm.
 */
function resolveServerEntry() {
  try {
    return require.resolve('hood-mcp/data-server')
  } catch {
    const local = new URL('../../../hood-mcp/dist/data-server.js', import.meta.url)
    return local.pathname
  }
}

/** Tool results arrive as content blocks; hood-mcp returns one JSON text block. */
function readToolJson(result) {
  const block = result?.content?.find((c) => c.type === 'text')
  if (!block) return null
  try {
    return JSON.parse(block.text)
  } catch {
    return { raw: block.text }
  }
}

/** Print a labelled section header so the protocol phases are legible. */
function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

/**
 * Format a USD amount with precision that survives memecoin prices: a token
 * quoted at $0.0000031 must not render as "$0.00" next to a $333 stock token.
 */
function fmtUsd(value) {
  if (value === null || value === undefined) return 'n/a'
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  const abs = Math.abs(n)
  const decimals = abs === 0 ? 2 : abs < 0.01 ? 8 : abs < 1 ? 4 : 2
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const serverEntry = resolveServerEntry()

  section('1 · Spawning the MCP server over stdio')
  console.log(`  server   ${serverEntry}`)
  console.log(`  network  ${args.network}`)

  // The transport spawns the server as a child process. stdout carries the
  // JSON-RPC protocol channel; the server logs to stderr so it cannot corrupt it.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, HOOD_NETWORK: args.network },
    stderr: 'pipe',
  })

  const client = new Client({ name: 'rh-example-11', version: '0.1.0' })

  // connect() performs the MCP initialize handshake: protocol version
  // negotiation plus a capability exchange in both directions.
  await client.connect(transport)

  const server = client.getServerVersion()
  const capabilities = client.getServerCapabilities()
  console.log(`  connected to ${server?.name ?? 'unknown'} v${server?.version ?? '?'}`)
  console.log(`  capabilities ${Object.keys(capabilities ?? {}).join(', ') || 'none'}`)

  try {
    section('2 · Tools the server advertises')
    const { tools } = await client.listTools()
    for (const tool of tools) {
      const inputs = Object.keys(tool.inputSchema?.properties ?? {})
      const readOnly = tool.annotations?.readOnlyHint ? 'read-only' : 'writes'
      console.log(
        `  ${tool.name.padEnd(20)} ${readOnly.padEnd(10)} (${inputs.join(', ') || 'no inputs'})`,
      )
    }
    console.log(`  ${tools.length} tools total.`)

    if (args.listOnly) return

    section('3 · get_chain_stats — the tool with no arguments')
    const stats = readToolJson(await client.callTool({ name: 'get_chain_stats', arguments: {} }))
    if (stats?.error) {
      console.log(`  error: ${stats.error}`)
    } else {
      console.log(`  chain      ${stats.network} (id ${stats.chainId})`)
      console.log(`  block      ${stats.latestBlock}`)
      console.log(`  gas price  ${stats.gasPriceGwei} gwei`)
      if (stats.tvlUsd != null) console.log(`  TVL        ${fmtUsd(stats.tvlUsd)}`)
    }

    section(`4 · get_stock_quote — the same call an agent makes for "what is ${args.symbol} worth?"`)
    const quote = readToolJson(
      await client.callTool({ name: 'get_stock_quote', arguments: { symbol: args.symbol } }),
    )
    if (quote?.error) {
      console.log(`  error: ${quote.error}`)
      if (quote.hint) console.log(`  hint:  ${quote.hint}`)
    } else {
      console.log(`  ${quote.symbol}  ${quote.name ?? ''}`)
      // chainlink is the oracle block; it is null (with chainlinkError set) when
      // a feed is missing or stale, which is a real state worth showing.
      console.log(`  oracle     ${fmtUsd(quote.chainlink?.priceUsd)}${quote.chainlinkError ? `  (${quote.chainlinkError})` : ''}`)
      console.log(`  DEX mid    ${fmtUsd(quote.dexPriceUsd)}${quote.dexError ? `  (${quote.dexError})` : ''}`)
      console.log(
        `  premium    ${quote.premiumPct != null ? `${Number(quote.premiumPct).toFixed(3)}%` : `n/a  (${quote.premiumNote})`}`,
      )
      if (quote.underlyingSharePriceUsd != null) {
        console.log(`  underlying ${fmtUsd(quote.underlyingSharePriceUsd)} per share (ERC-8056 multiplier ${quote.uiMultiplier})`)
      }
    }

    section('5 · list_trending_coins — a list-shaped result')
    const trending = readToolJson(
      await client.callTool({ name: 'list_trending_coins', arguments: { limit: 5 } }),
    )
    if (trending?.error) {
      console.log(`  error: ${trending.error}`)
    } else {
      const coins = trending.coins ?? []
      if (coins.length === 0) console.log('  (no trending pools returned right now)')
      for (const coin of coins.slice(0, 5)) {
        const pool = (coin.poolName ?? '?').padEnd(18)
        const price = fmtUsd(coin.priceUsd).padStart(12)
        const change =
          coin.priceChange24hPct != null
            ? `${coin.priceChange24hPct > 0 ? '+' : ''}${Number(coin.priceChange24hPct).toFixed(1)}%`
            : '     n/a'
        const vol = coin.volume24hUsd != null ? `vol ${fmtUsd(coin.volume24hUsd)}` : ''
        console.log(`  ${pool} ${price}  ${change.padStart(7)} 24h  ${vol}`)
      }
    }

    section('Done')
    console.log('  Same three answers an agent would get. Point any MCP host at this')
    console.log('  server and the tools above become things it can simply ask for:')
    console.log('    claude mcp add hood-mcp -- npx -y hood-mcp')
  } finally {
    // Always close: this terminates the child process and its stdio pipes.
    await client.close()
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err?.message ?? err}`)
  process.exitCode = 1
})
