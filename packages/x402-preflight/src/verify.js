// Offline verification of an x402 Preflight attestation.
//
// This file is the trust boundary of the whole SDK, so it is kept small,
// dependency-light and free of I/O. It runs unchanged in Node, in a browser, in
// a service worker and on an edge runtime: nothing here touches the filesystem,
// the network, or any Node built-in.
//
// Everything the format needs to be safe is enforced HERE rather than left to
// the caller, because a verification step a caller can forget is one that will
// be forgotten:
//
//   * the signature must check out against the issuer key in the envelope
//   * the digest must match a re-derivation from the report bytes, so a report
//     edited after signing is caught even before the signature is examined
//   * the attestation must not be expired, and must not be stamped in the future
//   * the subject must be the origin you asked about, when you say which
//
// Spec: https://three.ws/docs/x402-preflight

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

/** Report profile this SDK understands. */
export const PREFLIGHT_SPEC = 'x402-preflight/1';

/** Envelope version, and the domain separator mixed into the signed bytes. */
export const PREFLIGHT_ENVELOPE_VERSION = 'threews.x402.preflight.v1';

/** Tolerated clock difference between the signer's machine and yours. */
export const DEFAULT_CLOCK_SKEW_MS = 30_000;

const enc = new TextEncoder();

// Deterministic JSON, byte-identical to the signer's. Keys sorted recursively,
// undefined dropped. Any divergence here breaks every signature, so this
// function and its counterpart in the server are the same algorithm on purpose.
function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	if (value && typeof value === 'object') {
		const keys = Object.keys(value)
			.filter((k) => value[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
	}
	return JSON.stringify(value === undefined ? null : value);
}

function toHex(bytes) {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

/** sha256 as lowercase hex, with no Node dependency. */
export function sha256Hex(input) {
	return toHex(sha256(enc.encode(String(input))));
}

/** The exact bytes run through ed25519, domain-separated by envelope version. */
export function signingMessage(digest) {
	return enc.encode(`${PREFLIGHT_ENVELOPE_VERSION}:${digest}`);
}

/** Digest over the report plus the issuer and instant it was signed at. */
export function reportDigest({ report, issuer, signedAt }) {
	return sha256Hex(canonicalize({ report, issuer, signedAt }));
}

/** Compare origins without being defeated by a trailing slash or a case change. */
export function normalizeOrigin(value) {
	try {
		const u = new URL(String(value));
		return `${u.protocol}//${u.host}`.toLowerCase();
	} catch {
		return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
	}
}

/**
 * Verify a signed preflight envelope. Pure, offline, and total: it returns a
 * verdict for every input rather than throwing, so a malformed response from a
 * hostile server cannot crash a paying agent's loop.
 *
 * @param {object} envelope the parsed JSON body from a preflight endpoint
 * @param {object} [expect]
 * @param {string} [expect.issuer]      pin the accepted signer's public key
 * @param {string} [expect.subject]     pin the origin the report must speak for
 * @param {number} [expect.now]         injected clock, for tests
 * @param {number} [expect.clockSkewMs]
 * @returns {{ valid: boolean, reason: string, issuer: string|null, digest: string|null, expired: boolean }}
 */
export function verifyPreflight(envelope, { issuer: expectedIssuer, subject, now, clockSkewMs = DEFAULT_CLOCK_SKEW_MS } = {}) {
	const fail = (reason, digest = null) => ({
		valid: false,
		reason,
		issuer: envelope?.issuer || null,
		digest,
		expired: false,
	});

	if (!envelope || typeof envelope !== 'object' || !envelope.report) return fail('not_an_envelope');
	if (envelope.spec !== PREFLIGHT_ENVELOPE_VERSION) return fail('unsupported_envelope_version');
	if (envelope.algorithm && envelope.algorithm !== 'ed25519') return fail('unsupported_algorithm');
	if (!envelope.issuer || !envelope.signature || !envelope.signedAt) return fail('unsigned');
	if (envelope.report.spec !== PREFLIGHT_SPEC) return fail('unsupported_report_spec');

	const digest = reportDigest({
		report: envelope.report,
		issuer: envelope.issuer,
		signedAt: envelope.signedAt,
	});
	if (envelope.digest && String(envelope.digest).toLowerCase() !== digest) return fail('digest_mismatch', digest);
	if (expectedIssuer && expectedIssuer !== envelope.issuer) return fail('issuer_mismatch', digest);
	if (subject && normalizeOrigin(subject) !== normalizeOrigin(envelope.report.subject)) {
		return fail('subject_mismatch', digest);
	}

	let ok = false;
	try {
		ok = ed25519.verify(bs58.decode(envelope.signature), signingMessage(digest), bs58.decode(envelope.issuer));
	} catch {
		return fail('malformed_signature', digest);
	}
	if (!ok) return fail('bad_signature', digest);

	const at = typeof now === 'number' ? now : Date.now();
	const expiresAt = Date.parse(envelope.report.expires_at || '');
	if (!Number.isFinite(expiresAt)) return fail('no_expiry', digest);
	// An expired attestation is not a valid one that happens to be old. Serving a
	// cached healthy report through an outage is the exact replay this format
	// exists to prevent, so expiry is checked here and not left to the caller.
	if (at - clockSkewMs > expiresAt) {
		return { valid: false, reason: 'expired', issuer: envelope.issuer, digest, expired: true };
	}
	const issuedAt = Date.parse(envelope.report.issued_at || '');
	if (Number.isFinite(issuedAt) && issuedAt - clockSkewMs > at) return fail('issued_in_future', digest);

	return { valid: true, reason: 'ok', issuer: envelope.issuer, digest, expired: false };
}

/**
 * Read one network's verdict from an envelope.
 *
 * Takes the envelope rather than the report so a caller cannot reach past
 * verification, and answers `unknown` for a network the report never mentions:
 * silence is not a denial, and treating it as one would route traffic away from
 * rails that are fine.
 * @param {object} envelope
 * @param {string} network CAIP-2 id, e.g. 'solana:mainnet'
 * @returns {{ payable: boolean|'unknown', reason: string, retry_after: number|null, alternates: string[], settle: object|null }}
 */
export function networkVerdict(envelope, network) {
	const n = envelope?.report?.networks?.[network];
	if (!n) {
		return { payable: 'unknown', reason: 'network_not_configured', retry_after: null, alternates: [], settle: null };
	}
	return {
		payable: n.payable,
		reason: n.reason,
		retry_after: n.retry_after ?? null,
		alternates: Array.isArray(n.alternates) ? n.alternates : [],
		settle: n.settle ?? null,
	};
}

/** Every network the report says is payable right now, in report order. */
export function payableNetworks(envelope) {
	const nets = envelope?.report?.networks || {};
	return Object.keys(nets).filter((k) => nets[k]?.payable === true);
}
