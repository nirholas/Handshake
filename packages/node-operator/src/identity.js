/**
 * Node identity: the operator's Solana ed25519 keypair.
 *
 * The node's public key (base58) IS its identity on the network: jobs are
 * routed to it, results are verified against it, and phase 4 settlement pays
 * it. The secret key never leaves the operator host; the platform only ever
 * sees signatures, which it verifies with tweetnacl against this pubkey.
 *
 * Key material lives in a single env var (OPERATOR_SECRET_KEY) as either a
 * base58 or base64 encoding of the 64-byte ed25519 secret key, or is
 * generated on first run and written to node-identity.json next to the
 * working directory so restarts keep the same identity.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode a base58 string to bytes (Bitcoin/Solana alphabet). */
export function base58Decode(str) {
	if (typeof str !== 'string' || str.length === 0) throw new Error('empty base58 string');
	const bytes = [0];
	for (const ch of str) {
		const idx = B58_ALPHABET.indexOf(ch);
		if (idx < 0) throw new Error(`invalid base58 character: ${ch}`);
		let carry = idx;
		for (let i = 0; i < bytes.length; i++) {
			carry += bytes[i] * 58;
			bytes[i] = carry & 0xff;
			carry >>= 8;
		}
		while (carry > 0) {
			bytes.push(carry & 0xff);
			carry >>= 8;
		}
	}
	// Leading '1's are leading zero bytes.
	for (const ch of str) {
		if (ch === '1') bytes.push(0);
		else break;
	}
	return Uint8Array.from(bytes.reverse());
}

/** Encode bytes as base58 (Bitcoin/Solana alphabet). */
export function base58Encode(bytes) {
	if (!bytes || bytes.length === 0) return '';
	const digits = [0];
	for (const byte of bytes) {
		let carry = byte;
		for (let i = 0; i < digits.length; i++) {
			carry += digits[i] << 8;
			digits[i] = carry % 58;
			carry = Math.floor(carry / 58);
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = Math.floor(carry / 58);
		}
	}
	let out = '';
	for (const byte of bytes) {
		if (byte === 0) out += '1';
		else break;
	}
	for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
	return out;
}

/**
 * A node identity: pubkey (base58), plus sign/verify closures bound to the
 * keypair. The secret key bytes are exposed only via `secretKey` for config
 * persistence; callers should treat the identity object as opaque.
 */
export function createIdentity(secretKeyBytes) {
	let keypair;
	if (secretKeyBytes) {
		const bytes =
			typeof secretKeyBytes === 'string'
				? parseSecretKey(secretKeyBytes)
				: Uint8Array.from(secretKeyBytes);
		keypair = nacl.sign.keyPair.fromSecretKey(bytes);
	} else {
		keypair = nacl.sign.keyPair();
	}
	const publicKey = base58Encode(keypair.publicKey);
	return {
		publicKey,
		secretKey: keypair.secretKey,
		/** Sign arbitrary bytes; returns base64 signature. */
		sign(messageBytes) {
			return Buffer.from(nacl.sign.detached(messageBytes, keypair.secretKey)).toString('base64');
		},
		/** Sign a UTF-8 string; returns base64 signature. */
		signText(text) {
			return this.sign(new TextEncoder().encode(text));
		},
		/** Verify a base64 signature over UTF-8 text against this identity. */
		verify(text, signatureB64) {
			try {
				return nacl.sign.detached.verify(
					new TextEncoder().encode(text),
					Buffer.from(signatureB64, 'base64'),
					keypair.publicKey,
				);
			} catch {
				return false;
			}
		},
	};
}

/** Parse a secret key from env/config text: base58 or base64, 64 bytes either way. */
export function parseSecretKey(text) {
	const trimmed = String(text).trim();
	// Heuristic: base64 contains +/= or is 88 chars ending in =; base58 never does.
	if (/[+/=]/.test(trimmed)) {
		const bytes = Uint8Array.from(Buffer.from(trimmed, 'base64'));
		if (bytes.length !== 64) throw new Error(`secret key must decode to 64 bytes, got ${bytes.length}`);
		return bytes;
	}
	const bytes = base58Decode(trimmed);
	if (bytes.length !== 64) throw new Error(`secret key must decode to 64 bytes, got ${bytes.length}`);
	return bytes;
}

/**
 * Resolve the node identity for this process: OPERATOR_SECRET_KEY env var if
 * set, otherwise the persisted identity file, otherwise generate and persist
 * a fresh one. Returns { identity, source } where source is 'env' | 'file' |
 * 'generated'.
 */
export function resolveIdentity({ envSecret, identityPath }) {
	if (envSecret) {
		return { identity: createIdentity(parseSecretKey(envSecret)), source: 'env' };
	}
	if (identityPath && existsSync(identityPath)) {
		const saved = JSON.parse(readFileSync(identityPath, 'utf8'));
		if (saved?.secretKeyB64) {
			return {
				identity: createIdentity(Uint8Array.from(Buffer.from(saved.secretKeyB64, 'base64'))),
				source: 'file',
			};
		}
	}
	const identity = createIdentity();
	if (identityPath) {
		writeFileSync(
			identityPath,
			JSON.stringify({ publicKey: identity.publicKey, secretKeyB64: Buffer.from(identity.secretKey).toString('base64') }, null, 2),
			{ mode: 0o600 },
		);
	}
	return { identity, source: 'generated' };
}

/** Default identity file location, overridable for tests. */
export function defaultIdentityPath(cwd = process.cwd()) {
	return join(cwd, 'node-identity.json');
}
