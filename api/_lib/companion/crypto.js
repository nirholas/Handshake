// Encrypt/decrypt a companion source's BYOK credentials at rest.
//
// Same AES-256-GCM + HKDF construction as api/_lib/provider-keys.js, with its
// own salt so a bot token can never be decrypted by a key derived for another
// key space. The plaintext is a small JSON blob (bot token, IMAP password, a
// calendar's secret ICS URL), so it round-trips as a string.

import { webcrypto } from 'node:crypto';
import { env } from '../env.js';

const subtle = globalThis.crypto?.subtle || webcrypto.subtle;

function randomBytes(n) {
	const b = new Uint8Array(n);
	(globalThis.crypto || webcrypto).getRandomValues(b);
	return b;
}

async function deriveKey() {
	const raw = new TextEncoder().encode(env.JWT_SECRET);
	const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
	return subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new TextEncoder().encode('companion-source-config-v1'),
			info: new Uint8Array(0),
		},
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

export async function encryptConfig(config) {
	const key = await deriveKey();
	const iv = randomBytes(12);
	const data = new TextEncoder().encode(JSON.stringify(config));
	const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
	const buf = new Uint8Array(iv.length + ct.byteLength);
	buf.set(iv, 0);
	buf.set(new Uint8Array(ct), iv.length);
	return Buffer.from(buf).toString('base64');
}

export async function decryptConfig(ciphertext) {
	const key = await deriveKey();
	const raw = Buffer.from(ciphertext, 'base64');
	const plain = await subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
	return JSON.parse(new TextDecoder().decode(plain));
}

// What the UI is allowed to see about a stored credential: enough to recognise
// which account is connected, never enough to reuse it elsewhere.
export function redactConfig(kind, config) {
	if (!config || typeof config !== 'object') return {};
	if (kind === 'telegram') {
		const token = String(config.bot_token || '');
		return { bot_username: config.bot_username || null, bot_token_hint: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : null };
	}
	if (kind === 'calendar') {
		let host = null;
		try { host = new URL(config.ics_url).host; } catch { host = null; }
		return { ics_host: host, lookahead_minutes: config.lookahead_minutes || 60 };
	}
	if (kind === 'email') {
		return { host: config.host || null, port: config.port || null, user: config.user || null, folder: config.folder || 'INBOX' };
	}
	return {};
}
