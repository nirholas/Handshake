/**
 * Sealed envelope — hybrid public-key encryption for one-time secret delivery.
 *
 * The vanity grinder hands a freshly-ground Solana secret key back to the
 * buyer. By default that secret travels in the response body in the clear
 * (TLS only). A caller who would rather the platform never see their secret in
 * plaintext — not in transit, not in a proxy log, not in an idempotency cache —
 * supplies an X25519 public key up front; the server seals the secret to it so
 * only the holder of the matching private key can open it.
 *
 * Scheme `x25519-hkdf-sha256-aes256gcm/v1` (ECIES over Curve25519):
 *   1. Generate an ephemeral X25519 keypair `e`.
 *   2. shared = X25519(e.secret, recipientPublicKey).
 *   3. key = HKDF-SHA256(ikm=shared, salt=e.public‖recipientPublicKey,
 *            info="three.ws sealed-envelope v1", 32 bytes).
 *   4. AES-256-GCM encrypt the plaintext under `key` with a random 12-byte
 *      nonce; the ephemeral public key is bound in as additional authenticated
 *      data so a swapped epk fails the tag check.
 *   5. Emit { scheme, epk, nonce, ciphertext, recipient } — all Base64url
 *      except `epk`/`recipient`, which are Base58 to match Solana tooling.
 *
 * The ephemeral secret is discarded immediately, so the sealed envelope is
 * forward-secret with respect to the server: nothing retained on our side can
 * reconstruct the key. `openSealed` is the inverse and ships so clients, the
 * SDK, and tests share one verified implementation rather than reinventing the
 * decrypt against a prose spec.
 *
 * Isomorphic by construction: ECDH/HKDF come from @noble (pure JS), AES-GCM
 * from WebCrypto (`globalThis.crypto.subtle`), so it runs unchanged in Node
 * serverless functions and in the browser.
 */

import bs58 from 'bs58';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

export const SEALED_ENVELOPE_SCHEME = 'x25519-hkdf-sha256-aes256gcm/v1';
const HKDF_INFO = new TextEncoder().encode('three.ws sealed-envelope v1');
const X25519_KEY_BYTES = 32;

/**
 * Base58 length at which a 32-byte key cannot be confused with Base64url.
 * Base64url always spends exactly 43 characters on 32 bytes, so a 44-character
 * Base58 string is unambiguous while a 43-character one is not.
 */
export const X25519_UNAMBIGUOUS_B58_LENGTH = 44;
const NONCE_BYTES = 12;

const cryptoObj = globalThis.crypto;

// WebCrypto is checked at call time (not import time) so merely importing this
// module never throws in an exotic bundle — only sealing/opening requires subtle.
function subtle() {
	if (!cryptoObj?.subtle) {
		throw new Error('sealed-envelope requires WebCrypto (globalThis.crypto.subtle)');
	}
	return cryptoObj.subtle;
}

function randomBytes(n) {
	const b = new Uint8Array(n);
	cryptoObj.getRandomValues(b);
	return b;
}

/**
 * Run every decoder that accepts `s` and return the one 32-byte key they agree
 * on. Throws when two decoders yield two *different* 32-byte keys — that is a
 * real ambiguity in the input, and picking one is how a buyer ends up with an
 * envelope sealed to a key they do not hold.
 */
function disambiguate(s, label) {
	const found = new Map();
	for (const [name, decode] of Object.entries(KEY_DECODERS)) {
		let out;
		try {
			out = decode(s);
		} catch {
			continue;
		}
		if (out?.length !== X25519_KEY_BYTES) continue;
		found.set(bytesKey(out), { name, bytes: out });
	}
	if (found.size === 1) return [...found.values()][0].bytes;
	if (found.size === 0) throw new Error('no decoder produced a 32-byte key');
	const names = [...found.values()].map((v) => v.name).sort();
	throw Object.assign(
		new Error(
			`${label} is ambiguous: it is a valid ${names.join(' and ')} encoding of two different ` +
				`32-byte keys. Base58's alphabet is a subset of Base64url's and both encode 32 bytes ` +
				`in 43 characters, so the string alone cannot say which you meant. Prefix it to be ` +
				`explicit, e.g. "base58:${s}" or "base64url:${s}".`,
		),
		{ status: 400, code: 'ambiguous_recipient_key', candidates: names },
	);
}

function bytesKey(bytes) {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

function toBase64url(bytes) {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
	const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
	const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * Encodings `parseX25519Key` accepts, and the `name:` prefix that names each
 * one explicitly. An explicit prefix is the only way to be certain — see below.
 */
const KEY_DECODERS = {
	hex: (s) => {
		if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2) throw new Error('not hex');
		return Uint8Array.from(s.match(/.{2}/g).map((h) => parseInt(h, 16)));
	},
	base58: (s) => bs58.decode(s),
	base64url: (s) => fromBase64url(s),
};

/**
 * Parse a 32-byte X25519 key supplied as a Uint8Array, or as a Base58,
 * Base64url or hex string.
 *
 * ── The ambiguity this resolves ──────────────────────────────────────────────
 * Base58's alphabet is a strict SUBSET of Base64url's, and Base64url encodes 32
 * bytes in exactly 43 characters — the same length Base58 produces for the ~5.4%
 * of keys small enough to need only 43 digits. So a bare 43-character string can
 * be a valid encoding of two *different* 32-byte keys, with nothing in the string
 * itself to say which.
 *
 * Guessing is not harmless here. The previous implementation tried Base58 first
 * whenever the string contained no `-` or `_`, which measured at **1.5% of
 * Base64url keys mis-parsed, 95% of those silently** — the same characters
 * decoded to a valid-looking but wrong 32-byte key, the secret was sealed to it,
 * and the buyer could not open the envelope they had paid for.
 *
 * The fix is to let the caller be explicit, and to be honest when they were not:
 *
 *   • `hex:`, `base58:` or `base64url:` prefix → decoded as stated, no guessing.
 *   • 64 hex characters → unambiguously hex (no 32-byte Base58 or Base64url
 *     encoding is 64 characters long).
 *   • 44 characters → unambiguously Base58 (Base64url is always 43).
 *   • anything else → every applicable decoder is run, and a single 32-byte
 *     result wins. Two different 32-byte results is a genuine ambiguity and
 *     throws `ambiguous_recipient_key` naming the prefixes that resolve it,
 *     rather than silently picking one.
 *
 * @param {Uint8Array|string} key
 * @param {string} [label='key']
 * @returns {Uint8Array}
 */
export function parseX25519Key(key, label = 'key') {
	let bytes;
	if (key instanceof Uint8Array) {
		bytes = key;
	} else if (typeof key === 'string') {
		const s = key.trim();
		const explicit = /^(hex|base58|base64url):(.*)$/s.exec(s);
		try {
			if (explicit) {
				bytes = KEY_DECODERS[explicit[1]](explicit[2].trim());
			} else if (/^[0-9a-fA-F]{64}$/.test(s)) {
				bytes = KEY_DECODERS.hex(s);
			} else if (/^[1-9A-HJ-NP-Za-km-z]{44}$/.test(s)) {
				bytes = KEY_DECODERS.base58(s);
			} else {
				bytes = disambiguate(s, label);
			}
		} catch (err) {
			if (err?.code === 'ambiguous_recipient_key') throw err;
			throw Object.assign(new Error(`${label} is not valid Base58/Base64/hex`), {
				status: 400,
				code: 'invalid_recipient_key',
			});
		}
	} else {
		throw Object.assign(new Error(`${label} must be a string or Uint8Array`), {
			status: 400,
			code: 'invalid_recipient_key',
		});
	}
	if (bytes.length !== X25519_KEY_BYTES) {
		throw Object.assign(
			new Error(`${label} must be a 32-byte X25519 key (got ${bytes.length} bytes)`),
			{ status: 400, code: 'invalid_recipient_key' },
		);
	}
	return bytes;
}

function toBytes(plaintext) {
	return typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
}

/**
 * Seal a plaintext to a recipient's X25519 public key.
 * @param {Uint8Array|string} plaintext
 * @param {Uint8Array|string} recipientPublicKey - 32-byte X25519 public key.
 * @returns {Promise<{scheme:string, epk:string, nonce:string, ciphertext:string, recipient:string}>}
 */
export async function sealToRecipient(plaintext, recipientPublicKey) {
	const recipientPub = parseX25519Key(recipientPublicKey, 'recipient public key');
	const { secret: ephemeralSecret, publicKey: ephemeralPublic } = randomUnambiguousKeypair();
	const shared = x25519.getSharedSecret(ephemeralSecret, recipientPub);

	const salt = new Uint8Array(ephemeralPublic.length + recipientPub.length);
	salt.set(ephemeralPublic, 0);
	salt.set(recipientPub, ephemeralPublic.length);
	const keyBytes = hkdf(sha256, shared, salt, HKDF_INFO, 32);

	const key = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
	const nonce = randomBytes(NONCE_BYTES);
	const ct = await subtle().encrypt(
		{ name: 'AES-GCM', iv: nonce, additionalData: ephemeralPublic },
		key,
		toBytes(plaintext),
	);

	// Wipe the ephemeral secret + derived key from the local copy. (Best-effort:
	// GC'd byte arrays may linger, but we don't keep a live reference.)
	ephemeralSecret.fill(0);
	keyBytes.fill(0);

	return {
		scheme: SEALED_ENVELOPE_SCHEME,
		epk: bs58.encode(ephemeralPublic),
		nonce: toBase64url(nonce),
		ciphertext: toBase64url(new Uint8Array(ct)),
		recipient: bs58.encode(recipientPub),
	};
}

/**
 * Open a sealed envelope with the recipient's X25519 secret key.
 * @param {{scheme:string, epk:string, nonce:string, ciphertext:string}} envelope
 * @param {Uint8Array|string} recipientSecretKey - 32-byte X25519 secret key.
 * @returns {Promise<Uint8Array>} the decrypted plaintext bytes.
 */
export async function openSealed(envelope, recipientSecretKey) {
	if (!envelope || envelope.scheme !== SEALED_ENVELOPE_SCHEME) {
		throw Object.assign(new Error(`unsupported sealed-envelope scheme: ${envelope?.scheme}`), {
			code: 'unsupported_scheme',
		});
	}
	const secret = parseX25519Key(recipientSecretKey, 'recipient secret key');
	const ephemeralPublic = parseX25519Key(envelope.epk, 'ephemeral public key');
	const shared = x25519.getSharedSecret(secret, ephemeralPublic);
	const recipientPub = x25519.getPublicKey(secret);

	const salt = new Uint8Array(ephemeralPublic.length + recipientPub.length);
	salt.set(ephemeralPublic, 0);
	salt.set(recipientPub, ephemeralPublic.length);
	const keyBytes = hkdf(sha256, shared, salt, HKDF_INFO, 32);

	const key = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
	const pt = await subtle().decrypt(
		{ name: 'AES-GCM', iv: fromBase64url(envelope.nonce), additionalData: ephemeralPublic },
		key,
		fromBase64url(envelope.ciphertext),
	);
	keyBytes.fill(0);
	return new Uint8Array(pt);
}

/** Open a sealed envelope and decode the plaintext as UTF-8 text. */
export async function openSealedText(envelope, recipientSecretKey) {
	return new TextDecoder().decode(await openSealed(envelope, recipientSecretKey));
}

/**
 * Generate a throwaway X25519 recipient keypair (Base58-encoded). Clients that
 * don't already manage an X25519 key call this, pass `publicKey` as `sealTo`,
 * and keep `secretKey` to open the envelope.
 * @returns {{publicKey:string, secretKey:string}}
 */
/**
 * Draw an X25519 keypair whose Base58 forms are both 44 characters.
 *
 * Every 32-byte value this module Base58-encodes is re-parsed later by
 * `parseX25519Key`, and a 43-character Base58 string is indistinguishable from
 * a Base64url one (see that function). Constraining generation keeps the wire
 * format byte-identical while making every value we emit unambiguous — which
 * matters most for the ephemeral key, since a 43-character `epk` would make
 * ~5.4% of sealed envelopes unopenable.
 *
 * Rejection sampling conditions the public key on being ≥ 58⁴³, a uniform
 * restriction that leaves ~255.9 bits of entropy. It costs ~11% of one extra
 * keygen on average.
 */
function randomUnambiguousKeypair() {
	for (;;) {
		const secret = x25519.utils.randomSecretKey();
		const publicKey = x25519.getPublicKey(secret);
		if (bs58.encode(publicKey).length !== X25519_UNAMBIGUOUS_B58_LENGTH) continue;
		if (bs58.encode(secret).length !== X25519_UNAMBIGUOUS_B58_LENGTH) continue;
		return { secret, publicKey };
	}
}

export function generateRecipientKeypair() {
	// Keep drawing until the public key's Base58 form is 44 characters.
	//
	// Base64url encodes 32 bytes in exactly 43 characters, and Base58's alphabet
	// is a subset of Base64url's — so a 43-character Base58 key is also a valid
	// Base64url string decoding to a *different* key, and a bare `sealTo=` value
	// cannot say which was meant (see `parseX25519Key`). 44 characters is
	// unambiguous, and only ~5.4% of keys are short enough to need 43, so this
	// loop costs a few percent of one keygen. Callers of every server version
	// then work without needing an explicit `base58:` prefix on the wire.
	const { secret, publicKey } = randomUnambiguousKeypair();
	return { publicKey: bs58.encode(publicKey), secretKey: bs58.encode(secret) };
}
