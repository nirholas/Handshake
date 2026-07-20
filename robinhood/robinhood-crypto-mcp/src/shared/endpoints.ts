/**
 * Path resolution for the two documented API versions.
 *
 * v2 adds fee-tier information to orders and accounts. It is not a drop-in
 * replacement: several v2 endpoints require an `account_number` query
 * parameter, and `estimated_price` moves from `/marketdata/` to `/trading/`.
 * Those asymmetries are in Robinhood's own spec, not transcription errors.
 *
 * @see docs/openapi-extracted.json - the upstream OpenAPI document
 */

import type { ApiVersion } from './config.js';

export interface EndpointSet {
  accounts: string;
  tradingPairs: string;
  holdings: string;
  orders: string;
  order: (orderId: string) => string;
  cancelOrder: (orderId: string) => string;
  bestBidAsk: string;
  estimatedPrice: string;
}

const V1: EndpointSet = {
  accounts: '/api/v1/crypto/trading/accounts/',
  tradingPairs: '/api/v1/crypto/trading/trading_pairs/',
  holdings: '/api/v1/crypto/trading/holdings/',
  orders: '/api/v1/crypto/trading/orders/',
  order: (id) => `/api/v1/crypto/trading/orders/${encodeURIComponent(id)}/`,
  cancelOrder: (id) => `/api/v1/crypto/trading/orders/${encodeURIComponent(id)}/cancel/`,
  bestBidAsk: '/api/v1/crypto/marketdata/best_bid_ask/',
  estimatedPrice: '/api/v1/crypto/marketdata/estimated_price/',
};

const V2: EndpointSet = {
  accounts: '/api/v2/crypto/trading/accounts/',
  tradingPairs: '/api/v2/crypto/trading/trading_pairs/',
  holdings: '/api/v2/crypto/trading/holdings/',
  orders: '/api/v2/crypto/trading/orders/',
  order: (id) => `/api/v2/crypto/trading/orders/${encodeURIComponent(id)}/`,
  cancelOrder: (id) => `/api/v2/crypto/trading/orders/${encodeURIComponent(id)}/cancel/`,
  bestBidAsk: '/api/v2/crypto/marketdata/best_bid_ask/',
  // Not a typo: v2 serves estimated price under /trading/, unlike v1.
  estimatedPrice: '/api/v2/crypto/trading/estimated_price/',
};

export function endpointsFor(version: ApiVersion): EndpointSet {
  return version === 'v2' ? V2 : V1;
}

/** Endpoints where v2 requires an `account_number` query parameter. */
export function requiresAccountNumber(version: ApiVersion): boolean {
  return version === 'v2';
}
