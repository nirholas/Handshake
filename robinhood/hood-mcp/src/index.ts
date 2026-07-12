/**
 * hood-mcp — Model Context Protocol servers for Robinhood Chain.
 *
 * This module exposes the server builders and tool registrars for programmatic
 * embedding. Most users run the CLIs instead: `hood-mcp` (data) and
 * `hood-mcp-trading` (wallet). See the README for client install snippets.
 *
 * @packageDocumentation
 */

export { buildDataServer } from './data-server.js'
export { registerDataTools } from './register-data.js'
export { registerTradingTools } from './register-trading.js'
export { readOnlyClient, walletClientFromEnv, resolveNetwork } from './shared/client.js'
export { readTradingConfig, SpendLedger } from './shared/trading-env.js'
export type { TradingConfig } from './shared/trading-env.js'
export { SERVER_NAME, SERVER_VERSION } from './version.js'
