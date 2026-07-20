#!/usr/bin/env node
/**
 * Read-only MCP server for the Robinhood Crypto Trading API.
 *
 * Exposes quotes, holdings, account details, and order history. It registers
 * no tool that can move money, so it is safe to attach to a general-purpose
 * assistant. Order placement lives in `robinhood-crypto-mcp-trading`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RobinhoodCryptoClient } from './shared/client.js';
import { loadCredentials } from './shared/config.js';
import { registerDataTools } from './register-data.js';
import { VERSION } from './version.js';
import { isMain } from './shared/is-main.js';

export function createDataServer(): McpServer {
  const credentials = loadCredentials();
  const client = new RobinhoodCryptoClient(credentials);

  const server = new McpServer({
    name: 'robinhood-crypto-mcp',
    version: VERSION,
  });

  registerDataTools(server, client, credentials);
  return server;
}

export async function main(): Promise<void> {
  try {
    const server = createDataServer();
    await server.connect(new StdioServerTransport());
  } catch (error) {
    // stderr only: stdout is the MCP transport and must stay clean JSON-RPC.
    console.error(`[robinhood-crypto-mcp] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  void main();
}
