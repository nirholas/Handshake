/**
 * REAL testnet swap E2E through the hood-mcp-trading server's execute_swap
 * tool: preview (confirm omitted) -> confirm=true -> broadcast -> receipt.
 *
 * Gated on ROBINHOOD_CHAIN_PRIVATE_KEY exactly like the sibling `hoodchain`
 * SDK's own live suite, because the testnet faucet
 * (https://faucet.testnet.chain.robinhood.com/) requires a browser session
 * with Cloudflare Turnstile + Google Sign-In and cannot be automated
 * headlessly. Fund a key there (0.01 ETH + test Stock Tokens), export it,
 * then: npm run test:swap
 */
import { describe, expect, it } from 'vitest'
import { formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createHoodClient } from 'hoodchain'
import { registerTradingTools } from '../src/register-trading.js'
import { readTradingConfig, SpendLedger } from '../src/shared/trading-env.js'

const pk = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}` | undefined

describe.skipIf(!pk)('live: testnet swap E2E through execute_swap (requires funded ROBINHOOD_CHAIN_PRIVATE_KEY)', () => {
  it('previews, confirms, broadcasts, and receives a real WETH -> NFLX swap on testnet 46630', async () => {
    const account = privateKeyToAccount(pk as `0x${string}`)
    const hood = createHoodClient({ chain: 'testnet', account })

    const ethBalance = await hood.public.getBalance({ address: account.address })
    expect(
      ethBalance >= parseEther('0.001'),
      `wallet ${account.address} holds ${formatEther(ethBalance)} ETH — claim the faucet first`,
    ).toBe(true)

    const config = readTradingConfig({
      HOOD_MCP_ENABLE_TRADING: '1',
      HOOD_MCP_MAX_SPEND_USDG: '9999999',
      HOOD_MCP_MAX_SESSION_USDG: '9999999',
    } as NodeJS.ProcessEnv)
    const ledger = new SpendLedger(config)
    const server = new McpServer({ name: 'hood-mcp-trading-swap-test', version: '0.0.0' })
    registerTradingTools(server, hood, config, ledger)
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'swap-test', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    // 1. Preview (no confirm) — must not broadcast.
    const preview = await client.callTool({
      name: 'execute_swap',
      arguments: { tokenIn: 'WETH', tokenOut: 'NFLX', amountIn: '0.0001' },
    })
    expect(preview.isError).toBeFalsy()
    const previewData = JSON.parse((preview.content as { text: string }[])[0]!.text)
    expect(previewData.confirmed).toBe(false)
    expect(previewData.transactionHash).toBeUndefined()

    // 2. Confirm — broadcasts for real.
    const confirmed = await client.callTool({
      name: 'execute_swap',
      arguments: { tokenIn: 'WETH', tokenOut: 'NFLX', amountIn: '0.0001', confirm: true },
    })
    expect(confirmed.isError, JSON.stringify(confirmed)).toBeFalsy()
    const data = JSON.parse((confirmed.content as { text: string }[])[0]!.text)
    expect(data.confirmed).toBe(true)
    expect(data.status).toBe('success')
    expect(typeof data.transactionHash).toBe('string')
    expect(data.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)

    // eslint-disable-next-line no-console
    console.log(`Real testnet swap settled: ${data.transactionHash} — ${data.explorer}`)

    await client.close()
  })
})
