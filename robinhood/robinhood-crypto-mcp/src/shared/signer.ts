/**
 * Ed25519 request signing for the Robinhood Crypto Trading API.
 *
 * Robinhood authenticates every request with three headers — `x-api-key`,
 * `x-timestamp`, and `x-signature` — where the signature is a detached Ed25519
 * signature over:
 *
 *     message = api_key + timestamp + path + method + body
 *
 * concatenated with no separators. The private key Robinhood issues is a
 * base64-encoded 32-byte Ed25519 *seed*, not an expanded 64-byte keypair and
 * not PKCS#8 — mixing those up is the most common integration failure.
 *
 * @see https://docs.robinhood.com/crypto/trading/
 */

import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';

/**
 * DER prefix that wraps a raw 32-byte Ed25519 seed into a PKCS#8 document,
 * which is the only private-key form `node:crypto` accepts (RFC 8410 §7).
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** DER prefix wrapping a raw 32-byte Ed25519 public key into SPKI form. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const ED25519_SEED_BYTES = 32;

export class InvalidPrivateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPrivateKeyError';
  }
}

/**
 * Turn Robinhood's base64 private key into a Node key object.
 *
 * @param base64Seed - The base64 private key exactly as issued by Robinhood.
 * @throws {InvalidPrivateKeyError} If the value does not decode to 32 bytes.
 */
export function privateKeyFromBase64Seed(base64Seed: string): KeyObject {
  const trimmed = base64Seed.trim();
  let seed: Buffer;
  try {
    seed = Buffer.from(trimmed, 'base64');
  } catch {
    throw new InvalidPrivateKeyError('Private key is not valid base64.');
  }

  if (seed.length !== ED25519_SEED_BYTES) {
    // The 64-byte case is worth calling out by name: several Ed25519 libraries
    // export seed‖publicKey and users paste that in expecting it to work.
    const hint =
      seed.length === 64
        ? ' This looks like an expanded 64-byte keypair (seed‖publicKey); Robinhood issues the 32-byte seed, which is its first half.'
        : '';
    throw new InvalidPrivateKeyError(
      `Private key must decode to ${ED25519_SEED_BYTES} bytes, got ${seed.length}.${hint}`,
    );
  }

  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Derive the base64 public key for a private key, which is what you register
 * with Robinhood when creating an API credential. Lets a caller confirm a
 * stored private key still corresponds to the enrolled public key.
 */
export function publicKeyBase64(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - ED25519_SEED_BYTES).toString('base64');
}

/** Build a raw Ed25519 public key object from Robinhood's base64 form. */
export function publicKeyFromBase64(base64Key: string): KeyObject {
  const raw = Buffer.from(base64Key.trim(), 'base64');
  if (raw.length !== ED25519_SEED_BYTES) {
    throw new InvalidPrivateKeyError(
      `Public key must decode to ${ED25519_SEED_BYTES} bytes, got ${raw.length}.`,
    );
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Build the exact byte string Robinhood signs.
 *
 * `path` must include the query string, and `body` must be the exact serialized
 * JSON that goes on the wire — serialize once, sign that string, send that same
 * string. Re-serializing between signing and sending changes key order or
 * whitespace and yields a well-formed request with an invalid signature.
 */
export function buildSignatureMessage(params: {
  apiKey: string;
  timestamp: number;
  path: string;
  method: string;
  body?: string;
}): string {
  const { apiKey, timestamp, path, method, body = '' } = params;
  return `${apiKey}${timestamp}${path}${method.toUpperCase()}${body}`;
}

export interface AuthHeaders {
  'x-api-key': string;
  'x-signature': string;
  'x-timestamp': string;
}

/**
 * Produce the three authentication headers for a request.
 *
 * @param timestamp - Unix time in **seconds**. Robinhood rejects timestamps
 *   older than 30 seconds, so this must be seconds, not `Date.now()`.
 */
export function buildAuthHeaders(params: {
  apiKey: string;
  privateKey: KeyObject;
  path: string;
  method: string;
  body?: string;
  timestamp?: number;
}): AuthHeaders {
  const timestamp = params.timestamp ?? currentTimestampSeconds();
  const message = buildSignatureMessage({
    apiKey: params.apiKey,
    timestamp,
    path: params.path,
    method: params.method,
    body: params.body,
  });

  const signature = sign(null, Buffer.from(message, 'utf8'), params.privateKey);

  return {
    'x-api-key': params.apiKey,
    'x-signature': signature.toString('base64'),
    'x-timestamp': String(timestamp),
  };
}

/** Unix timestamp in seconds, the unit Robinhood expects. */
export function currentTimestampSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Robinhood rejects a signature whose timestamp is older than this. */
export const TIMESTAMP_VALIDITY_SECONDS = 30;
