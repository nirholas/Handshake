/**
 * hood-mcp — the read-only data server for Robinhood Chain.
 *
 * Zero config: runs against the public RPC with no key. Default transport is
 * stdio (for Claude Desktop / Claude Code / Cursor / any stdio MCP client).
 * Pass `--http` (or set `HOOD_MCP_TRANSPORT=http`) to serve Streamable HTTP on
 * `HOOD_MCP_PORT` (default 8730).
 *
 * @packageDocumentation
 */

import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { HoodClient } from 'hoodchain'
import { readOnlyClient, resolveNetwork } from './shared/client.js'
import { registerDataTools } from './register-data.js'
import { SERVER_NAME, SERVER_VERSION } from './version.js'
import { loadPaywallMiddleware, readPaywallConfig } from './x402-seam.js'

const INSTRUCTIONS = `Read-only market data for Robinhood Chain (chain ID 4663), the permissionless
Arbitrum Orbit L2 with tokenized-equity "Stock Tokens", the USDG stablecoin, and the NOXA / The
Odyssey memecoin launchpads. Use get_stock_quote for a ticker's oracle+DEX price and premium,
get_portfolio for a wallet's holdings, list_trending_coins / get_coin for memecoins,
get_recent_launches / watch_launches for launchpad activity, and get_chain_stats for the chain.
All data is public and read-only. To place trades, use the separate hood-mcp-trading server.`

function buildServer(client: HoodClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  )
  registerDataTools(server, client)
  return server
}

async function runStdio(client: HoodClient): Promise<void> {
  const server = buildServer(client)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr is safe for logs on stdio (stdout is the protocol channel).
  process.stderr.write(`[${SERVER_NAME}] data server ready on stdio (network=${client.network})\n`)
}

async function runHttp(client: HoodClient, port: number): Promise<void> {
  const paywall = await loadPaywallMiddleware(readPaywallConfig())

  const httpServer = http.createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS for browser-based MCP clients; expose the session header.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, X-PAYMENT')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    const path = (req.url ?? '/').split('?')[0]
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, network: client.network }))
      return
    }
    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found', hint: 'POST JSON-RPC to /mcp' }))
      return
    }
    if (req.method !== 'POST') {
      // Stateless transport: no server-initiated SSE stream.
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'method not allowed', hint: 'use POST for JSON-RPC' }))
      return
    }

    // Optional x402 paywall (inert unless hood402 is installed and configured).
    await new Promise<void>((resolve) => paywall(req, res, resolve))
    if (res.writableEnded) return

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    let body: unknown
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
      return
    }

    // Stateless: a fresh server + transport per request keeps sessions isolated.
    const server = buildServer(client)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  await new Promise<void>((resolve) => httpServer.listen(port, resolve))
  process.stderr.write(
    `[${SERVER_NAME}] data server ready on http://localhost:${port}/mcp (network=${client.network})\n`,
  )
}

async function main(): Promise<void> {
  const client = readOnlyClient()
  const useHttp = process.argv.includes('--http') || process.env.HOOD_MCP_TRANSPORT === 'http'
  if (useHttp) {
    const port = Number(process.env.HOOD_MCP_PORT ?? 8730)
    await runHttp(client, port)
  } else {
    await runStdio(client)
  }
}

// Only run when executed as a binary, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`[${SERVER_NAME}] fatal: ${e instanceof Error ? e.stack : String(e)}\n`)
    process.exit(1)
  })
}

export { buildServer as buildDataServer, resolveNetwork }
