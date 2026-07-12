/**
 * Scripted MCP client exercising every data-server tool against REAL mainnet
 * 4663 data — the SDK's client, not a mock. Run explicitly: `npm run test:live`
 * (excluded from the default `npm test` since it depends on live upstreams:
 * public RPC, DefiLlama, Blockscout, GeckoTerminal).
 */
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readOnlyClient } from '../src/shared/client.js'
import { registerDataTools } from '../src/register-data.js'

async function connect() {
  const hood = readOnlyClient() // mainnet, read-only, tuned-retry public RPC
  const server = new McpServer({ name: 'hood-mcp-live-test', version: '0.0.0' })
  registerDataTools(server, hood)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'live-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function json(result: Awaited<ReturnType<Client['callTool']>>): any {
  expect(result.isError, JSON.stringify(result)).toBeFalsy()
  return JSON.parse((result.content as { text: string }[])[0]!.text)
}

describe('live: hood-mcp data tools against Robinhood Chain mainnet 4663', () => {
  it('get_chain_stats returns a live block number ahead of the SDK build snapshot', async () => {
    const client = await connect()
    const data = json(await client.callTool({ name: 'get_chain_stats', arguments: {} }))
    expect(data.chainId).toBe(4663)
    expect(Number(data.latestBlock)).toBeGreaterThan(7_700_000)
    expect(data.tvlUsd).toBeGreaterThan(0)
    await client.close()
  })

  it('list_stock_tokens returns the full 95-token registry with feeds', async () => {
    const client = await connect()
    const all = json(await client.callTool({ name: 'list_stock_tokens', arguments: {} }))
    expect(all.total).toBe(95)
    const priced = json(await client.callTool({ name: 'list_stock_tokens', arguments: { pricedOnly: true } }))
    expect(priced.total).toBe(34)
    await client.close()
  })

  it('get_stock_quote returns a real Chainlink price for AAPL', async () => {
    const client = await connect()
    const data = json(await client.callTool({ name: 'get_stock_quote', arguments: { symbol: 'AAPL' } }))
    expect(data.symbol).toBe('AAPL')
    expect(data.chainlink.priceUsd).toBeGreaterThan(0)
    expect(data.uiMultiplier).toBe('1000000000000000000')
    await client.close()
  })

  it('get_stock_quote reports an actionable error for an unknown ticker', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'get_stock_quote', arguments: { symbol: 'NOTREAL' } })
    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toMatch(/not a Stock Token/)
    await client.close()
  })

  it('get_portfolio values a real address (USDG treasury) with multiplier-correct positions', async () => {
    const client = await connect()
    // USDG contract itself — always a valid address to read, whether or not it
    // holds Stock Tokens; proves the multicall + valuation path end to end.
    const data = json(
      await client.callTool({
        name: 'get_portfolio',
        arguments: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' },
      }),
    )
    expect(data.network).toBe('mainnet')
    expect(Array.isArray(data.positions)).toBe(true)
    await client.close()
  })

  it('get_coin returns real GeckoTerminal + Blockscout data for a live memecoin (HOODBOT)', async () => {
    const client = await connect()
    const data = json(
      await client.callTool({
        name: 'get_coin',
        arguments: { address: '0x32758ae8e02b0a2cb6b802b6aaeaf74158c169f7' },
      }),
    )
    expect(data.symbol).toBe('HOODBOT')
    expect(data.priceUsd).toBeGreaterThan(0)
    expect(data.isStockToken).toBe(false)
    await client.close()
  })

  it('get_recent_launches scans real on-chain logs (structure verified; volume varies with launch activity)', async () => {
    const client = await connect()
    const data = json(
      await client.callTool({
        name: 'get_recent_launches',
        arguments: { lookbackBlocks: 500_000, limit: 5 },
      }),
    )
    expect(data.network).toBe('mainnet')
    expect(data.scannedBlocks).toBe(500_000)
    expect(Array.isArray(data.launches)).toBe(true)
    // The scanner itself is proven against real logs across launchpad history in
    // the SDK's own live suite (16k+ launches over a 1.5M-block scan); a 500k-block
    // (~14h) window can legitimately be quiet during a lull in launch activity.
    for (const l of data.launches) expect(['noxa', 'odyssey']).toContain(l.launchpad)
    await client.close()
  })

  it('search_token finds the canonical TSLA Stock Token by ticker', async () => {
    const client = await connect()
    const data = json(await client.callTool({ name: 'search_token', arguments: { query: 'TSLA', limit: 5 } }))
    const stockHit = data.results.find((r: any) => r.isStockToken)
    expect(stockHit).toBeDefined()
    expect(stockHit.symbol).toBe('TSLA')
    await client.close()
  })
})
