// Node identity: a Solana Ed25519 keypair that doubles as the node's on-chain
// address and its job-result signing key. Encoding follows the platform's
// existing conventions (api/_lib/siws.js, api/_lib/attest-event.js):
//   - secret keys: base58 (also accepts base64 and solana-keygen JSON arrays)
//   - public keys / node addresses: base58, 32 bytes
//   - signatures: Ed25519 over the UTF-8 canonical string, emitted base58
// Only @noble/curves and bs58 are used so the same module loads in the repo's
// root test runner without pulling @solana/web3.js.

import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

const BASE58_RE = /^[A-HJ-NP-Za-km-z1-9]+$/;

// Decode a node secret key from any encoding the platform already provisions:
//   - JSON array of 64 (or 32) ints, as written by solana-keygen
//   - base64 of the raw secret-key bytes
//   - base58 of the raw secret-key bytes (the default this client emits)
// Returns a 64-byte secret key (32-byte seed + pubkey), or null on bad input.
export function decodeNodeSecret(secret) {
	const raw = String(secret || '').trim();
	if (!raw) return null;
	let bytes = null;
	if (raw.startsWith('[')) {
		try {
			const arr = JSON.parse(raw);
			if (Array.isArray(arr) && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
				bytes = Uint8Array.from(arr);
			}
		} catch {
			return null;
		}
	} else if (BASE58_RE.test(raw)) {
		try {
			bytes = bs58.decode(raw);
		} catch {
			return null;
		}
	} else {
		try {
			bytes = Uint8Array.from(Buffer.from(raw, 'base64'));
		} catch {
			return null;
		}
	}
	if (!bytes) return null;
	// A 32-byte seed expands to the full 64-byte secret key.
	if (bytes.length === 32) {
		const pub = ed25519.getPublicKey(bytes);
		const full = new Uint8Array(64);
		full.set(bytes, 0);
		full.set(pub, 32);
		return full;
	}
	if (bytes.length === 64) return bytes;
	return null;
}

// Generate a fresh node identity.
export function generateKeypair() {
	const seed = randomBytes(32);
	const secretKey = decodeNodeSecret(bs58.encode(seed));
	return {
		secretKey,
		publicKey: secretKey.slice(32),
		address: bs58.encode(secretKey.slice(32)),
		secretBase58: bs58.encode(secretKey),
	};
}

// Load a node identity from an encoded secret key. Throws on bad input so a
// misconfigured operator fails at boot, not mid-job.
export function loadKeypair(secret) {
	const secretKey = decodeNodeSecret(secret);
	if (!secretKey) {
		throw new Error(
			'NODE_SECRET_KEY could not be decoded: expected base58, base64, or a solana-keygen JSON byte array',
		);
	}
	return {
		secretKey,
		publicKey: secretKey.slice(32),
		address: bs58.encode(secretKey.slice(32)),
	};
}

// Sign an arbitrary UTF-8 payload with the node's key. Base58 signature out,
// matching how the platform encodes Ed25519 signatures everywhere else.
export function signPayload(secretKey, payload) {
	const bytes = new TextEncoder().encode(payload);
	return bs58.encode(ed25519.sign(bytes, secretKey.slice(0, 32)));
}

// Verify a base58 (or base64) Ed25519 signature over `payload` against a
// base58 node address. Mirrors verifySiwsSignature in api/_lib/siws.js.
export function verifyPayload(address, payload, signature) {
	let pubBytes;
	try {
		pubBytes = bs58.decode(String(address || ''));
	} catch {
		return false;
	}
	if (pubBytes.length !== 32) return false;

	const sigStr = String(signature || '');
	let sigBytes;
	if (BASE58_RE.test(sigStr)) {
		try {
			sigBytes = bs58.decode(sigStr);
		} catch {
			return false;
		}
	} else {
		try {
			sigBytes = Uint8Array.from(Buffer.from(sigStr, 'base64'));
		} catch {
			return false;
		}
	}
	if (!sigBytes || sigBytes.length !== 64) return false;

	return ed25519.verify(sigBytes, new TextEncoder().encode(payload), pubBytes);
}
