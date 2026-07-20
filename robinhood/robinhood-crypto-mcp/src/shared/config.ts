/**
 * Environment configuration for both servers.
 *
 * Credentials are read from the environment only — never from arguments, and
 * never echoed back through a tool result.
 */

import { privateKeyFromBase64Seed, publicKeyBase64 } from './signer.js';
import type { KeyObject } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://trading.robinhood.com';

/** Robinhood documents 100 requests/minute per account, bursting to 300. */
export const RATE_LIMIT_PER_MINUTE = 100;
export const RATE_LIMIT_BURST = 300;

export type ApiVersion = 'v1' | 'v2';

export interface Credentials {
  apiKey: string;
  privateKey: KeyObject;
  baseUrl: string;
  apiVersion: ApiVersion;
}

export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingCredentialsError';
  }
}

const CREDENTIAL_HELP = [
  'Set ROBINHOOD_CRYPTO_API_KEY and ROBINHOOD_CRYPTO_PRIVATE_KEY.',
  'Create a credential at https://robinhood.com/account/crypto (web classic only):',
  'generate an Ed25519 keypair locally, register the PUBLIC key with Robinhood,',
  'and keep the base64 private key (a 32-byte seed) for this server.',
  'Run `npx robinhood-crypto-mcp keygen` to generate a conforming keypair.',
].join(' ');

/**
 * Load credentials from the environment.
 *
 * @throws {MissingCredentialsError} If either credential is absent.
 */
export function loadCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  const apiKey = env.ROBINHOOD_CRYPTO_API_KEY?.trim();
  const privateKeyRaw = env.ROBINHOOD_CRYPTO_PRIVATE_KEY?.trim();

  if (!apiKey || !privateKeyRaw) {
    const missing = [
      !apiKey && 'ROBINHOOD_CRYPTO_API_KEY',
      !privateKeyRaw && 'ROBINHOOD_CRYPTO_PRIVATE_KEY',
    ]
      .filter(Boolean)
      .join(' and ');
    throw new MissingCredentialsError(`Missing ${missing}. ${CREDENTIAL_HELP}`);
  }

  const apiVersion = parseApiVersion(env.ROBINHOOD_CRYPTO_API_VERSION);

  return {
    apiKey,
    privateKey: privateKeyFromBase64Seed(privateKeyRaw),
    baseUrl: (env.ROBINHOOD_CRYPTO_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiVersion,
  };
}

function parseApiVersion(raw: string | undefined): ApiVersion {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'v1';
  if (value === 'v1' || value === 'v2') return value;
  throw new MissingCredentialsError(
    `ROBINHOOD_CRYPTO_API_VERSION must be "v1" or "v2", got "${raw}".`,
  );
}

/**
 * The public key matching the configured private key, for verifying that the
 * key registered with Robinhood is the one this server holds.
 */
export function configuredPublicKey(credentials: Credentials): string {
  return publicKeyBase64(credentials.privateKey);
}

/**
 * Redact credential material from any string before it reaches a log line or
 * a tool result. Error paths stringify request context, and that context can
 * carry the API key.
 */
export function redact(text: string, credentials?: Pick<Credentials, 'apiKey'>): string {
  if (!credentials?.apiKey) return text;
  return text.split(credentials.apiKey).join('[redacted-api-key]');
}
