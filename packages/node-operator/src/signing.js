/**
 * Result signing: the cryptographic receipt for one inference job.
 *
 * The receipt binds (jobId, model, prompt, output, timing) to the node's
 * ed25519 identity. Verification is pure and offline: anyone holding the
 * receipt and the node's public key can confirm the node computed exactly
 * this output for exactly this job, which is what phase 4 settlement needs
 * before releasing payment.
 *
 * Canonical message format (what gets signed):
 *
 *   sha256hex(jobId).sha256hex(model).sha256hex(prompt).sha256hex(output).startedAt.finishedAt
 *
 * Every variable-length field is pre-hashed so there is no delimiter or
 * encoding ambiguity, then the whole line is signed with ed25519. Hashing is
 * WebCrypto SHA-256 so it works identically in Node, Docker, and the browser
 * verification path.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');

/** Hex SHA-256 of a UTF-8 string or byte array. */
export async function sha256Hex(input) {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Buffer.from(digest).toString('hex');
}

/**
 * Build the canonical signing payload for a job result. Pure; exposed so the
 * platform verifier and tests reproduce the exact same bytes.
 */
export async function receiptPayload({ jobId, model, prompt, output, startedAt, finishedAt }) {
	const parts = [
		await sha256Hex(String(jobId)),
		await sha256Hex(String(model)),
		await sha256Hex(String(prompt)),
		await sha256Hex(typeof output === 'string' ? output : JSON.stringify(output)),
		String(startedAt),
		String(finishedAt),
	];
	return parts.join('.');
}

/**
 * Sign a job result with the node identity. Returns the full receipt object
 * the node submits with the result and the platform verifies.
 */
export async function signResult(identity, { jobId, model, prompt, output, startedAt, finishedAt }) {
	const payload = await receiptPayload({ jobId, model, prompt, output, startedAt, finishedAt });
	return {
		algorithm: 'ed25519',
		publicKey: identity.publicKey,
		payload,
		signature: identity.signText(payload),
	};
}

/**
 * Verify a receipt against a claimed node public key. Returns true only if
 * the signature is valid AND the receipt was signed by the claimed key.
 */
export function verifyReceipt(receipt, expectedPublicKey) {
	if (!receipt || receipt.algorithm !== 'ed25519') return false;
	if (expectedPublicKey && receipt.publicKey !== expectedPublicKey) return false;
	let sigBytes;
	let msgBytes;
	try {
		sigBytes = Uint8Array.from(Buffer.from(receipt.signature, 'base64'));
		msgBytes = new TextEncoder().encode(receipt.payload);
	} catch {
		return false;
	}
	let pubBytes;
	try {
		pubBytes = base58ToBytes(receipt.publicKey);
	} catch {
		return false;
	}
	return nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
}

/**
 * Deterministically recompute and verify a receipt from the job inputs and
 * result. This is the platform-side check: recompute the payload from the
 * claimed inputs, then verify the signature over it.
 */
export async function verifyResult({ jobId, model, prompt, output, startedAt, finishedAt }, receipt) {
	const payload = await receiptPayload({ jobId, model, prompt, output, startedAt, finishedAt });
	if (payload !== receipt?.payload) return false;
	return verifyReceipt(receipt, receipt.publicKey);
}

// Local base58 decode (kept here so the verifier path has no identity.js
// import cost; the alphabets must stay identical).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58ToBytes(str) {
	const bytes = [0];
	for (const ch of str) {
		const idx = B58.indexOf(ch);
		if (idx < 0) throw new Error('invalid base58');
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
	for (const ch of str) {
		if (ch === '1') bytes.push(0);
		else break;
	}
	return Uint8Array.from(bytes.reverse());
}
