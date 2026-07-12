/**
 * Guard behavior tests for the trading tools: spend caps, the confirm gate,
 * and the Stock Token eligibility gate. These hit REAL testnet 46630 reads
 * (quoteSwap simulates via `eth_call`, no gas or funds needed) through an
 * UNFUNDED test wallet — broadcasting is never reached because either the cap
 * rejects first or `confirm` is omitted. The one path that would need funds
 * (a confirmed swap) is covered separately by the funded, opt-in
 * `trading-swap.live.test.ts`.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { privateKeyToAccount } from 'viem/accounts'
import { createHoodClient, TESTNET_ADDRESSES, TESTNET_STOCK_TOKENS } from 'hoodchain'
import type { HoodClient } from 'hoodchain'
import { registerTradingTools } from '../src/register-trading.js'
import { readTradingConfig, SpendLedger } from '../src/shared/trading-env.js'

// Unfunded — used only for quote/preview paths that never sign+broadcast.
const TEST_KEY = '0x4918baba5b953918b69687637b543e8943bd2d2b83893ca51643c89845b9d16d'

async function buildServer(client: HoodClient, envOverrides: Record<string, string> = {}) {
  const config = readTradingConfig({
    HOOD_MCP_ENABLE_TRADING: '1',
    HOOD_MCP_MAX_SPEND_USDG: '9999999', // caps disabled by default; individual tests override
    HOOD_MCP_MAX_SESSION_USDG: '9999999',
    ...envOverrides,
  } as NodeJS.ProcessEnv)
  const ledger = new SpendLedger(config)
  const server = new McpServer({ name: 'hood-mcp-trading-guard-test', version: '0.0.0' })
  registerTradingTools(server, client, config, ledger)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client_ = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client_.connect(clientTransport)])
  return { client: client_, config, ledger }
}

describe('guard: get_swap_quote (read-only, real testnet reads)', () => {
  let hood: HoodClient
  beforeAll(() => {
    hood = createHoodClient({ chain: 'testnet', account: privateKeyToAccount(TEST_KEY) })
  })

  it('quotes a real WETH -> NFLX route on testnet 46630', async () => {
    const { client } = await buildServer(hood)
    const result = await client.callTool({
      name: 'get_swap_quote',
      arguments: { tokenIn: 'WETH', tokenOut: 'NFLX', amountIn: '0.0001' },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as { text: string }[])[0]!.text
    const data = JSON.parse(text)
    expect(data.network).toBe('testnet')
    expect(Number(data.amountOut)).toBeGreaterThan(0)
    expect(data.route.length).toBeGreaterThanOrEqual(2)
    await client.close()
  })
})

describe('guard: spend caps', () => {
  it('rejects a swap preview whose notional would exceed the per-call cap', async () => {
    const hood = createHoodClient({ chain: 'mainnet', account: privateKeyToAccount(TEST_KEY) })
    const { client } = await buildServer(hood, {
      HOOD_MCP_MAX_SPEND_USDG: '1',
      HOOD_MCP_MAX_SESSION_USDG: '1',
    })
    // 1000 USDG vastly exceeds the $1 per-call cap.
    const result = await client.callTool({
      name: 'execute_swap',
      arguments: { tokenIn: 'USDG', tokenOut: 'WETH', amountIn: '1000' },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as { text: string }[])[0]!.text
    expect(text).toMatch(/exceeds the per-call cap/)
    await client.close()
  })

  it('rejects transfer_usdg whose amount exceeds the per-call cap', async () => {
    const hood = createHoodClient({ chain: 'mainnet', account: privateKeyToAccount(TEST_KEY) })
    const { client } = await buildServer(hood, {
      HOOD_MCP_MAX_SPEND_USDG: '5',
      HOOD_MCP_MAX_SESSION_USDG: '5',
    })
    const result = await client.callTool({
      name: 'transfer_usdg',
      arguments: { to: '0x000000000000000000000000000000000000dEaD', amount: '50' },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as { text: string }[])[0]!.text
    expect(text).toMatch(/exceeds the per-call cap/)
    await client.close()
  })

  it('SpendLedger enforces the session cap across multiple calls', () => {
    const config = readTradingConfig({
      HOOD_MCP_ENABLE_TRADING: '1',
      HOOD_MCP_MAX_SPEND_USDG: '100',
      HOOD_MCP_MAX_SESSION_USDG: '150',
    } as NodeJS.ProcessEnv)
    const ledger = new SpendLedger(config)
    ledger.assertWithinCaps(80)
    ledger.recordSpend(80)
    expect(ledger.sessionRemaining).toBe(70)
    // A further $80 call is under the per-call cap of $100 but would bring the
    // session total to $160, over the $150 session cap.
    expect(() => ledger.assertWithinCaps(80)).toThrow(/per-session cap/)
    // $70 exactly fits.
    expect(() => ledger.assertWithinCaps(70)).not.toThrow()
  })
})

describe('guard: confirm gate', () => {
  it('execute_swap without confirm returns a simulation and spends nothing from the ledger', async () => {
    const hood = createHoodClient({ chain: 'testnet', account: privateKeyToAccount(TEST_KEY) })
    const { client, ledger } = await buildServer(hood)
    const result = await client.callTool({
      name: 'execute_swap',
      arguments: { tokenIn: 'WETH', tokenOut: 'NFLX', amountIn: '0.0001' },
    })
    expect(result.isError).toBeFalsy()
    const data = JSON.parse((result.content as { text: string }[])[0]!.text)
    expect(data.confirmed).toBe(false)
    expect(data.message).toMatch(/SIMULATION ONLY/)
    expect(data.transactionHash).toBeUndefined()
    expect(ledger.spent).toBe(0)
    await client.close()
  })

  it('transfer_usdg without confirm returns a simulation and spends nothing from the ledger', async () => {
    const hood = createHoodClient({ chain: 'testnet', account: privateKeyToAccount(TEST_KEY) })
    const { client, ledger } = await buildServer(hood)
    const result = await client.callTool({
      name: 'transfer_usdg',
      arguments: { to: '0x000000000000000000000000000000000000dEaD', amount: '1' },
    })
    expect(result.isError).toBeFalsy()
    const data = JSON.parse((result.content as { text: string }[])[0]!.text)
    expect(data.confirmed).toBe(false)
    expect(data.transactionHash).toBeUndefined()
    expect(ledger.spent).toBe(0)
    await client.close()
  })
})

describe('guard: Stock Token eligibility', () => {
  // ASML is one of the few Stock Tokens with real Uniswap v3 liquidity against
  // USDG on mainnet (verified live: most Stock Tokens trade on Arcus instead,
  // which quoteSwap does not probe — see get_stock_quote's dexError for AAPL).
  it('blocks a mainnet swap whose OUTPUT is a Stock Token when eligibility is not acknowledged', async () => {
    const hood = createHoodClient({ chain: 'mainnet', account: privateKeyToAccount(TEST_KEY) })
    const { client } = await buildServer(hood, { HOOD_MCP_ACKNOWLEDGE_ELIGIBILITY: '0' })
    const result = await client.callTool({
      name: 'execute_swap',
      arguments: { tokenIn: 'USDG', tokenOut: 'ASML', amountIn: '10' },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as { text: string }[])[0]!.text
    expect(text).toMatch(/eligibility acknowledgement/)
    await client.close()
  })

  it('allows the simulation preview once eligibility is acknowledged', async () => {
    const hood = createHoodClient({ chain: 'mainnet', account: privateKeyToAccount(TEST_KEY) })
    const { client } = await buildServer(hood, { HOOD_MCP_ACKNOWLEDGE_ELIGIBILITY: '1' })
    const result = await client.callTool({
      name: 'execute_swap',
      arguments: { tokenIn: 'USDG', tokenOut: 'ASML', amountIn: '10' },
    })
    expect(result.isError).toBeFalsy()
    const data = JSON.parse((result.content as { text: string }[])[0]!.text)
    expect(data.confirmed).toBe(false)
    await client.close()
  })
})

describe('guard: unresolvable token', () => {
  it('rejects an unknown ticker with an actionable error', async () => {
    const hood = createHoodClient({ chain: 'mainnet', account: privateKeyToAccount(TEST_KEY) })
    const { client } = await buildServer(hood)
    const result = await client.callTool({
      name: 'get_swap_quote',
      arguments: { tokenIn: 'USDG', tokenOut: 'NOTATICKER', amountIn: '1' },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as { text: string }[])[0]!.text
    expect(text).toMatch(/Unknown token/)
    await client.close()
  })
})
