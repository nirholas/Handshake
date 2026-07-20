/**
 * Library entry point.
 *
 * The signed client is usable on its own, without MCP, for anyone who wants a
 * correct Robinhood Crypto Trading API client in Node.
 */

export { RobinhoodCryptoClient, RobinhoodApiError } from './shared/client.js';
export {
  buildAuthHeaders,
  buildSignatureMessage,
  privateKeyFromBase64Seed,
  publicKeyBase64,
  publicKeyFromBase64,
  currentTimestampSeconds,
  InvalidPrivateKeyError,
  TIMESTAMP_VALIDITY_SECONDS,
} from './shared/signer.js';
export {
  loadCredentials,
  configuredPublicKey,
  MissingCredentialsError,
  DEFAULT_BASE_URL,
  type Credentials,
  type ApiVersion,
} from './shared/config.js';
export { endpointsFor, requiresAccountNumber, type EndpointSet } from './shared/endpoints.js';
export {
  loadTradingGuards,
  assertOrderAllowed,
  estimateNotionalUsd,
  GuardViolationError,
  TradingDisabledError,
  type TradingGuards,
} from './shared/guards.js';
export { createDataServer } from './data-server.js';
export { createTradingServer } from './trading-server.js';
export { VERSION } from './version.js';
