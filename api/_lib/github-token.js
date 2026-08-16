// Encryption and scope policy for stored GitHub access tokens.
//
// The key is derived from JWT_SECRET with HKDF-SHA256 and the fixed salt
// 'github-token', so a rotated JWT_SECRET invalidates stored tokens (the user
// reconnects) rather than decrypting them into garbage. This module is the one
// definition of that derivation: the OAuth callback, the seeding endpoints, and
// disconnect all import it, so the salt can never drift between writer and
// reader.
//
// It also owns the scope policy for the personal-access-token connect path,
// which is the route in when a deployment has no GitHub OAuth app registered.

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

// ── Personal access token policy ──────────────────────────────────────────────

/**
 * Classic-PAT scopes this platform will hold. Seeding reads a public profile,
 * public repositories, and their READMEs, so nothing beyond the user surface and
 * public repository data is ever needed. The list is an allowlist rather than a
 * denylist on purpose: a scope GitHub invents after this code is written is
 * refused by default instead of being silently accepted.
 *
 * `repo` is deliberately absent. It grants read AND write on private
 * repositories, and the catalog is public-only by construction, so a token
 * carrying it would hand us far more access than the feature can ever use.
 */
export const ALLOWED_TOKEN_SCOPES = Object.freeze([
	'read:user',
	'user:email',
	'user:follow',
	'user',
	'public_repo',
	'repo:status',
	'read:org',
]);

/** The scopes we ask people to tick, in the order the docs list them. */
export const RECOMMENDED_TOKEN_SCOPES = Object.freeze(['read:user']);

/**
 * Decide whether a token GitHub just accepted is one we are willing to store.
 *
 * GitHub reports a classic PAT's grants in the `x-oauth-scopes` response header.
 * Fine-grained tokens and GitHub App user tokens omit the header entirely: their
 * permissions were already narrowed by the person who minted them, and there is
 * no scope string to audit, so they are accepted as-is.
 *
 * @param {string|null|undefined} header raw `x-oauth-scopes` response header
 * @returns {{kind: 'fine_grained'|'classic', scopes: string[], allowed: boolean, refused: string[]}}
 */
export function classifyTokenScopes(header) {
	if (header == null) return { kind: 'fine_grained', scopes: [], allowed: true, refused: [] };

	const scopes = String(header)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const refused = scopes.filter((s) => !ALLOWED_TOKEN_SCOPES.includes(s));
	return { kind: 'classic', scopes, allowed: refused.length === 0, refused };
}

/**
 * Shape-check a pasted token before spending a GitHub round trip on it. This
 * only rejects input that cannot be a token at all (blank, containing
 * whitespace, absurdly long); GitHub itself is the authority on validity.
 */
export function looksLikeGithubToken(value) {
	if (typeof value !== 'string') return false;
	const token = value.trim();
	return token.length >= 20 && token.length <= 255 && !/\s/.test(token);
}
