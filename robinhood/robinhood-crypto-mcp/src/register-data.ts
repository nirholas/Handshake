/**
 * Read-only tools. Registered on both servers — the trading server is a
 * superset, so an agent never needs two connections to do useful work.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RobinhoodCryptoClient } from './shared/client.js';
import { endpointsFor, requiresAccountNumber } from './shared/endpoints.js';
import { configuredPublicKey, type Credentials } from './shared/config.js';
import { toolResult, toolError } from './shared/format.js';

const symbolSchema = z
  .string()
  .regex(/^[A-Za-z0-9]+-[A-Za-z0-9]+$/, 'Symbol must be a trading pair like BTC-USD.')
  .transform((s) => s.toUpperCase());

export function registerDataTools(
  server: McpServer,
  client: RobinhoodCryptoClient,
  credentials: Credentials,
): void {
  const endpoints = endpointsFor(credentials.apiVersion);
  const needsAccount = requiresAccountNumber(credentials.apiVersion);

  /**
   * v2 requires an account_number on several endpoints. Resolve it once and
   * reuse, so callers never have to supply it by hand.
   */
  let cachedAccountNumber: string | undefined;
  async function accountNumber(): Promise<string | undefined> {
    if (!needsAccount) return undefined;
    if (cachedAccountNumber) return cachedAccountNumber;

    const accounts = await client.get<{ results?: Array<{ account_number?: string }> }>(
      endpoints.accounts,
    );
    const resolved = accounts?.results?.[0]?.account_number;
    if (!resolved) {
      throw new Error(
        'Could not resolve an account_number from the v2 accounts endpoint, which v2 holdings and orders require.',
      );
    }
    cachedAccountNumber = resolved;
    return resolved;
  }

  server.registerTool(
    'get_account',
    {
      title: 'Get account',
      description:
        'Fetch the Robinhood crypto account: account number, status, and buying power. On API v2 this also includes fee-tier status. Use this to confirm credentials work and to check available buying power before sizing an order.',
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult(await client.get(endpoints.accounts));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_holdings',
    {
      title: 'Get holdings',
      description:
        'List crypto holdings with total quantity and the quantity available for trading. Optionally filter to specific asset codes (the base asset, e.g. BTC, not the BTC-USD pair).',
      inputSchema: {
        asset_codes: z
          .array(z.string().transform((s) => s.toUpperCase()))
          .optional()
          .describe('Filter to these asset codes, e.g. ["BTC", "ETH"]. Omit for all holdings.'),
      },
    },
    async ({ asset_codes }) => {
      try {
        const { results, truncated } = await client.getAllPages(endpoints.holdings, {
          query: {
            ...(asset_codes?.length ? { asset_code: asset_codes } : {}),
            ...(needsAccount ? { account_number: await accountNumber() } : {}),
          },
        });
        return toolResult({ holdings: results, truncated });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_best_bid_ask',
    {
      title: 'Get best bid/ask',
      description:
        'Current best bid and ask for one or more trading pairs. On API v1 the response includes the spread-inclusive prices actually used for execution (bid_inclusive_of_sell_spread / ask_inclusive_of_buy_spread) alongside the mid price. Use this to price an order before placing it.',
      inputSchema: {
        symbols: z
          .array(symbolSchema)
          .min(1)
          .describe('Trading pairs to quote, e.g. ["BTC-USD", "ETH-USD"].'),
      },
    },
    async ({ symbols }) => {
      try {
        return toolResult(await client.get(endpoints.bestBidAsk, { query: { symbol: symbols } }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_estimated_price',
    {
      title: 'Get estimated price',
      description:
        'Estimated execution price for a given quantity, which accounts for depth rather than quoting only the top of book. Use side "ask" when buying and "bid" when selling. On API v2 the response also carries fee estimates.',
      inputSchema: {
        symbol: symbolSchema.describe('Trading pair, e.g. BTC-USD.'),
        side: z
          .enum(['bid', 'ask', 'both'])
          .describe('Use "ask" to estimate a buy, "bid" to estimate a sell.'),
        quantities: z
          .array(z.string())
          .min(1)
          .describe('Asset quantities to price, as decimal strings, e.g. ["0.1", "1.0"].'),
      },
    },
    async ({ symbol, side, quantities }) => {
      try {
        return toolResult(
          await client.get(endpoints.estimatedPrice, {
            query: { symbol, side, quantity: quantities.join(',') },
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_trading_pairs',
    {
      title: 'Get trading pairs',
      description:
        'List supported trading pairs with their minimum and maximum order sizes and price/quantity increments. Check these increments before placing an order: a quantity with too many decimals is rejected.',
      inputSchema: {
        symbols: z
          .array(symbolSchema)
          .optional()
          .describe('Filter to these pairs. Omit to list every supported pair.'),
      },
    },
    async ({ symbols }) => {
      try {
        const { results, truncated } = await client.getAllPages(endpoints.tradingPairs, {
          query: symbols?.length ? { symbol: symbols } : {},
        });
        return toolResult({ trading_pairs: results, truncated });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_orders',
    {
      title: 'List orders',
      description:
        'List orders, newest first, with optional filters by symbol, side, type, state, and creation/update time. Use this to review order history or to poll an order until it fills.',
      inputSchema: {
        symbol: symbolSchema.optional().describe('Filter to one trading pair.'),
        side: z.enum(['buy', 'sell']).optional(),
        type: z.enum(['market', 'limit', 'stop_loss', 'stop_limit']).optional(),
        state: z
          .enum(['open', 'canceled', 'partially_filled', 'filled', 'failed'])
          .optional()
          .describe('Order state. Note API v2 reports "pending" in place of "partially_filled".'),
        created_at_start: z.string().optional().describe('ISO 8601 timestamp lower bound.'),
        created_at_end: z.string().optional().describe('ISO 8601 timestamp upper bound.'),
        limit: z.number().int().positive().max(200).optional().describe('Max results per page.'),
      },
    },
    async (args) => {
      try {
        const { results, truncated } = await client.getAllPages(endpoints.orders, {
          query: {
            ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)),
            ...(needsAccount ? { account_number: await accountNumber() } : {}),
          },
        });
        return toolResult({ orders: results, truncated });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description:
        'Fetch a single order by its Robinhood order id, including its executions (fill price and quantity). Use this after placing an order to confirm the fill.',
      inputSchema: {
        order_id: z.string().min(1).describe('The order id returned when the order was placed.'),
      },
    },
    async ({ order_id }) => {
      try {
        return toolResult(
          await client.get(endpoints.order(order_id), {
            query: needsAccount ? { account_number: await accountNumber() } : {},
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_connection_info',
    {
      title: 'Get connection info',
      description:
        'Report how this server is configured — API version, base URL, and the public key derived from the configured private key — without revealing any secret. Use this first when authentication fails: if the public key shown here does not match the one registered with Robinhood, the wrong private key is configured.',
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult({
          api_version: credentials.apiVersion,
          base_url: credentials.baseUrl,
          derived_public_key: configuredPublicKey(credentials),
          note: 'Compare derived_public_key against the public key registered at https://robinhood.com/account/crypto. The API key and private key are never returned.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
