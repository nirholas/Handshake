/**
 * hood-mcp-trading — the wallet server for Robinhood Chain.
 *
 * Explicitly opt-in and stdio-only (a wallet server should not be exposed over
 * HTTP by default). Refuses to start unless BOTH are set:
 *   - HOOD_MCP_ENABLE_TRADING=1        (master kill switch)
 *   - ROBINHOOD_CHAIN_PRIVATE_KEY=0x…  (wallet key)
 *
 * Every mutating tool is spend-capped (HOOD_MCP_MAX_SPEND_USDG /
 * HOOD_MCP_MAX_SESSION_USDG) and confirm-gated. See register-trading.ts.
 *
 * @packageDocumentation
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { walletClientFromEnv } from './shared/client.js'
import { readTradingConfig, SpendLedger } from './shared/trading-env.js'
import { registerTradingTools } from './register-trading.js'
import { SERVER_NAME, SERVER_VERSION } from './version.js'

const NAME = `${SERVER_NAME}-trading`

const INSTRUCTIONS = `Guarded trading on Robinhood Chain (chain ID 4663) for a single configured wallet.
get_my_portfolio and get_swap_quote are read-only. execute_swap and transfer_usdg MOVE FUNDS:
each returns a simulation first and must be re-called with confirm=true to broadcast, and each is
hard-capped in USD by the server's spend limits. Buying tokenized Stock Tokens additionally
requires the operator to have set the eligibility flag (Stock Tokens are barred to US persons).
Always show the user the recipient, amount, and token before confirming.`

function buildTradingServer(): McpServer {
  const config = readTradingConfig()
  if (!config.enabled) {
    throw new Error(
      'Trading is disabled. Set HOOD_MCP_ENABLE_TRADING=1 to enable the wallet server. ' +
        'Refusing to start with a wallet key but trading off.',
    )
  }
  const client = walletClientFromEnv()
  const ledger = new SpendLedger(config)
  const server = new McpServer({ name: NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS })
  registerTradingTools(server, client, config, ledger)
  return server
}

async function main(): Promise<void> {
  const server = buildTradingServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const cfg = readTradingConfig()
  process.stderr.write(
    `[${NAME}] trading server ready on stdio ` +
      `(network=${(process.env.HOOD_MCP_NETWORK ?? 'mainnet')}, ` +
      `perCall=$${cfg.maxSpendPerCallUsd}, session=$${cfg.maxSpendPerSessionUsd}, ` +
      `stockTokenBuys=${cfg.acknowledgeEligibility ? 'allowed' : 'blocked'})\n`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`[${NAME}] fatal: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}

export { buildTradingServer }
