// Open Inference Protocol (OIN) v0.1 verifier and signing primitives.
//
// Implements the verification rules from specs/OPEN_INFERENCE_PROTOCOL.md:
// canonical (RFC 8785 JCS) JSON, SHA-256 job digests, and Ed25519 response
// signatures over the canonical response minus its `signature` field.
// Dependency-free (Node stdlib only) so any requester, relay, or auditor can
// verify a node's signed response without trusting the transport.
//
// Exports:
//   canonicalize(value)            -> canonical JSON string (RFC 8785)
//   digestJob(envelope)            -> lowercase hex SHA-256 of the canonical envelope
//   signResponse(response, keyB64) -> response with `signature` filled in (node side)
//   signAdvertisement(ad, keyB64)  -> advertisement with `signature` filled in
//   verifyResponse(job, response, opts) -> { ok, verdict, ... }
//   verifyOutput(response, fetchImpl?)  -> rule 6: hash the bytes at output.url
//
// Verdicts are the exact codes the spec names: bad_shape, job_digest_mismatch,
// bad_pubkey, untrusted_node, bad_signature, stale_response, future_response,
// output_digest_mismatch, verified, verified_unfetched_output.

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

export const OIN_SPEC = 'oin/0.1';
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

// ── canonical JSON (RFC 8785 JCS) ────────────────────────────────────────────

function canonicalizeNumber(n) {
	if (!Number.isFinite(n)) throw new TypeError('OIN canonicalization: non-finite number');
	// JCS uses the ECMAScript Number::toString algorithm, which JSON.stringify
	// already implements for finite numbers.
	return JSON.stringify(n);
}

function canonicalize(value) {
	if (value === null) return 'null';
	const t = typeof value;
	if (t === 'boolean') return value ? 'true' : 'false';
	if (t === 'number') return canonicalizeNumber(value);
	if (t === 'string') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
	if (t === 'object') {
		// JCS sorts object keys by UTF-16 code units, which is Array.prototype.sort's default.
		const keys = Object.keys(value).filter((k) => value[k] !== undefined && typeof value[k] !== 'function').sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
	}
	throw new TypeError(`OIN canonicalization: unsupported type ${t}`);
}

// ── digests and keys ─────────────────────────────────────────────────────────

function sha256hex(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function digestJob(envelope) {
	return sha256hex(Buffer.from(canonicalize(envelope), 'utf8'));
}

function keyObjectFromSecret(keyB64) {
	const raw = Buffer.from(String(keyB64), 'base64');
	if (raw.length !== 32 && raw.length !== 64) {
		throw new Error('OIN signing key must be 32-byte seed or 64-byte expanded key, base64');
	}
	// PKCS#8 DER wrapper for a raw Ed25519 seed: 302e020100300506032b657004220420 || seed
	const seed = raw.length === 64 ? raw.subarray(0, 32) : raw;
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
	return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function pubkeyB64FromSecret(keyB64) {
	const priv = keyObjectFromSecret(keyB64);
	const der = createPublicKey(priv).export({ format: 'der', type: 'spki' });
	// SPKI for Ed25519 is 12 bytes of header + the 32-byte key.
	return Buffer.from(der).subarray(-32).toString('base64');
}

function pubKeyObjectFromField(nodePubkey) {
	if (typeof nodePubkey !== 'string' || !nodePubkey.startsWith('ed25519:')) return null;
	const raw = Buffer.from(nodePubkey.slice('ed25519:'.length), 'base64');
	if (raw.length !== 32) return null;
	// SPKI DER wrapper for a raw Ed25519 public key: 302a300506032b6570032100 || key
	const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
	try {
		return createPublicKey({ key: der, format: 'der', type: 'spki' });
	} catch {
		return null;
	}
}

// ── signing (node side) ──────────────────────────────────────────────────────

function signPayload(payload, keyB64) {
	const priv = keyObjectFromSecret(keyB64);
	const bytes = Buffer.from(canonicalize(payload), 'utf8');
	// Ed25519 is deterministic pure signing: null algorithm, message in one shot.
	return cryptoSign(null, bytes, priv).toString('base64');
}

function signResponse(response, keyB64) {
	const { signature: _drop, ...unsigned } = response;
	return { ...unsigned, signature: signPayload(unsigned, keyB64) };
}

function signAdvertisement(advertisement, keyB64) {
	const { signature: _drop, ...unsigned } = advertisement;
	return { ...unsigned, signature: signPayload(unsigned, keyB64) };
}

// ── verification (rules 1-5 of the spec) ─────────────────────────────────────

function fail(verdict, detail) {
	return { ok: false, verified: false, verdict, detail };
}

function verifyResponse(job, response, opts = {}) {
	// Rule 1: shape.
	if (!response || typeof response !== 'object' || Array.isArray(response)) {
		return fail('bad_shape', 'response is not an object');
	}
	if (response.spec !== OIN_SPEC) return fail('bad_shape', `spec must be ${OIN_SPEC}`);
	for (const field of ['job_digest', 'node_pubkey', 'completed_at', 'status', 'signature']) {
		if (typeof response[field] !== 'string' || !response[field]) {
			return fail('bad_shape', `missing field: ${field}`);
		}
	}
	if (response.status !== 'done' && response.status !== 'failed') {
		return fail('bad_shape', `status must be done|failed, got ${response.status}`);
	}
	if (response.status === 'done' && (!response.output || typeof response.output !== 'object')) {
		return fail('bad_shape', 'done response must carry output');
	}
	if (response.status === 'failed' && (!response.error || typeof response.error !== 'object')) {
		return fail('bad_shape', 'failed response must carry error');
	}
	if (response.status === 'done') {
		const { url, sha256, bytes } = response.output;
		if (typeof url !== 'string' || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isInteger(bytes) || bytes < 0) {
			return fail('bad_shape', 'output needs url, sha256 (64 lowercase hex), bytes (non-negative int)');
		}
	}
	if (!/^[0-9a-f]{64}$/.test(response.job_digest)) {
		return fail('bad_shape', 'job_digest must be 64 lowercase hex chars');
	}

	// Rule 2: job binding.
	const expectedDigest = digestJob(job);
	if (response.job_digest !== expectedDigest) {
		return fail('job_digest_mismatch', `expected ${expectedDigest}, got ${response.job_digest}`);
	}

	// Rule 3: key parses and (when pinned/advertised) matches.
	const pub = pubKeyObjectFromField(response.node_pubkey);
	if (!pub) return fail('bad_pubkey', 'node_pubkey must be ed25519:<base64 32-byte key>');
	if (opts.expectedPubkey && response.node_pubkey !== opts.expectedPubkey) {
		return fail('untrusted_node', `response key does not match pinned/advertised ${opts.expectedPubkey}`);
	}

	// Rule 4: signature over the canonical response minus `signature`.
	const { signature, ...unsigned } = response;
	let sigBytes;
	try {
		sigBytes = Buffer.from(signature, 'base64');
	} catch {
		return fail('bad_signature', 'signature is not valid base64');
	}
	if (sigBytes.length !== 64) return fail('bad_signature', 'Ed25519 signature must be 64 bytes');
	const payloadBytes = Buffer.from(canonicalize(unsigned), 'utf8');
	let sigOk = false;
	try {
		sigOk = cryptoVerify(null, payloadBytes, pub, sigBytes);
	} catch {
		sigOk = false;
	}
	if (!sigOk) return fail('bad_signature', 'Ed25519 verification failed');

	// Rule 5: freshness against the job deadline and the verifier clock.
	const completedMs = Date.parse(response.completed_at);
	if (!Number.isFinite(completedMs)) return fail('bad_shape', 'completed_at must parse as ISO 8601');
	const now = opts.now instanceof Date ? opts.now.getTime() : Date.now();
	if (completedMs > now + MAX_FUTURE_SKEW_MS) {
		return fail('future_response', 'completed_at is more than 24h in the future');
	}
	const createdMs = Date.parse(job?.created_at);
	const deadlineS = Number(job?.deadline);
	if (Number.isFinite(createdMs) && Number.isFinite(deadlineS) && deadlineS > 0) {
		if (completedMs > createdMs + deadlineS * 1000) {
			return fail('stale_response', 'completed after the job deadline');
		}
	}

	return {
		ok: true,
		verified: true,
		verdict: 'verified',
		nodePubkey: response.node_pubkey,
		status: response.status,
	};
}

// Rule 6 (optional): fetch output.url and check bytes + sha256. The caller
// supplies the fetch implementation in tests; in production it must apply the
// SSRF guards the spec requires (https-only, private-IP rejection, size cap).
async function verifyOutput(response, fetchImpl) {
	if (!response?.output?.url) return fail('bad_shape', 'no output to verify');
	const doFetch = fetchImpl || globalThis.fetch;
	if (typeof doFetch !== 'function') return fail('output_digest_mismatch', 'no fetch implementation available');
	let bytes;
	try {
		const res = await doFetch(response.output.url);
		if (!res.ok) return fail('output_digest_mismatch', `fetch failed: HTTP ${res.status}`);
		const len = Number(res.headers?.get?.('content-length'));
		if (Number.isFinite(len) && len > MAX_OUTPUT_BYTES) {
			return fail('output_digest_mismatch', `output exceeds ${MAX_OUTPUT_BYTES} bytes`);
		}
		bytes = Buffer.from(await res.arrayBuffer());
	} catch (err) {
		return fail('output_digest_mismatch', `fetch failed: ${err?.message || err}`);
	}
	if (bytes.length > MAX_OUTPUT_BYTES) {
		return fail('output_digest_mismatch', `output exceeds ${MAX_OUTPUT_BYTES} bytes`);
	}
	if (bytes.length !== response.output.bytes) {
		return fail('output_digest_mismatch', `bytes ${bytes.length} != declared ${response.output.bytes}`);
	}
	const digest = sha256hex(bytes);
	if (digest !== response.output.sha256) {
		return fail('output_digest_mismatch', `sha256 ${digest} != declared ${response.output.sha256}`);
	}
	return { ok: true, verified: true, verdict: 'verified_with_output', bytes: bytes.length };
}

export {
	canonicalize,
	digestJob,
	pubkeyB64FromSecret,
	signAdvertisement,
	signResponse,
	verifyOutput,
	verifyResponse,
};
