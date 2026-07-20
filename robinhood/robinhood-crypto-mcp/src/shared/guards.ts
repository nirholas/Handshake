/**
 * Safety guards for the trading server.
 *
 * Robinhood has no sandbox: every order this server can place is real money in
 * a real brokerage account. The guards below are deliberately strict and fail
 * closed. They are enforced in the server, not in the prompt, because an
 * instruction in a tool description is a suggestion and a thrown error is not.
 */

export class TradingDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradingDisabledError';
  }
}

export class GuardViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardViolationError';
  }
}

export interface TradingGuards {
  /** Hard ceiling on the notional value of any single order, in USD. */
  maxOrderUsd: number;
  /** When set, only these symbols may be traded. */
  symbolAllowlist: string[] | null;
  /** When true, sell orders are rejected. */
  buyOnly: boolean;
}

export const DEFAULT_MAX_ORDER_USD = 100;

/**
 * Load guards, and assert the operator explicitly opted into trading.
 *
 * @throws {TradingDisabledError} If `ROBINHOOD_CRYPTO_ENABLE_TRADING` is not `1`.
 */
export function loadTradingGuards(env: NodeJS.ProcessEnv = process.env): TradingGuards {
  if (env.ROBINHOOD_CRYPTO_ENABLE_TRADING?.trim() !== '1') {
    throw new TradingDisabledError(
      'Trading is disabled. This server places real orders with real money and has no sandbox. ' +
        'Set ROBINHOOD_CRYPTO_ENABLE_TRADING=1 to enable it, and set ROBINHOOD_CRYPTO_MAX_ORDER_USD ' +
        'to a ceiling you are comfortable losing. Read-only tools are available without this flag ' +
        'via the `robinhood-crypto-mcp` data server.',
    );
  }

  const maxOrderUsd = parsePositiveNumber(
    env.ROBINHOOD_CRYPTO_MAX_ORDER_USD,
    DEFAULT_MAX_ORDER_USD,
    'ROBINHOOD_CRYPTO_MAX_ORDER_USD',
  );

  const allowlistRaw = env.ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST?.trim();
  const symbolAllowlist = allowlistRaw
    ? allowlistRaw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : null;

  return {
    maxOrderUsd,
    symbolAllowlist,
    buyOnly: env.ROBINHOOD_CRYPTO_BUY_ONLY?.trim() === '1',
  };
}

function parsePositiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new GuardViolationError(`${name} must be a positive number, got "${raw}".`);
  }
  return value;
}

export interface OrderIntent {
  symbol: string;
  side: 'buy' | 'sell';
  /** Notional USD value, when it can be determined before submitting. */
  notionalUsd: number | null;
}

/**
 * Check an order against the configured guards.
 *
 * @throws {GuardViolationError} On the first violated guard.
 */
export function assertOrderAllowed(intent: OrderIntent, guards: TradingGuards): void {
  const symbol = intent.symbol.toUpperCase();

  if (guards.symbolAllowlist && !guards.symbolAllowlist.includes(symbol)) {
    throw new GuardViolationError(
      `Symbol ${symbol} is not in ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST (${guards.symbolAllowlist.join(', ')}).`,
    );
  }

  if (guards.buyOnly && intent.side === 'sell') {
    throw new GuardViolationError('Sell orders are blocked by ROBINHOOD_CRYPTO_BUY_ONLY=1.');
  }

  if (intent.notionalUsd === null) {
    throw new GuardViolationError(
      `Cannot determine the USD value of this ${symbol} order, so the ` +
        `ROBINHOOD_CRYPTO_MAX_ORDER_USD ceiling ($${guards.maxOrderUsd}) cannot be enforced. ` +
        'Specify quote_amount, or use a limit order where quantity x limit_price is known.',
    );
  }

  if (intent.notionalUsd > guards.maxOrderUsd) {
    throw new GuardViolationError(
      `Order value $${intent.notionalUsd.toFixed(2)} exceeds the ` +
        `ROBINHOOD_CRYPTO_MAX_ORDER_USD ceiling of $${guards.maxOrderUsd.toFixed(2)}. ` +
        'Reduce the size, or raise the ceiling deliberately.',
    );
  }
}

/**
 * Estimate an order's USD notional from its own parameters.
 *
 * Returns `null` when the value is not knowable up front — a market order sized
 * in asset quantity has no price until it fills. Callers must treat `null` as
 * "unenforceable", never as zero.
 */
export function estimateNotionalUsd(params: {
  quoteAmount?: string | undefined;
  assetQuantity?: string | undefined;
  limitPrice?: string | undefined;
  referencePrice?: number | undefined;
}): number | null {
  const { quoteAmount, assetQuantity, limitPrice, referencePrice } = params;

  if (quoteAmount !== undefined) {
    const value = Number(quoteAmount);
    return Number.isFinite(value) ? value : null;
  }

  if (assetQuantity !== undefined) {
    const quantity = Number(assetQuantity);
    if (!Number.isFinite(quantity)) return null;

    // A limit price bounds a buy exactly; a reference quote is the best
    // available estimate for a market order.
    const price = limitPrice !== undefined ? Number(limitPrice) : referencePrice;
    if (price === undefined || !Number.isFinite(price)) return null;
    return quantity * price;
  }

  return null;
}
