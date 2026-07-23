// Server-side glue for the x402 payment-identifier extension (USE-15).
//
// Three concerns:
//   1. Declare the extension on the 402 challenge (`extensions['payment-identifier']`).
//   2. Look the incoming payment header up in the idempotency cache before
//      hitting the facilitator — same id + same payload → replay the cached
//      response with no on-chain settlement.
//   3. Write each successful (settled) response into the cache, tagged with
//      the SHA-256 of the request bytes so a second hit with the same id but
//      different payload returns 409 Conflict.
//
// The functions here are deliberately framework-free — they operate on a
// decoded payload + a small request descriptor — so they can be wired into
// both the `paidEndpoint()` wrapper and the standalone endpoints that hand-
// roll their 402 dance (model-check, mint-to-mesh, mint-to-mesh-batch).

import {
	PAYMENT_IDENTIFIER,
	declarePaymentIdentifierExtension as declareExt,
	extractPaymentIdentifier,
	isValidPaymentId,
} from '@x402/extensions/payment-identifier';

import { env } from '../env.js';
import { X402Error } from '../x402-errors.js';
import * as cache from './idempotency-cache.js';

export { PAYMENT_IDENTIFIER, extractPaymentIdentifier, isValidPaymentId };

// Default TTL — overridable per-route via `paidEndpoint({ paymentIdentifier:
// { ttlSeconds } })`. 3600s matches the spec's "Long TTL" guidance for
// infrequently changing resources.
const DEFAULT_TTL_SECONDS = 3600;

function envTtl() {
	const raw = env.X402_IDEMPOTENCY_TTL_SECONDS;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
}

// Build the extension object that goes onto the 402 challenge.
// `required=true` makes clients fail-fast with 400 if they don't send an ID
// — use this on endpoints where a duplicate call is materially expensive or
// observable (e.g. oracle attestations, fact-check submissions).
export function paymentIdentifierExtension(required = false) {
	return declareExt(Boolean(required));
}

// Decode an X-PAYMENT header without verifying it. Returns null if the
// header is malformed — we don't want a cache hit to mask a legit 400 from
// the facilitator, so we always fall through to the normal verify flow on
// decode failure.
function tryDecode(paymentHeader) {
	try {
		const json = Buffer.from(String(paymentHeader), 'base64').toString('utf8');
		const parsed = JSON.parse(json);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

// Pull the payment-identifier from the header (if present and valid).
// Returns null when the client didn't include one — that means "no
// idempotency for this call", not an error.
export function extractIdFromHeader(paymentHeader) {
	if (!paymentHeader) return null;
	const payload = tryDecode(paymentHeader);
	if (!payload) return null;
	return extractPaymentIdentifier(payload);
}

// Enforce required=true. Throws an X402Error(400) the caller can map to a
// clean response. The extension self-validates ID format on extract, so we
// only need to check presence here.
export function enforceRequired({ paymentHeader, required }) {
	if (!required) return;
	const id = extractIdFromHeader(paymentHeader);
	if (!id) {
		throw new X402Error(
			'payment_identifier_required',
			'this route requires a payment-identifier extension on the payment payload',
			400,
		);
	}
}

// Look up a cached response. Returns:
//   { kind: 'miss' }                                — no cached entry; proceed.
//   { kind: 'hit', entry }                          — replay entry; skip settle.
//   { kind: 'conflict', existingHash, attemptedHash } — same id, different payload.
//
// Security: a cache hit MUST be bound to the signed payment proof, not just the
// client-chosen id. We require `paymentHash` (sha256 of the X-PAYMENT header)
// to match the hash stored when the entry was written — only the original
// payer can reproduce that exact signed proof. A caller who knows the id but
// presents a different payment hashes differently and gets a `conflict`, never
// the cached body. `payloadHash` (request method+url) is an additional binding.
//
// When `payloadHash`/`paymentHash` is omitted we treat a cache entry with a
// non-null stored hash as a conflict — pass both whenever you can compute them.
export async function checkCache({ route, paymentId, payloadHash, paymentHash }) {
	if (!paymentId) return { kind: 'miss' };
	const entry = await cache.get(route, paymentId);
	if (!entry) return { kind: 'miss' };
	// A concurrent request with the same payment is still executing the paid work.
	// Signal the caller to back off rather than re-run it (closes the verify→settle
	// double-execution window).
	if (cache.isInflight(entry)) return { kind: 'inflight' };
	// Payment-proof binding: a stored entry written with a paymentHash only
	// replays to a caller presenting the same signed proof. A mismatch (or a
	// caller that omits the proof against a proof-bound entry) is a conflict —
	// this is the guard against a stolen/guessed id being redeemed for free.
	if (entry.paymentHash && entry.paymentHash !== (paymentHash || null)) {
		return {
			kind: 'conflict',
			existingHash: entry.payloadHash || null,
			attemptedHash: payloadHash || null,
			reason: 'payment_proof_mismatch',
		};
	}
	// Stored hash may be null on legacy/unknown-payload entries; treat
	// "no stored hash" as compatible with any incoming request so older
	// cached entries don't suddenly start 409ing.
	if (entry.payloadHash && payloadHash && entry.payloadHash !== payloadHash) {
		return {
			kind: 'conflict',
			existingHash: entry.payloadHash,
			attemptedHash: payloadHash,
		};
	}
	return { kind: 'hit', entry };
}

// Persist a settled response so a same-id retry can be served from the cache.
// Failure to write is logged inside idempotency-cache.js — never thrown,
// since the caller has already taken the user's money and must respond 2xx.
export async function storeResponse({
	route,
	paymentId,
	payloadHash,
	paymentHash,
	status,
	body,
	contentType,
	paymentResponseHeader,
	ttlSeconds,
}) {
	if (!paymentId) return;
	const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : envTtl();
	await cache.set(
		route,
		paymentId,
		{
			status,
			body,
			contentType,
			paymentResponseHeader,
			payloadHash: payloadHash || null,
			// Bind the entry to the signed payment proof so only the original
			// payer (who can reproduce the exact X-PAYMENT) can replay it.
			paymentHash: paymentHash || null,
			storedAt: new Date().toISOString(),
		},
		ttl,
	);
}

// Atomically claim the in-flight slot for a payment before doing the paid work.
// Returns true for the single winner; false when another request already holds
// the slot or a response is already cached. Pair with releaseSlot() on any
// failure path so a transient error doesn't lock the payer out of retrying.
export async function reserveSlot({ route, paymentId, ttlSeconds }) {
	if (!paymentId) return true;
	const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : envTtl();
	return cache.reserve(route, paymentId, ttl);
}

export async function releaseSlot({ route, paymentId }) {
	if (!paymentId) return;
	await cache.release(route, paymentId);
}

// Claim the in-flight slot for a payment, answering the request directly when
// the slot is already taken. The hand-rolled paid endpoints (api/x402/*.js)
// run check-then-act: cache lookup, verify, paid work, settle, THEN store.
// Without this claim, N concurrent requests carrying the same X-PAYMENT all
// miss the cache, all run the paid work, and all settle before the first
// response is stored — one payment, N deliveries. paidEndpoint closes the
// same window with reserveSlot at api/_lib/x402-paid-endpoint.js.
//
// Returns true when THIS request owns the slot and may proceed; false when a
// response was already written (cached replay, payload conflict, or another
// request in flight) and the caller must return immediately. Every failure
// return after a successful claim must releaseSlot() so a transient error
// never locks a legitimate payer out of retrying; the success path needs no
// release because storeResponse() overwrites the slot with the cached entry.
export async function claimSlotOrRespond({ res, route, paymentId, payloadHash, paymentHash, ttlSeconds }) {
	const owns = await reserveSlot({ route, paymentId, ttlSeconds });
	if (owns) return true;
	const recheck = await checkCache({ route, paymentId, payloadHash, paymentHash });
	if (recheck.kind === 'hit') {
		writeCachedResponse(res, recheck.entry);
		return false;
	}
	if (recheck.kind === 'conflict') {
		writeConflict(res, {
			route,
			attemptedHash: recheck.attemptedHash,
			existingHash: recheck.existingHash,
			reason: recheck.reason,
		});
		return false;
	}
	writeInflight(res);
	return false;
}

// Always-on replay guard for endpoints that hand-roll the x402 dance (the MCP
// servers, launchpad/invoke) instead of using paidEndpoint(). paidEndpoint
// closes the verify→deliver→settle window with a proof-hash reservation; this is
// the same guard, packaged as a one-liner those endpoints can wrap their
// dispatch+settle in.
//
// It reserves a single-use lock keyed on the SHA-256 of the signed X-PAYMENT
// proof — only the original payer can reproduce it — so a captured or retried
// payment can't re-run the (often expensive: LLM / RPC / generation) work before
// the first settle lands. Double-CHARGE is already prevented downstream (the
// on-chain EIP-3009 nonce / Solana blockhash + the deterministic facilitator
// Idempotency-Key); this closes the remaining gap: free re-delivery / compute
// amplification from a concurrent replay in the narrow pre-settlement window.
// Once a payment settles, the consumed nonce makes any later /verify fail, so the
// lock only needs to span dispatch+settle and the caller releases it as soon as
// the request finishes — leaving a transient failure free to retry the same
// payment.
//
// Fails OPEN: a missing header, or a store with no Redis, degrades to the
// best-effort in-process claim in cache.reserve — it never blocks a legitimate
// payment, matching the paidEndpoint stance (a Redis blip must not 5xx a paid
// call when double-charge is already protected on-chain).
//
// Returns { ok, release }:
//   ok=false  → a concurrent request already holds the slot for this exact
//               payment; the caller should reject (HTTP 409 / JSON-RPC error).
//   release() → idempotent; call once the request finishes (use a finally block).
export async function reservePaymentProof(route, paymentHeader) {
	const hash = cache.hashPaymentProof(paymentHeader);
	if (!hash) return { ok: true, release: async () => {} };
	const paymentId = `proof:${hash}`;
	const owns = await reserveSlot({ route, paymentId });
	let released = false;
	return {
		ok: owns,
		release: async () => {
			if (!owns || released) return;
			released = true;
			await releaseSlot({ route, paymentId });
		},
	};
}

// Flush a cached entry back onto the wire. Mirrors the headers the live path
// would have set (cache-control: no-store, x-payment-response, etc.) and
// tags the response with `x-x402-idempotent: replay` so the caller can tell
// they got a cached body.
export function writeCachedResponse(res, entry) {
	res.statusCode = Number.isInteger(entry.status) ? entry.status : 200;
	res.setHeader('content-type', entry.contentType || 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('x-x402-idempotent', 'replay');
	if (entry.paymentResponseHeader) {
		res.setHeader('x-payment-response', entry.paymentResponseHeader);
	}
	res.end(entry.body ?? '');
}

// Write a 409 Conflict explaining the mismatch. `reason` distinguishes a
// request-payload mismatch (same id reused for a different call) from a
// payment-proof mismatch (a stolen/guessed id presented with a different
// payment) — the latter is the security-relevant denial.
export function writeConflict(res, { route, attemptedHash, existingHash, reason }) {
	res.statusCode = 409;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('x-x402-idempotent', 'conflict');
	const description =
		reason === 'payment_proof_mismatch'
			? 'this payment-identifier was already used by a different payment; ' +
				'generate a fresh id and pay again'
			: 'a different request body was already processed under this payment-identifier; ' +
				'either retry the original payload or generate a new id';
	res.end(
		JSON.stringify({
			error: 'payment_identifier_conflict',
			error_description: description,
			route,
			attemptedPayloadHash: attemptedHash,
			existingPayloadHash: existingHash,
		}),
	);
}

// Write a 409 telling a concurrent caller the same payment is already being
// processed. Retry-After:1 nudges well-behaved clients to poll for the cached
// response rather than re-submitting (which would conflict on the proof hash).
export function writeInflight(res) {
	res.statusCode = 409;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('x-x402-idempotent', 'in-flight');
	res.setHeader('retry-after', '1');
	res.end(
		JSON.stringify({
			error: 'payment_in_flight',
			error_description:
				'a request with this payment is already being processed; retry shortly to receive the cached response',
		}),
	);
}

export { hashRequestPayload, hashPaymentProof } from './idempotency-cache.js';
export const ttlSeconds = envTtl;
