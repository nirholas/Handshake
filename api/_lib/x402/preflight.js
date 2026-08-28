// @ts-check
// api/_lib/x402/preflight.js
//
// x402 Preflight: a signed, time-bounded statement that an endpoint can
// actually take your money and finish the job.
//
// The problem it exists for
// -------------------------
// x402 tells a client WHAT a resource costs. It says nothing about whether the
// server is currently able to SETTLE what it charges. Those are different
// questions with the same happy path and completely different failure modes,
// and the gap between them is paid for by the buyer:
//
//   1. client GETs a paid route, receives 402 with a price and accepts
//   2. client signs a transfer and retries with X-PAYMENT
//   3. server cannot settle (its fee sponsor is empty, its facilitator is down,
//      its RPC is over quota) and answers 502
//
// The client burned a signature, a blockhash and a round trip on a service that
// could not have completed at step 1. Worse, in the sponsored-fee model the
// buyer's own funds are fine: the thing that is broken belongs to the SELLER,
// and the buyer has no way to see it. On 2026-08-28 three.ws was that seller for
// three hours. 95 payment attempts, 0 settled, every one of them predictable
// from state the server already had.
//
// Preflight closes that gap the way CORS preflight closes its own: one cheap,
// cacheable request BEFORE the expensive one, answered from state the server
// already computes.
//
// Why it is signed, and why that is the interesting part
// -----------------------------------------------------
// An unsigned health endpoint is a courtesy. A signed, time-bounded, replay-
// resistant one is EVIDENCE. Three properties follow, and none of them are
// available from a plain status page:
//
//   ATTRIBUTABLE   A client that paid after reading `payable: true` holds a
//                  statement signed by the seller's own attester key saying the
//                  seller believed it could settle, at a stated instant. In a
//                  marketplace of autonomous agents transacting with strangers,
//                  that is the difference between "it broke" and "you said it
//                  would work". Disputes stop being he-said-she-said.
//   UNREPLAYABLE   Every attestation carries `expires_at` and verification
//                  REJECTS an expired one. A seller cannot serve a cached
//                  healthy attestation through an outage, and an attacker who
//                  captures one cannot replay it later.
//   RELAYABLE      Because it verifies offline against a public key, a registry,
//                  an index or a peer can cache and forward attestations without
//                  becoming trusted. Discovery services can rank by measured
//                  settleability instead of by self-description.
//
// Honesty rules the format enforces
// ---------------------------------
//  * `payable` is a THREE-valued field: true, false, or unknown. A server that
//    cannot determine its own state must say `unknown`, never `true`. Every
//    code path here fails to `unknown`, so a crashed sensor degrades to "I do
//    not know" rather than to a lie.
//  * Every rate carries the window and the sample size it was measured over. A
//    rate without its window is a rumour; `confidence` is derived from the
//    sample, so a 100% settle rate over 3 attempts cannot masquerade as proof.
//  * `alternates` names the other networks on the same origin that ARE payable,
//    so a client whose preferred rail is down can re-route in the same round
//    trip instead of discovering the outage one failed payment at a time.
//  * `retry_after` is advisory back-off, so a fleet of agents meeting an
//    unpayable seller backs off instead of synchronising into a retry storm.
//
// This module is deliberately pure: no DB, no fetch, no chain, no clock except
// what the caller injects. The I/O that feeds it lives in api/x402/preflight.js,
// and the same verify() below is what runs inside the browser SDK and the CLI.
//
// Spec: specs/x402-preflight.md

import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

/** Body profile emitted by this module. Bump on a breaking body change. */
export const PREFLIGHT_SPEC = 'x402-preflight/1';

/**
 * Envelope version, and the domain separator mixed into the signed bytes.
 * Domain separation is what stops a preflight signature from ever being
 * replayable as an agent-manifest signature or any other three.ws statement
 * signed by the same attester identity.
 */
export const PREFLIGHT_ENVELOPE_VERSION = 'threews.x402.preflight.v1';

/** Default validity. Short enough that a stale copy cannot outlive an incident. */
export const PREFLIGHT_TTL_SECONDS = 60;

/** Hard ceiling on requested TTL: an hour-long assurance is not an assurance. */
export const PREFLIGHT_MAX_TTL_SECONDS = 300;

/**
 * Machine-readable reasons an endpoint is not payable. Clients switch on these,
 * so they are part of the wire contract: add, never repurpose.
 *
 * `sponsor_below_floor` is the one that produced this whole module. It means the
 * SELLER's fee wallet cannot pay network fees, so nothing the buyer does can
 * make the payment settle.
 */
export const PREFLIGHT_REASONS = Object.freeze([
	'ok',
	'sponsor_below_floor',
	'settlement_degraded',
	'facilitator_unreachable',
	'network_not_configured',
	'rail_unavailable',
	'unknown',
]);

const REASON_SET = new Set(PREFLIGHT_REASONS);

/**
 * Back-off hint per reason, in seconds. A dry sponsor needs a human with a
 * wallet, so the hint is minutes; a degraded rail usually clears itself, so the
 * hint is short enough to retry within the same task.
 */
const RETRY_AFTER = Object.freeze({
	sponsor_below_floor: 300,
	settlement_degraded: 60,
	facilitator_unreachable: 60,
	rail_unavailable: 60,
	network_not_configured: 3600,
	unknown: 30,
});

// Deterministic JSON: keys sorted recursively, undefined dropped. The signer and
// every verifier must hash byte-identical input regardless of property insertion
// order, so this is the one representation that may be hashed.
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

/** sha256 of a string as lowercase hex. */
export function sha256Hex(input) {
	return createHash('sha256').update(Buffer.from(String(input), 'utf8')).digest('hex');
}

/**
 * Statistical confidence in a measured rate, on 0..1.
 *
 * A settle rate is only as trustworthy as the sample behind it, and the failure
 * this guards against is real: a ring that settled 3 of 3 payments overnight
 * reports 100%, which reads identically to a proven rail. Confidence rises with
 * the sample and is capped below 1 because no finite sample proves the next
 * payment settles.
 *
 * Deliberately a simple saturating curve rather than a Wilson interval: the
 * number is a hint for routing, and a hint an operator can predict in their head
 * beats a statistically tighter one nobody can sanity-check.
 * @param {number} attempts
 * @returns {number} 0..0.99, two decimals
 */
export function sampleConfidence(attempts) {
	const n = Math.max(0, Math.floor(Number(attempts) || 0));
	if (n <= 0) return 0;
	// 20 attempts is the same threshold the settle sensor uses before it will
	// judge a window at all, and lands here at ~0.66.
	return Math.round(Math.min(0.99, n / (n + 10)) * 100) / 100;
}

/**
 * Decide one network's payability from the platform's own measurements.
 *
 * Every branch that cannot prove payability returns `unknown` rather than
 * guessing, and `payable: true` is only ever returned on positive evidence. That
 * asymmetry is the whole point: a buyer acting on this makes an irreversible
 * transfer, so the expensive mistake is a false `true`, never a false `unknown`.
 *
 * Pure. The caller supplies every input; nothing is read from the environment.
 *
 * @param {object} p
 * @param {boolean} p.configured        is this network wired up to accept at all
 * @param {boolean|null} [p.sponsorBelowFloor]  null when unmeasured
 * @param {'ok'|'degraded'|'down'|'unknown'|null} [p.settleStatus]
 * @param {number|null} [p.settleRate]  0..1, null when unmeasured
 * @param {number} [p.attempts]         sample behind settleRate
 * @param {number} [p.windowHours]
 * @param {boolean} [p.facilitatorReachable]
 * @returns {{ payable: boolean|'unknown', reason: string, retry_after: number|null,
 *   settle: { rate: number|null, attempts: number, window_hours: number|null, confidence: number } }}
 */
export function decideNetworkPayability({
	configured,
	sponsorBelowFloor = null,
	settleStatus = null,
	settleRate = null,
	attempts = 0,
	windowHours = null,
	facilitatorReachable = true,
}) {
	const settle = {
		rate: settleRate == null || !Number.isFinite(Number(settleRate)) ? null : Number(settleRate),
		attempts: Math.max(0, Math.floor(Number(attempts) || 0)),
		window_hours: windowHours == null ? null : Number(windowHours),
		confidence: sampleConfidence(attempts),
	};
	const out = (payable, reason) => ({
		payable,
		reason,
		retry_after: payable === true ? null : (RETRY_AFTER[reason] ?? RETRY_AFTER.unknown),
		settle,
	});

	if (!configured) return out(false, 'network_not_configured');
	// The seller's fee wallet is empty. Nothing the buyer does can fix this, which
	// is exactly why it has to be said BEFORE the buyer signs anything.
	if (sponsorBelowFloor === true) return out(false, 'sponsor_below_floor');
	if (!facilitatorReachable) return out('unknown', 'facilitator_unreachable');
	if (settleStatus === 'down') return out(false, 'settlement_degraded');
	if (settleStatus === 'degraded') return out(false, 'settlement_degraded');
	// Configured, nothing known to be broken, but nothing measured either: a
	// quiet rail is not a proven one.
	if (settleStatus === 'unknown' || settleStatus == null) return out('unknown', 'unknown');
	return out(true, 'ok');
}

/**
 * Assemble the report body. Networks are sorted by id so the canonical bytes do
 * not depend on the order the caller happened to gather them in.
 *
 * @param {object} p
 * @param {string} p.subject           origin the report speaks for
 * @param {Record<string, ReturnType<typeof decideNetworkPayability> & {asset?:string, pay_to?:string}>} p.networks
 * @param {string} [p.issuedAt]        ISO
 * @param {number} [p.ttlSeconds]
 * @param {object} [p.endpoint]        optional per-route detail
 * @returns {object}
 */
export function buildPreflightReport({ subject, networks, issuedAt, ttlSeconds, endpoint }) {
	if (!subject) throw new Error('buildPreflightReport: subject is required');
	const at = issuedAt || new Date().toISOString();
	const ttl = Math.min(
		PREFLIGHT_MAX_TTL_SECONDS,
		Math.max(1, Math.floor(Number(ttlSeconds) || PREFLIGHT_TTL_SECONDS)),
	);

	/** @type {Record<string, object>} */
	const sorted = {};
	for (const key of Object.keys(networks || {}).sort()) {
		const n = networks[key];
		sorted[key] = {
			payable: n.payable,
			reason: REASON_SET.has(n.reason) ? n.reason : 'unknown',
			retry_after: n.retry_after ?? null,
			settle: n.settle,
			...(n.asset ? { asset: n.asset } : {}),
			...(n.pay_to ? { pay_to: n.pay_to } : {}),
		};
	}

	// Alternates are computed here rather than left to the client so that every
	// consumer (SDK, CLI, a registry relaying the envelope) agrees on the same
	// fallback set, and so the set is inside the signature.
	const payableIds = Object.keys(sorted).filter((k) => sorted[k].payable === true);
	for (const key of Object.keys(sorted)) {
		sorted[key].alternates = payableIds.filter((k) => k !== key);
	}

	const body = {
		$schema: 'https://three.ws/schemas/x402-preflight/1.json',
		spec: PREFLIGHT_SPEC,
		subject: String(subject),
		issued_at: at,
		expires_at: new Date(new Date(at).getTime() + ttl * 1000).toISOString(),
		networks: sorted,
		payable_any: payableIds.length > 0,
	};
	if (endpoint) body.endpoint = endpoint;
	return body;
}

/** The exact bytes run through ed25519, domain-separated by envelope version. */
export function signingMessage(digest) {
	return Buffer.from(`${PREFLIGHT_ENVELOPE_VERSION}:${digest}`, 'utf8');
}

/** Digest over the report plus the issuer and instant it was signed at. */
export function reportDigest({ report, issuer, signedAt }) {
	return sha256Hex(canonicalize({ report, issuer, signedAt }));
}

/**
 * Sign a report with an ed25519 secret key (a Solana Keypair's 64-byte
 * secretKey, or a raw 32-byte seed). Pure crypto: no DB, no network.
 * @param {object} report from buildPreflightReport
 * @param {Uint8Array} secretKey
 * @param {{signedAt?: string}} [opts]
 * @returns {object} the signed envelope
 */
export function signPreflight(report, secretKey, { signedAt } = {}) {
	const seed = secretKey.slice(0, 32);
	const issuer = bs58.encode(ed25519.getPublicKey(seed));
	const at = signedAt || report.issued_at || new Date().toISOString();
	const digest = reportDigest({ report, issuer, signedAt: at });
	return {
		spec: PREFLIGHT_ENVELOPE_VERSION,
		report,
		issuer,
		signedAt: at,
		digest,
		algorithm: 'ed25519',
		signature: bs58.encode(ed25519.sign(signingMessage(digest), seed)),
	};
}

/**
 * Verify a signed envelope. Pure and offline: this is what an outside party runs
 * on bytes it fetched, and what the browser SDK runs before trusting a report.
 *
 * Expiry is checked as part of verification, not left to the caller. An expired
 * attestation is not a valid one that happens to be old: treating it as valid is
 * precisely the replay this format exists to prevent, and making it the caller's
 * job would mean every consumer has to remember. `clockSkewMs` allows for honest
 * clock drift between two machines without opening a replay window.
 *
 * @param {object} envelope
 * @param {{issuer?: string, now?: number, clockSkewMs?: number, subject?: string}} [expect]
 * @returns {{ valid: boolean, reason: string, issuer: string|null, digest: string|null, expired: boolean }}
 */
export function verifyPreflight(envelope, { issuer: expectedIssuer, now, clockSkewMs = 30_000, subject } = {}) {
	const fail = (reason, extra = {}) => ({
		valid: false,
		reason,
		issuer: envelope?.issuer || null,
		digest: null,
		expired: false,
		...extra,
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
	if (envelope.digest && String(envelope.digest).toLowerCase() !== digest) {
		return { ...fail('digest_mismatch'), digest };
	}
	if (expectedIssuer && expectedIssuer !== envelope.issuer) {
		return { ...fail('issuer_mismatch'), digest };
	}
	// A report is only about the origin it names. Without this check a valid
	// attestation for one seller could be presented as covering another.
	if (subject && normalizeOrigin(subject) !== normalizeOrigin(envelope.report.subject)) {
		return { ...fail('subject_mismatch'), digest };
	}

	let ok = false;
	try {
		ok = ed25519.verify(bs58.decode(envelope.signature), signingMessage(digest), bs58.decode(envelope.issuer));
	} catch {
		return { ...fail('malformed_signature'), digest };
	}
	if (!ok) return { ...fail('bad_signature'), digest };

	const at = typeof now === 'number' ? now : Date.now();
	const expiresAt = Date.parse(envelope.report.expires_at || '');
	if (!Number.isFinite(expiresAt)) return { ...fail('no_expiry'), digest };
	if (at - clockSkewMs > expiresAt) {
		return { valid: false, reason: 'expired', issuer: envelope.issuer, digest, expired: true };
	}
	// A report stamped in the future is either a broken clock or a forgery
	// attempt to extend an assurance window. Neither is safe to act on.
	const issuedAt = Date.parse(envelope.report.issued_at || '');
	if (Number.isFinite(issuedAt) && issuedAt - clockSkewMs > at) {
		return { ...fail('issued_in_future'), digest };
	}

	return { valid: true, reason: 'ok', issuer: envelope.issuer, digest, expired: false };
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
 * Read one network's verdict out of a VERIFIED envelope.
 *
 * Takes the envelope rather than the report so a caller cannot skip
 * verification by reaching for the body directly, and returns `unknown` for a
 * network the report does not mention rather than treating silence as a no.
 * @param {object} envelope
 * @param {string} network e.g. 'solana:mainnet'
 * @returns {{ payable: boolean|'unknown', reason: string, retry_after: number|null, alternates: string[] }}
 */
export function networkVerdict(envelope, network) {
	const n = envelope?.report?.networks?.[network];
	if (!n) return { payable: 'unknown', reason: 'network_not_configured', retry_after: null, alternates: [] };
	return {
		payable: n.payable,
		reason: n.reason,
		retry_after: n.retry_after ?? null,
		alternates: Array.isArray(n.alternates) ? n.alternates : [],
	};
}
