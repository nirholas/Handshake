// Vanity inventory vault — the single seal/open primitive for pre-ground private
// keys held in `vanity_inventory`.
//
// WHY THIS EXISTS (and why not just secret-box directly):
// The platform's strongest at-rest primitive is api/_lib/secret-box.js —
// AES-256-GCM under a dedicated WALLET_ENCRYPTION_KEY with a random per-record
// salt, fail-closed in production. It already protects agent wallet keys and
// pump.fun creator keys, so it is the correct, consistent default here and IS
// strong enough against a DB dump (keys are unreadable without the env key).
//
// Inventory adds ONE threat secret-box alone does not address: INSIDER ACCESS.
// secret-box's key is an env var — anyone who can read the delivery service's
// environment can decrypt every stored key offline, forever. For a store whose
// entire value is unspent private keys, that is worth defense-in-depth. So this
// vault supports an OPTIONAL GCP-KMS ENVELOPE layer: a fresh 32-byte data-key
// (DEK) encrypts each payload with AES-256-GCM, and the DEK is wrapped by a KMS
// crypto key whose decrypt permission is granted (via IAM) ONLY to the delivery
// service identity. A DB dump then yields nothing; even the env key yields
// nothing without a KMS decrypt call that IAM can revoke and Cloud Audit Logs
// record. When VANITY_KMS_KEY is unset the vault transparently uses secret-box —
// no feature breaks, no plaintext is ever exposed either way.
//
// Both schemes are authenticated (AES-GCM), so a wrong key throws rather than
// returning garbage plaintext. Nothing in this module logs secret material.

import { webcrypto } from 'node:crypto';
import { encryptSecret, decryptSecret } from './secret-box.js';
import { getGcpAccessToken } from './gcp-auth.js';
import { fetchUpstream } from './upstream-fetch.js';

// KMS encrypt/decrypt are idempotent (same DEK in, same wrap out), so a
// transient failure is retried behind one breaker for the KMS host.
const KMS_FETCH_OPTS = { name: 'gcp-kms', timeoutMs: 10_000, attempts: 3, okWhen: () => true };

const subtle = globalThis.crypto?.subtle || webcrypto.subtle;
const randomBytes = (n) => {
	const b = new Uint8Array(n);
	(globalThis.crypto || webcrypto).getRandomValues(b);
	return b;
};

// Scheme tags — persisted in vanity_inventory.secret_scheme and self-described in
// the ciphertext prefix so open() can dispatch even if the column drifts.
export const SCHEME_SECRETBOX = 'aes-256-gcm';
export const SCHEME_KMS_ENVELOPE = 'gcp-kms+aes-256-gcm';
const KMS_PREFIX = 'kms1:';

const readEnv = (name) =>
	typeof process !== 'undefined' && process.env?.[name] ? process.env[name].trim() : '';

// The KMS crypto-key resource name:
//   projects/<P>/locations/<L>/keyRings/<R>/cryptoKeys/<K>
// When present (and reachable), sealing uses the envelope scheme.
export function kmsKeyName() {
	return readEnv('VANITY_KMS_KEY');
}

/** True when the KMS envelope layer is configured (does not prove reachability). */
export function kmsConfigured() {
	return Boolean(kmsKeyName());
}

/** The scheme sealSecret() will use given current configuration. */
export function preferredScheme() {
	return kmsConfigured() ? SCHEME_KMS_ENVELOPE : SCHEME_SECRETBOX;
}

// ── KMS REST: wrap/unwrap a 32-byte DEK ──────────────────────────────────────
// Uses the shared service-account OAuth token (api/_lib/gcp-auth.js) — the same
// credential Vertex uses. On Cloud Run / GCE the attached SA works with no env.
async function kmsEncrypt(dek) {
	const token = await getGcpAccessToken();
	const url = `https://cloudkms.googleapis.com/v1/${kmsKeyName()}:encrypt`;
	const res = await fetchUpstream(url, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ plaintext: Buffer.from(dek).toString('base64') }),
	}, KMS_FETCH_OPTS);
	if (!res.ok) {
		const detail = await res.text().catch(() => res.status);
		throw new Error(`KMS encrypt failed (${res.status}): ${String(detail).slice(0, 300)}`);
	}
	const data = await res.json();
	return data.ciphertext; // base64 wrapped DEK
}

async function kmsDecrypt(wrappedDekB64) {
	const token = await getGcpAccessToken();
	const url = `https://cloudkms.googleapis.com/v1/${kmsKeyName()}:decrypt`;
	const res = await fetchUpstream(url, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ ciphertext: wrappedDekB64 }),
	}, KMS_FETCH_OPTS);
	if (!res.ok) {
		const detail = await res.text().catch(() => res.status);
		throw new Error(`KMS decrypt failed (${res.status}): ${String(detail).slice(0, 300)}`);
	}
	const data = await res.json();
	return new Uint8Array(Buffer.from(data.plaintext, 'base64')); // 32-byte DEK
}

// AES-256-GCM under a raw 32-byte DEK. Layout inside the envelope: iv[12] || ct.
async function aesGcmEncryptRaw(dek, plaintext) {
	const key = await subtle.importKey('raw', dek, { name: 'AES-GCM' }, false, ['encrypt']);
	const iv = randomBytes(12);
	const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
	return { iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(new Uint8Array(ct)).toString('base64') };
}

async function aesGcmDecryptRaw(dek, ivB64, ctB64) {
	const key = await subtle.importKey('raw', dek, { name: 'AES-GCM' }, false, ['decrypt']);
	const iv = new Uint8Array(Buffer.from(ivB64, 'base64'));
	const ct = new Uint8Array(Buffer.from(ctB64, 'base64'));
	const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
	return new TextDecoder().decode(plain);
}

/**
 * Seal a plaintext secret for at-rest storage in vanity_inventory.
 *
 * @param {string} plaintext - the secret JSON/string (e.g. the 64-byte key + meta).
 * @returns {Promise<{ ciphertext: string, scheme: string }>}
 *
 * Uses the KMS envelope when VANITY_KMS_KEY is set, else secret-box. If the KMS
 * path is configured but the encrypt call fails, sealing FAILS CLOSED (throws) —
 * we never silently downgrade a key the operator asked KMS to protect. (The
 * unconfigured path is the deliberate, documented secret-box default.)
 */
export async function sealSecret(plaintext) {
	if (typeof plaintext !== 'string' || !plaintext) {
		throw new Error('sealSecret: plaintext must be a non-empty string');
	}
	if (kmsConfigured()) {
		const dek = randomBytes(32);
		const { iv, ct } = await aesGcmEncryptRaw(dek, plaintext);
		const wrappedDek = await kmsEncrypt(dek);
		// Best-effort scrub of the DEK from memory after wrapping.
		dek.fill(0);
		const envelope = { v: 1, k: kmsKeyName(), dek: wrappedDek, iv, ct };
		const ciphertext = KMS_PREFIX + Buffer.from(JSON.stringify(envelope)).toString('base64');
		return { ciphertext, scheme: SCHEME_KMS_ENVELOPE };
	}
	const ciphertext = await encryptSecret(plaintext);
	return { ciphertext, scheme: SCHEME_SECRETBOX };
}

/**
 * Open a sealed secret. Dispatches on the ciphertext's own prefix first (robust
 * to a drifted scheme column), falling back to the provided scheme hint.
 *
 * @param {string} ciphertext
 * @param {string} [scheme]
 * @returns {Promise<string>} the plaintext secret.
 */
export async function openSecret(ciphertext, scheme) {
	if (typeof ciphertext !== 'string' || !ciphertext) {
		throw new Error('openSecret: missing ciphertext (already destroyed?)');
	}
	const isKms = ciphertext.startsWith(KMS_PREFIX) || scheme === SCHEME_KMS_ENVELOPE;
	if (isKms) {
		if (!ciphertext.startsWith(KMS_PREFIX)) {
			throw new Error('openSecret: scheme says KMS but ciphertext is not a KMS envelope');
		}
		const envelope = JSON.parse(Buffer.from(ciphertext.slice(KMS_PREFIX.length), 'base64').toString('utf8'));
		const dek = await kmsDecrypt(envelope.dek);
		try {
			return await aesGcmDecryptRaw(dek, envelope.iv, envelope.ct);
		} finally {
			dek.fill(0);
		}
	}
	return decryptSecret(ciphertext);
}
