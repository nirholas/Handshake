import { describe, it, expect } from 'vitest';
import {
  loadTradingGuards,
  assertOrderAllowed,
  estimateNotionalUsd,
  GuardViolationError,
  TradingDisabledError,
  DEFAULT_MAX_ORDER_USD,
} from '../src/shared/guards.js';

const enabled = (extra: Record<string, string> = {}) =>
  ({ ROBINHOOD_CRYPTO_ENABLE_TRADING: '1', ...extra }) as NodeJS.ProcessEnv;

describe('trading opt-in', () => {
  it('refuses to load guards unless trading is explicitly enabled', () => {
    expect(() => loadTradingGuards({} as NodeJS.ProcessEnv)).toThrow(TradingDisabledError);
    expect(() =>
      loadTradingGuards({ ROBINHOOD_CRYPTO_ENABLE_TRADING: 'true' } as NodeJS.ProcessEnv),
    ).toThrow(TradingDisabledError);
    expect(() =>
      loadTradingGuards({ ROBINHOOD_CRYPTO_ENABLE_TRADING: '0' } as NodeJS.ProcessEnv),
    ).toThrow(TradingDisabledError);
  });

  it('loads a conservative default cap when enabled', () => {
    expect(loadTradingGuards(enabled()).maxOrderUsd).toBe(DEFAULT_MAX_ORDER_USD);
  });

  it('rejects a non-positive or malformed cap rather than defaulting silently', () => {
    for (const bad of ['0', '-5', 'abc']) {
      expect(() => loadTradingGuards(enabled({ ROBINHOOD_CRYPTO_MAX_ORDER_USD: bad }))).toThrow(
        GuardViolationError,
      );
    }
  });

  it('parses an allowlist into normalized symbols', () => {
    const guards = loadTradingGuards(
      enabled({ ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST: 'btc-usd, eth-usd' }),
    );
    expect(guards.symbolAllowlist).toEqual(['BTC-USD', 'ETH-USD']);
  });
});

describe('assertOrderAllowed', () => {
  const guards = { maxOrderUsd: 100, symbolAllowlist: null, buyOnly: false };

  it('allows an order within the cap', () => {
    expect(() =>
      assertOrderAllowed({ symbol: 'BTC-USD', side: 'buy', notionalUsd: 99.99 }, guards),
    ).not.toThrow();
  });

  it('blocks an order above the cap', () => {
    expect(() =>
      assertOrderAllowed({ symbol: 'BTC-USD', side: 'buy', notionalUsd: 100.01 }, guards),
    ).toThrow(/exceeds the .* ceiling/);
  });

  it('refuses to place an order whose value cannot be determined', () => {
    // Fails closed: an unknown notional must never be treated as zero.
    expect(() =>
      assertOrderAllowed({ symbol: 'BTC-USD', side: 'buy', notionalUsd: null }, guards),
    ).toThrow(/Cannot determine the USD value/);
  });

  it('enforces the symbol allowlist', () => {
    const restricted = { ...guards, symbolAllowlist: ['BTC-USD'] };
    expect(() =>
      assertOrderAllowed({ symbol: 'DOGE-USD', side: 'buy', notionalUsd: 10 }, restricted),
    ).toThrow(/not in ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST/);
    expect(() =>
      assertOrderAllowed({ symbol: 'btc-usd', side: 'buy', notionalUsd: 10 }, restricted),
    ).not.toThrow();
  });

  it('blocks sells in buy-only mode', () => {
    const buyOnly = { ...guards, buyOnly: true };
    expect(() =>
      assertOrderAllowed({ symbol: 'BTC-USD', side: 'sell', notionalUsd: 10 }, buyOnly),
    ).toThrow(/blocked by ROBINHOOD_CRYPTO_BUY_ONLY/);
    expect(() =>
      assertOrderAllowed({ symbol: 'BTC-USD', side: 'buy', notionalUsd: 10 }, buyOnly),
    ).not.toThrow();
  });
});

describe('estimateNotionalUsd', () => {
  it('uses quote_amount directly when given', () => {
    expect(estimateNotionalUsd({ quoteAmount: '25.50' })).toBe(25.5);
  });

  it('multiplies quantity by limit price for a limit order', () => {
    expect(estimateNotionalUsd({ assetQuantity: '0.5', limitPrice: '100' })).toBe(50);
  });

  it('falls back to a live reference price for a market order', () => {
    expect(estimateNotionalUsd({ assetQuantity: '2', referencePrice: 30 })).toBe(60);
  });

  it('prefers the limit price over the reference price when both exist', () => {
    expect(estimateNotionalUsd({ assetQuantity: '1', limitPrice: '10', referencePrice: 999 })).toBe(
      10,
    );
  });

  it('returns null when no price is available, rather than guessing', () => {
    expect(estimateNotionalUsd({ assetQuantity: '1' })).toBeNull();
    expect(estimateNotionalUsd({})).toBeNull();
  });

  it('returns null for unparseable numbers instead of NaN', () => {
    expect(estimateNotionalUsd({ quoteAmount: 'abc' })).toBeNull();
    expect(estimateNotionalUsd({ assetQuantity: 'abc', referencePrice: 10 })).toBeNull();
  });
});
