#!/usr/bin/env node
/**
 * Generate an Ed25519 keypair in the exact format Robinhood expects.
 *
 * Enrollment is a two-sided exchange that trips people up: you generate the
 * keypair locally, hand Robinhood the *public* key, and keep the *private*
 * key. Robinhood then issues an API key. Getting the halves backwards, or
 * pasting a 64-byte expanded key, is the most common cause of 401s.
 */

import { generateKeyPairSync } from 'node:crypto';
import { isMain } from './shared/is-main.js';

export interface GeneratedKeypair {
  privateKeyBase64: string;
  publicKeyBase64: string;
}

/**
 * Generate a keypair, returning both halves base64-encoded.
 *
 * The private key is emitted as the raw 32-byte seed (extracted from its
 * PKCS#8 wrapper), which is the form Robinhood's API expects.
 */
export function generateKeypair(): GeneratedKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });

  // The raw 32-byte key is the tail of each DER document (RFC 8410).
  return {
    privateKeyBase64: pkcs8.subarray(pkcs8.length - 32).toString('base64'),
    publicKeyBase64: spki.subarray(spki.length - 32).toString('base64'),
  };
}

export function main(): void {
  const { privateKeyBase64, publicKeyBase64 } = generateKeypair();

  // stdout stays parseable for scripting; guidance goes to stderr.
  console.error('Robinhood Crypto API keypair\n');
  console.error('1. Register the PUBLIC key at https://robinhood.com/account/crypto');
  console.error('   (web classic only — not the mobile app, not the new web UI).');
  console.error('2. Robinhood issues an API key. Set it as ROBINHOOD_CRYPTO_API_KEY.');
  console.error('3. Set the PRIVATE key below as ROBINHOOD_CRYPTO_PRIVATE_KEY.');
  console.error('   Treat it like a password: it authorizes trades. Never commit it.\n');

  console.log(JSON.stringify({ publicKeyBase64, privateKeyBase64 }, null, 2));
}

if (isMain(import.meta.url)) {
  main();
}
