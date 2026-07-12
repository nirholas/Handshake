/**
 * Structural tests: every tool on both servers has a valid, LLM-routable
 * schema and no tool name collides across the two servers' surface areas.
 * Uses an in-memory MCP client/server pair — no network required.
 */
import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { privateKeyToAccount } from 'viem/accounts'
import { createHoodClient } from 'hoodchain'
import { registerDataTools } from '../src/register-data.js'
import { registerTradingTools } from '../src/register-trading.js'
import { readTradingConfig, SpendLedger } from '../src/shared/trading-env.js'

const DATA_TOOLS = [
  'get_chain_stats',
  'list_stock_tokens',
  'get_stock_quote',
  'get_portfolio',
  'get_coin',
  'list_trending_coins',
  'get_recent_launches',
  'watch_launches',
  'search_token',
]

const TRADING_TOOLS = ['get_my_portfolio', 'get_swap_quote', 'execute_swap', 'transfer_usdg']

// A fixed unfunded test key — used ONLY to exercise schema/tool wiring, never
// to sign a real transaction with value.
const TEST_KEY = '0x4918baba5b953918b69687637b543e8943bd2d2b83893ca51643c89845b9d16d'

async function connectedClient(server: McpServer): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe('data server tool schemas', () => {
  it('registers exactly the documented data tools with descriptions and input schemas', async () => {
    const hood = createHoodClient() // read-only, mainnet — no network call at construction time
    const server = new McpServer({ name: 'hood-mcp-test', version: '0.0.0' })
    registerDataTools(server, hood)
    const client = await connectedClient(server)

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...DATA_TOOLS].sort())

    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy()
      expect(tool.description!.length, `${tool.name} description too short to route on`).toBeGreaterThan(20)
      expect(tool.inputSchema, `${tool.name} needs an input schema`).toBeTruthy()
      expect(tool.inputSchema.type).toBe('object')
    }
    await client.close()
  })

  it('get_stock_quote rejects a non-string symbol via schema validation', async () => {
    const hood = createHoodClient()
    const server = new McpServer({ name: 'hood-mcp-test', version: '0.0.0' })
    registerDataTools(server, hood)
    const client = await connectedClient(server)

    const result = await client.callTool({ name: 'get_stock_quote', arguments: { symbol: 123 } })
    expect(result.isError, 'a wrong-typed argument must be rejected as an error').toBe(true)
    await client.close()
  })
})

describe('trading server tool schemas', () => {
  it('registers exactly the documented trading tools, all requiring an account', async () => {
    const account = privateKeyToAccount(TEST_KEY)
    const hood = createHoodClient({ chain: 'testnet', account })
    const config = readTradingConfig({ HOOD_MCP_ENABLE_TRADING: '1' } as NodeJS.ProcessEnv)
    const ledger = new SpendLedger(config)
    const server = new McpServer({ name: 'hood-mcp-trading-test', version: '0.0.0' })
    registerTradingTools(server, hood, config, ledger)
    const client = await connectedClient(server)

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...TRADING_TOOLS].sort())

    const mutating = tools.filter((t) => t.name === 'execute_swap' || t.name === 'transfer_usdg')
    for (const tool of mutating) {
      expect(tool.annotations?.destructiveHint, `${tool.name} must be marked destructive`).toBe(true)
      // Every mutating tool schema must expose a `confirm` boolean gate.
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      expect(props, `${tool.name} must declare a confirm parameter`).toHaveProperty('confirm')
    }

    const readOnly = tools.filter((t) => t.name === 'get_my_portfolio' || t.name === 'get_swap_quote')
    for (const tool of readOnly) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be marked read-only`).toBe(true)
    }
    await client.close()
  })

  it('throws when constructed without a wallet account', () => {
    const hood = createHoodClient({ chain: 'testnet' })
    const config = readTradingConfig({ HOOD_MCP_ENABLE_TRADING: '1' } as NodeJS.ProcessEnv)
    const ledger = new SpendLedger(config)
    const server = new McpServer({ name: 'x', version: '0.0.0' })
    expect(() => registerTradingTools(server, hood, config, ledger)).toThrow(/requires a wallet-backed client/)
  })
})
