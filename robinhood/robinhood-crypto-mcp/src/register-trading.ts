/**
 * Order placement and cancellation.
 *
 * Every order here is real money against a real brokerage account — Robinhood
 * publishes no sandbox. Two things stand between a model and a live order:
 * the operator's `ROBINHOOD_CRYPTO_ENABLE_TRADING=1` opt-in, and a per-call
 * `confirm` flag that defaults to a priced preview instead of execution.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RobinhoodCryptoClient } from './shared/client.js';
import { endpointsFor, requiresAccountNumber } from './shared/endpoints.js';
import type { Credentials } from './shared/config.js';
import { assertOrderAllowed, estimateNotionalUsd, type TradingGuards } from './shared/guards.js';
import { toolResult, toolError } from './shared/format.js';

const symbolSchema = z
  .string()
  .regex(/^[A-Za-z0-9]+-[A-Za-z0-9]+$/, 'Symbol must be a trading pair like BTC-USD.')
  .transform((s) => s.toUpperCase());

const decimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal string, e.g. "0.001".');

export function registerTradingTools(
  server: McpServer,
  client: RobinhoodCryptoClient,
  credentials: Credentials,
  guards: TradingGuards,
): void {
  const endpoints = endpointsFor(credentials.apiVersion);
  const needsAccount = requiresAccountNumber(credentials.apiVersion);

  let cachedAccountNumber: string | undefined;
  async function accountNumber(): Promise<string | undefined> {
    if (!needsAccount) return undefined;
    if (cachedAccountNumber) return cachedAccountNumber;
    const accounts = await client.get<{ results?: Array<{ account_number?: string }> }>(
      endpoints.accounts,
    );
    const resolved = accounts?.results?.[0]?.account_number;
    if (!resolved) throw new Error('Could not resolve account_number, which API v2 requires.');
    cachedAccountNumber = resolved;
    return resolved;
  }

  /** Best available reference price, used to size market orders for the cap. */
  async function referencePrice(symbol: string, side: 'buy' | 'sell'): Promise<number | undefined> {
    try {
      const quote = await client.get<{ results?: Array<Record<string, unknown>> }>(
        endpoints.bestBidAsk,
        { query: { symbol: [symbol] } },
      );
      const row = quote?.results?.[0];
      if (!row) return undefined;

      // Field names differ between v1 and v2; try the documented keys in order
      // and fall back to the generic ones rather than assuming one shape.
      const candidates =
        side === 'buy'
          ? ['ask_inclusive_of_buy_spread', 'ask', 'price']
          : ['bid_inclusive_of_sell_spread', 'bid', 'price'];

      for (const key of candidates) {
        const value = Number(row[key]);
        if (Number.isFinite(value) && value > 0) return value;
      }
      return undefined;
    } catch {
      // A missing quote must not silently disable the spend cap; the caller
      // treats `undefined` as "notional unknown" and refuses to proceed.
      return undefined;
    }
  }

  server.registerTool(
    'place_order',
    {
      title: 'Place order',
      description:
        'Place a crypto order. THIS SPENDS REAL MONEY — Robinhood has no sandbox. ' +
        'Defaults to a preview: without confirm=true it returns the exact request that would be sent, ' +
        'a priced estimate, and the guards it was checked against, and places nothing. ' +
        'Call once to preview, show the user the numbers, then call again with confirm=true. ' +
        `Orders are capped at $${guards.maxOrderUsd} by ROBINHOOD_CRYPTO_MAX_ORDER_USD.`,
      inputSchema: {
        symbol: symbolSchema.describe('Trading pair, e.g. BTC-USD.'),
        side: z.enum(['buy', 'sell']),
        type: z.enum(['market', 'limit', 'stop_loss', 'stop_limit']),
        asset_quantity: decimalString
          .optional()
          .describe('Size in the base asset, e.g. "0.001" BTC. Mutually exclusive with quote_amount.'),
        quote_amount: decimalString
          .optional()
          .describe(
            'Size in the quote currency, e.g. "25.00" USD. Not supported for market orders.',
          ),
        limit_price: decimalString
          .optional()
          .describe('Required for limit and stop_limit orders.'),
        stop_price: decimalString
          .optional()
          .describe('Required for stop_loss and stop_limit orders.'),
        time_in_force: z
          .enum(['gtc', 'day'])
          .optional()
          .default('gtc')
          .describe('Applies to limit, stop_loss, and stop_limit orders.'),
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe('Must be true to actually place the order. False returns a preview.'),
        client_order_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Idempotency key. Generated if omitted. Reuse the same value when retrying one logical order.',
          ),
      },
    },
    async (args) => {
      try {
        const {
          symbol,
          side,
          type,
          asset_quantity,
          quote_amount,
          limit_price,
          stop_price,
          time_in_force,
          confirm,
        } = args;

        if (!asset_quantity && !quote_amount) {
          throw new Error('Specify either asset_quantity or quote_amount.');
        }
        if (asset_quantity && quote_amount) {
          throw new Error('Specify only one of asset_quantity or quote_amount, not both.');
        }
        if (type === 'market' && quote_amount) {
          throw new Error(
            'Market orders must be sized with asset_quantity; Robinhood does not accept quote_amount for them.',
          );
        }
        if ((type === 'limit' || type === 'stop_limit') && !limit_price) {
          throw new Error(`A ${type} order requires limit_price.`);
        }
        if ((type === 'stop_loss' || type === 'stop_limit') && !stop_price) {
          throw new Error(`A ${type} order requires stop_price.`);
        }

        // Price the order so the spend cap is enforceable even for market orders.
        const reference =
          limit_price === undefined && asset_quantity !== undefined
            ? await referencePrice(symbol, side)
            : undefined;

        const notionalUsd = estimateNotionalUsd({
          quoteAmount: quote_amount,
          assetQuantity: asset_quantity,
          limitPrice: limit_price,
          referencePrice: reference,
        });

        assertOrderAllowed({ symbol, side, notionalUsd }, guards);

        const config = buildOrderConfig({
          type,
          asset_quantity,
          quote_amount,
          limit_price,
          stop_price,
          time_in_force,
        });

        const body = {
          client_order_id: args.client_order_id ?? randomUUID(),
          symbol,
          side,
          type,
          ...config,
        };

        if (!confirm) {
          return toolResult({
            preview: true,
            placed: false,
            message:
              'Nothing was placed. Review these numbers with the user, then call again with confirm=true.',
            request: { method: 'POST', path: endpoints.orders, body },
            estimate: {
              notional_usd: notionalUsd,
              reference_price: reference ?? null,
              priced_from:
                limit_price !== undefined
                  ? 'limit_price'
                  : quote_amount !== undefined
                    ? 'quote_amount'
                    : reference !== undefined
                      ? 'live best bid/ask'
                      : 'unavailable',
            },
            guards: {
              max_order_usd: guards.maxOrderUsd,
              symbol_allowlist: guards.symbolAllowlist,
              buy_only: guards.buyOnly,
            },
          });
        }

        const result = await client.post(endpoints.orders, {
          body,
          query: needsAccount ? { account_number: await accountNumber() } : {},
          // Never retry a write: a retry after an ambiguous failure can double-fill.
          maxRetries: 0,
        });

        return toolResult({
          placed: true,
          estimated_notional_usd: notionalUsd,
          order: result,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'cancel_order',
    {
      title: 'Cancel order',
      description:
        'Request cancellation of an open order by id. Cancellation is best-effort: an order that has already filled cannot be canceled. Confirm the resulting state with get_order.',
      inputSchema: {
        order_id: z.string().min(1).describe('The order id to cancel.'),
      },
    },
    async ({ order_id }) => {
      try {
        const result = await client.post(endpoints.cancelOrder(order_id), { maxRetries: 0 });
        return toolResult({
          cancel_requested: true,
          order_id,
          response: result ?? null,
          note: 'Cancellation is best-effort. Call get_order to confirm the final state.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/** Build the `*_order_config` object matching the order type. */
function buildOrderConfig(params: {
  type: 'market' | 'limit' | 'stop_loss' | 'stop_limit';
  asset_quantity?: string | undefined;
  quote_amount?: string | undefined;
  limit_price?: string | undefined;
  stop_price?: string | undefined;
  time_in_force?: 'gtc' | 'day' | undefined;
}): Record<string, unknown> {
  const { type, asset_quantity, quote_amount, limit_price, stop_price, time_in_force } = params;
  const size = asset_quantity !== undefined ? { asset_quantity } : { quote_amount };

  switch (type) {
    case 'market':
      return { market_order_config: { asset_quantity } };
    case 'limit':
      return { limit_order_config: { ...size, limit_price, time_in_force } };
    case 'stop_loss':
      return { stop_loss_order_config: { ...size, stop_price, time_in_force } };
    case 'stop_limit':
      return { stop_limit_order_config: { ...size, limit_price, stop_price, time_in_force } };
  }
}
