// Encryption for stored GitHub OAuth access tokens.
//
// The key is derived from JWT_SECRET with HKDF-SHA256 and the fixed salt
// 'github-token', so a rotated JWT_SECRET invalidates stored tokens (the user
// reconnects) rather than decrypting them into garbage. This module is the one
// definition of that derivation: the OAuth callback, the seeding endpoints, and
// disconnect all import it, so the salt can never drift between writer and
// reader.

import { webcrypto } from 'node:crypto';
import { env } from './env.js';

const subtle = globalThis.crypto?.subtle || webcrypto.subtle;
const IV_BYTES = 12;

async function deriveKey(usages) {
	const raw = new TextEncoder().encode(env.JWT_SECRET);
	const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
	return subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new TextEncoder().encode('github-token'),
			info: new Uint8Array(0),
		},
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		usages,
	);
}

export async function encryptGithubToken(plaintext) {
	const key = await deriveKey(['encrypt', 'decrypt']);
	const iv = new Uint8Array(IV_BYTES);
	(globalThis.crypto || webcrypto).getRandomValues(iv);
	const ct = await subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	const buf = new Uint8Array(iv.length + ct.byteLength);
	buf.set(iv, 0);
	buf.set(new Uint8Array(ct), iv.length);
	return Buffer.from(buf).toString('base64');
}

export async function decryptGithubToken(ciphertext) {
	const key = await deriveKey(['decrypt']);
	const buf = Buffer.from(ciphertext, 'base64');
	const iv = buf.subarray(0, IV_BYTES);
	const ct = buf.subarray(IV_BYTES);
	const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
	return new TextDecoder().decode(plain);
}
