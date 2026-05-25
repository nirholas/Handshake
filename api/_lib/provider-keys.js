// Encrypt/decrypt user BYOK provider keys at rest.
// Same AES-256-GCM + HKDF pattern as agent-wallet.js but with a distinct salt
// so the two key spaces never collide.

import { webcrypto } from 'node:crypto';
import { env } from './env.js';

const subtle = globalThis.crypto?.subtle || webcrypto.subtle;
const randomBytes = (n) => {
	const b = new Uint8Array(n);
	(globalThis.crypto || webcrypto).getRandomValues(b);
	return b;
};

async function deriveKey() {
	const raw = new TextEncoder().encode(env.JWT_SECRET);
	const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
	return subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new TextEncoder().encode('user-provider-keys-v1'),
			info: new Uint8Array(0),
		},
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

export async function encryptProviderKey(plaintext) {
	const key = await deriveKey();
	const iv = randomBytes(12);
	const data = new TextEncoder().encode(plaintext);
	const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
	const buf = new Uint8Array(iv.length + ct.byteLength);
	buf.set(iv, 0);
	buf.set(new Uint8Array(ct), iv.length);
	return Buffer.from(buf).toString('base64');
}

export async function decryptProviderKey(ciphertext) {
	const key = await deriveKey();
	const raw = Buffer.from(ciphertext, 'base64');
	const iv = raw.subarray(0, 12);
	const ct = raw.subarray(12);
	const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
	return new TextDecoder().decode(plain);
}

// Providers users can BYOK. openrouter + groq are platform-provided; never stored.
export const BYOK_PROVIDERS = {
	anthropic: { label: 'Anthropic', prefix: 'sk-ant-', hint: 'console.anthropic.com/settings/keys' },
	openai:    { label: 'OpenAI',    prefix: 'sk-',     hint: 'platform.openai.com/api-keys' },
};

// Load and decrypt all stored provider keys for a user.
// Returns { anthropic: 'sk-ant-...', openai: 'sk-...' } with only the set ones.
export async function loadUserProviderKeys(encryptedMap) {
	if (!encryptedMap || typeof encryptedMap !== 'object') return {};
	const result = {};
	await Promise.all(
		Object.entries(encryptedMap).map(async ([provider, encrypted]) => {
			if (typeof encrypted !== 'string' || !encrypted) return;
			try {
				result[provider] = await decryptProviderKey(encrypted);
			} catch {
				// corrupted entry — skip silently
			}
		}),
	);
	return result;
}
