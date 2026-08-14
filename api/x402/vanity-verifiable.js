// GET /api/x402/vanity-verifiable?prefix=<base58>&suffix=<base58>&ignoreCase=<0|1>
//   &clientSeed=<hex|base58>&sealTo=<X25519 pubkey>
//
// Provably-fair sibling of /api/x402/vanity. Same x402 pay-per-call rails, same
// idempotency + verify-grind-settle ordering — but every key is ground under a
// COMMIT–REVEAL seed-mixing protocol (three-vanity/v1) and delivered with a
// signed, independently-verifiable receipt. A buyer can prove, after the fact
// and with open-source tooling, that:
//
//   1. the key was generated fresh from entropy the server COMMITTED to before
//      it knew the result (commitment = SHA-256(serverSeed), bound into the
//      signed receipt) — no precomputed rainbow table keyed to your pattern;
//   2. the buyer's own clientSeed was mixed in, so neither party alone controlled
//      the output;
//   3. the address derives from the revealed seed at the claimed index, matches
//      the pattern, and the difficulty claim is the honest 58^n model;
//   4. the secret was sealed only to the buyer (ECIES) — strongly defaulted, so
//      the plaintext key never appears in the response, a log, or the cache.
//
// The receipt is signed by the service's long-lived Ed25519 identity key,
// published at /.well-known/three-vanity.json and pinned in the SDK + verifier.
// Verify with @three-ws/solana-agent's verifyVanityReceipt(), the CLI
// (scripts/verify-vanity-receipt.mjs), or the /vanity/verify web page.
//
// Determinism is the whole point, so grinding walks a deterministic candidate
// stream in pure-JS Ed25519 (verifiable-grind.js) rather than the WASM engine —
// the verifier must reproduce the exact stream. That runs slower than WASM, so
// the combined pattern is capped at 3 chars and priced to track expected work.
//
// The plain /api/x402/vanity endpoint keeps working unchanged.

import { wrap, cors, error, rateLimited } from '../_lib/http.js';
import {
	send402,
	verifyPayment,
	settlePayment,
	encodePaymentResponseHeader,
	buildExactRequirements,
	resolveResourceUrl,
	buildBazaarSchema,
} from '../_lib/x402-spec.js';
import { env } from '../_lib/env.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	PAYMENT_IDENTIFIER,
	checkCache,
	claimSlotOrRespond,
	extractIdFromHeader,
	hashPaymentProof,
	hashRequestPayload,
	paymentIdentifierExtension,
	releaseSlot,
	storeResponse,
	writeCachedResponse,
	writeConflict,
} from '../_lib/x402/payment-identifier-server.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { validatePattern, expectedAttempts, DIFFICULTY_MODEL } from '../../src/solana/vanity/validation.js';
import {
	sealToRecipient,
	parseX25519Key,
	SEALED_ENVELOPE_SCHEME,
} from '../../src/solana/vanity/sealed-envelope.js';
import {
	PROTOCOL_VERSION,
	RECEIPT_TYPE,
	commitToSeed,
	deriveMasterSeed,
	grindDeterministic,
	randomSeed,
	signReceipt,
} from '../../src/solana/vanity/verifiable-grind.js';
import { getServiceIdentity } from '../_lib/vanity-service-key.js';
import bs58 from 'bs58';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const ROUTE = '/api/x402/vanity-verifiable';
const REQUIRED_SCOPE = 'x402:bypass';
const accessControl = installAccessControl({ requiredScope: REQUIRED_SCOPE });
const routeConfig = { path: ROUTE, method: 'GET', requiredScope: REQUIRED_SCOPE };

// Pure-JS Ed25519 derivation is the verifiability cost: ~a few thousand
// candidates/sec vs the WASM engine's ~25k. We budget conservatively under the
// 60s function ceiling and cap at 3 combined chars; ≥3 chars should run in the
// browser grinder, then be self-verified locally.
const GRIND_TIME_BUDGET_MS = 40_000;
const GRIND_MAX_ATTEMPTS = 5_000_000;

// Largest combined (prefix + suffix) length grindable server-side. Beyond this,
// pure-JS Ed25519 derivation can't clear the time budget; the browser grinder
// at /vanity handles longer patterns, then receipts self-verify locally.
const MAX_SERVER_PATTERN_LENGTH = 3;

// Difficulty-tiered price in USDC atomic units (6 decimals), indexed by the
// combined prefix+suffix length. Verifiable mode carries a small premium over
// the plain endpoint to reflect the slower deterministic derivation + signing.
const PRICE_BY_LENGTH = {
	0: 20_000, //  $0.02 — base / probe
	1: 20_000, //  $0.02
	2: 100_000, // $0.10
	3: 400_000, // $0.40
};

function priceAtomicsFor(combinedLength) {
	return PRICE_BY_LENGTH[combinedLength] ?? PRICE_BY_LENGTH[MAX_SERVER_PATTERN_LENGTH];
}

const ROUTE_DESCRIPTION =
	'three.ws Provably-Fair Vanity Grinder — generate a brand-new Solana wallet ' +
	'whose Base58 address starts with your chosen prefix and/or ends with your suffix, ' +
	'with a SIGNED, independently-verifiable receipt that proves we generated the key ' +
	'fresh and never kept a copy. The server commits to a random 32-byte seed ' +
	'(commitment = SHA-256(serverSeed)) BEFORE grinding, mixes in your optional ' +
	'clientSeed so neither party alone controls the output, derives each candidate ' +
	'deterministically (HMAC-SHA256 → Ed25519), and signs a receipt with its ' +
	'long-lived service key (published at /.well-known/three-vanity.json). Pass ' +
	'sealTo=<X25519 public key> (strongly recommended) and the secret is ECIES-sealed ' +
	'to you — the plaintext never appears in the response or any log. Verify the ' +
	"receipt entirely client-side with @three-ws/solana-agent's verifyVanityReceipt(), " +
	'the open-source CLI, or three.ws/vanity/verify. Capped at 3 Base58 chars, priced ' +
	'$0.02–$0.40. Pay-per-call in USDC on Base or Solana mainnet — no API keys.';

const DISCOVERY_INPUT_EXAMPLE = { prefix: 'So', suffix: '', ignoreCase: '0', sealTo: '' };

const DISCOVERY_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		prefix: {
			type: 'string',
			description:
				'Base58 characters the address must start with. Base58 excludes 0, O, I, l. ' +
				'Combined with suffix, max 3 characters.',
		},
		suffix: {
			type: 'string',
			description: 'Base58 characters the address must end with. Combined with prefix, max 3 characters.',
		},
		ignoreCase: {
			type: 'string',
			enum: ['0', '1', 'true', 'false'],
			description: 'When 1/true, match the pattern case-insensitively (faster, less specific).',
		},
		clientSeed: {
			type: 'string',
			description:
				'Optional. Your own entropy as hex or Base58 (any length). Mixed into the seed so ' +
				'the server could not have predicted the result at commit time. A fresh random one ' +
				'is generated and revealed in the receipt when omitted.',
		},
		sealTo: {
			type: 'string',
			description:
				'Strongly recommended. Your 32-byte X25519 public key (Base58, Base64url, or hex). ' +
				'When set, the secret is ECIES-sealed to it and omitted from the response — open it ' +
				'client-side with the matching private key.',
		},
	},
};

// SECURITY: discovery EXAMPLE only — the fields below document the response
// shape, they are NOT a real key. serverSeed/address/signature are synthetic.
const DISCOVERY_OUTPUT_EXAMPLE = {
	protocol: PROTOCOL_VERSION,
	receiptType: RECEIPT_TYPE,
	address: 'SoEXAMPLEdoNotUse1111111111111111111111111111',
	pattern: { prefix: 'So', suffix: null, ignoreCase: false },
	commitment: '0000000000000000000000000000000000000000000000000000000000000000',
	serverSeed: '0000000000000000000000000000000000000000000000000000000000000000',
	clientSeed: '1111111111111111111111111111111111111111111111111111111111111111',
	requestNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
	winningIndex: 3041,
	attempts: 3042,
	durationMs: 1180,
	difficulty: { expectedAttempts: 57960, model: DIFFICULTY_MODEL },
	sealed: true,
	sealedScheme: SEALED_ENVELOPE_SCHEME,
	sealedRecipient: '<Base58 X25519 recipient>',
	sealedEpk: '<Base58 ephemeral public key>',
	sealedSecret: { scheme: SEALED_ENVELOPE_SCHEME, epk: '…', nonce: '…', ciphertext: '…', recipient: '…' },
	servicePublicKey: '<Base58 Ed25519 service key>',
	signature: '<hex Ed25519 signature>',
	signatureScheme: 'ed25519',
	ts: '2026-06-19T00:00:00.000Z',
	network: 'solana',
	explorerUrl: 'https://solscan.io/account/SoEXAMPLEdoNotUse1111111111111111111111111111',
	verifyUrl: 'https://three.ws/vanity/verify',
	serviceKeyUrl: 'https://three.ws/.well-known/three-vanity.json',
};

const DISCOVERY_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['protocol', 'address', 'commitment', 'serverSeed', 'winningIndex', 'signature', 'servicePublicKey'],
	properties: {
		protocol: { type: 'string', const: PROTOCOL_VERSION },
		receiptType: { type: 'string' },
		address: { type: 'string', description: 'Base58 Solana public key.' },
		pattern: { type: 'object' },
		commitment: { type: 'string', description: 'SHA-256(serverSeed), committed before grinding.' },
		serverSeed: { type: 'string', description: 'Revealed 32-byte seed (hex). Verify SHA-256 = commitment.' },
		clientSeed: { type: 'string', description: 'Buyer entropy mixed into the seed (hex).' },
		requestNonce: { type: 'string' },
		winningIndex: { type: 'integer', description: 'Candidate index whose address matched.' },
		attempts: { type: 'integer' },
		durationMs: { type: 'number' },
		difficulty: { type: 'object' },
		sealed: { type: 'boolean' },
		sealedSecret: { type: 'object', description: 'ECIES envelope — open with your X25519 private key.' },
		secretKeyBase58: { type: 'string', description: 'Present only when sealTo is omitted.' },
		secretKey: { type: 'array', items: { type: 'integer' }, description: 'Present only when sealTo is omitted.' },
		servicePublicKey: { type: 'string', description: 'Base58 Ed25519 key that signed this receipt.' },
		signature: { type: 'string', description: 'Hex Ed25519 signature over the canonical receipt.' },
		verifyUrl: { type: 'string', format: 'uri' },
		serviceKeyUrl: { type: 'string', format: 'uri' },
	},
};

const ROUTE_BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET', queryParams: DISCOVERY_INPUT_EXAMPLE },
		output: { type: 'json', example: DISCOVERY_OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: DISCOVERY_INPUT_SCHEMA,
		outputSchema: DISCOVERY_OUTPUT_SCHEMA,
	}),
};

function buildRequirements(resourceUrl, priceAtomics) {
	// Solana-first accepts, Base gated on baseSettleable() (CDP or opt-in) plus its
	// gasless Permit2 sibling under CDP — see buildExactRequirements.
	return buildExactRequirements(resourceUrl, priceAtomics);
}

// Parse a client-supplied seed (hex or Base58) into bytes, or generate a fresh
// random 32-byte seed when omitted. Throws a clean 400 on malformed input.
function parseClientSeed(raw) {
	if (raw == null || raw === '') return randomSeed();
	const s = String(raw).trim();
	try {
		if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
			const b = hexToBytes(s);
			if (b.length === 0 || b.length > 1024) throw new Error('length');
			return b;
		}
		const b = bs58.decode(s);
		if (b.length === 0 || b.length > 1024) throw new Error('length');
		return b;
	} catch {
		throw Object.assign(new Error('clientSeed must be hex or Base58 (1–1024 bytes)'), {
			status: 400,
			code: 'validation_error',
		});
	}
}

function parsePattern(req) {
	const q = req.query || {};
	const prefix = typeof q.prefix === 'string' ? q.prefix.trim() : '';
	const suffix = typeof q.suffix === 'string' ? q.suffix.trim() : '';
	const ignoreCase = q.ignoreCase === '1' || q.ignoreCase === 'true';

	for (const [label, pattern] of [['prefix', prefix], ['suffix', suffix]]) {
		if (!pattern) continue;
		const v = validatePattern(pattern);
		if (!v.valid) {
			throw Object.assign(new Error(`invalid ${label}: ${v.errors.join('; ')}`), {
				status: 400,
				code: 'validation_error',
			});
		}
	}

	const combinedLength = prefix.length + suffix.length;
	if (combinedLength > MAX_SERVER_PATTERN_LENGTH) {
		throw Object.assign(
			new Error(
				`combined pattern length ${combinedLength} exceeds the verifiable-grind server limit of ` +
					`${MAX_SERVER_PATTERN_LENGTH} characters — grind longer patterns in the browser at /vanity, ` +
					`then self-verify your own receipt locally`,
			),
			{ status: 400, code: 'pattern_too_long' },
		);
	}

	let sealTo = null;
	if (typeof q.sealTo === 'string' && q.sealTo.trim()) {
		sealTo = q.sealTo.trim();
		parseX25519Key(sealTo, 'sealTo'); // validate shape up front (clean 400 pre-payment)
	}

	const clientSeed = parseClientSeed(q.clientSeed);

	return { prefix, suffix, ignoreCase, combinedLength, sealTo, clientSeed };
}

const PUBLIC_ORIGIN = env.APP_ORIGIN || 'https://three.ws';

async function grindAndBuildReceipt({ prefix, suffix, ignoreCase, sealTo, clientSeed }) {
	const identity = await getServiceIdentity();
	const serverSeed = randomSeed();
	const requestNonce = randomSeed().slice(0, 16);
	const commitment = commitToSeed(serverSeed);

	const masterSeed = deriveMasterSeed({ serverSeed, clientSeed, requestNonce });
	const result = grindDeterministic({
		masterSeed,
		prefix,
		suffix,
		ignoreCase,
		maxAttempts: GRIND_MAX_ATTEMPTS,
		timeBudgetMs: GRIND_TIME_BUDGET_MS,
	});
	if (!result.found) {
		throw Object.assign(
			new Error(
				`grind budget exhausted after ${result.attempts} attempts in ${Math.round(result.durationMs)}ms — retry`,
			),
			{ status: 504, code: 'grind_exhausted' },
		);
	}

	const difficulty = {
		expectedAttempts: Math.round(expectedAttempts(prefix, suffix, ignoreCase)),
		model: DIFFICULTY_MODEL,
	};

	// Seal the secret to the buyer when an X25519 key is supplied. The signed
	// receipt records the envelope's recipient + epk so the buyer can prove THIS
	// envelope belongs to THIS key. The plaintext secret only ships when unsealed.
	let sealed = null;
	if (sealTo) {
		const bundle = {
			format: 'keypair',
			secretKeyBase58: bs58.encode(result.secretKey),
			secretKey: Array.from(result.secretKey),
			seed: bytesToHex(result.seed),
		};
		sealed = await sealToRecipient(JSON.stringify(bundle), sealTo);
	}

	const core = {
		protocol: PROTOCOL_VERSION,
		receiptType: RECEIPT_TYPE,
		address: result.address,
		pattern: { prefix: prefix || null, suffix: suffix || null, ignoreCase },
		commitment,
		serverSeed: bytesToHex(serverSeed),
		clientSeed: bytesToHex(clientSeed),
		requestNonce: bytesToHex(requestNonce),
		winningIndex: result.index,
		attempts: result.attempts,
		durationMs: Math.round(result.durationMs),
		difficulty,
		sealed: !!sealed,
		sealedScheme: sealed ? SEALED_ENVELOPE_SCHEME : null,
		sealedRecipient: sealed ? sealed.recipient : null,
		sealedEpk: sealed ? sealed.epk : null,
		network: 'solana',
		ts: new Date().toISOString(),
	};

	const signed = signReceipt({ core, signingSeed: identity.seed });

	// Assemble the response: the signed receipt + delivery (sealed envelope or
	// the plaintext key when unsealed) + navigation to the verifier.
	const response = {
		...signed,
		explorerUrl: `https://solscan.io/account/${result.address}`,
		verifyUrl: `${PUBLIC_ORIGIN}/vanity/verify`,
		serviceKeyUrl: `${PUBLIC_ORIGIN}/.well-known/three-vanity.json`,
	};
	if (sealed) {
		response.sealedSecret = sealed;
		response.sealedFields = ['format', 'secretKeyBase58', 'secretKey', 'seed'];
	} else {
		response.secretKeyBase58 = bs58.encode(result.secretKey);
		response.secretKey = Array.from(result.secretKey);
		response.seed = bytesToHex(result.seed);
	}
	return response;
}

// Cache-safe copy of a delivered receipt. The x402 replay/idempotency cache must
// never hold spendable key material at rest (same rule as api/x402/vanity.js),
// and TWO fields here are key-equivalent, so both have to go:
//   1. the plaintext secret (secretKeyBase58 / secretKey / seed), present
//      whenever the buyer did not pass sealTo;
//   2. serverSeed, which is key-equivalent even on a SEALED delivery. The
//      protocol is deterministic by design: masterSeed = HKDF(serverSeed ||
//      clientSeed || requestNonce), and candidate `winningIndex` derives the
//      Ed25519 secret from it. Anyone holding a full receipt can recompute the
//      private key, which is exactly what makes the receipt verifiable.
// What stays is everything that cannot reconstruct the key: `commitment` is a
// preimage-resistant hash of serverSeed, and `sealedSecret` is ciphertext only
// the buyer's X25519 key opens. A replayed payment therefore gets the public
// metadata and an explicit marker, never a second copy of the secret.
export function cacheSafeBody(result) {
	const { secretKeyBase58, secretKey, seed, serverSeed, ...publicMeta } = result;
	void secretKeyBase58; void secretKey; void seed; void serverSeed;
	return JSON.stringify({
		...publicMeta,
		secret_omitted_from_cache: true,
		note: 'The ground secret and the receipt\'s serverSeed are returned once, in the original response, and are never stored. Both are key-equivalent under three-vanity/v1, so neither is retained here. If you did not capture the receipt, grind again.',
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (req.method !== 'GET') {
		res.setHeader('allow', 'GET');
		return error(res, 405, 'method_not_allowed', 'use GET');
	}

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let pattern;
	try {
		pattern = parsePattern(req);
	} catch (err) {
		return error(res, err.status || 400, err.code || 'validation_error', err.message);
	}

	const resourceUrl = resolveResourceUrl(req, ROUTE);
	const priceAtomics = priceAtomicsFor(pattern.combinedLength);
	const requirements = buildRequirements(resourceUrl, priceAtomics);
	const service = withService({
		serviceName: 'three.ws Provably-Fair Vanity Grinder',
		tags: ['solana', 'vanity', 'keypair', 'wallet', 'provably-fair', 'verifiable', 'trustless', 'attestation'],
	});
	const challenge = {
		resourceUrl,
		accepts: requirements,
		description: ROUTE_DESCRIPTION,
		bazaar: ROUTE_BAZAAR,
		extensions: { [PAYMENT_IDENTIFIER]: paymentIdentifierExtension(false) },
		serviceName: service.serviceName,
		tags: service.tags,
		iconUrl: service.iconUrl,
	};

	const acResult = await accessControl(req, routeConfig);
	if (acResult?.abort) {
		if (acResult.headers) for (const [k, v] of Object.entries(acResult.headers)) res.setHeader(k, v);
		return error(res, acResult.status || 403, acResult.code || 'access_denied', acResult.reason || 'access denied');
	}
	if (acResult?.grantAccess) {
		let result;
		try {
			result = await grindAndBuildReceipt(pattern);
		} catch (err) {
			return error(res, err.status || 500, err.code || 'internal_error', err.message);
		}
		if (acResult.headers) for (const [k, v] of Object.entries(acResult.headers)) res.setHeader(k, v);
		res.setHeader('x-payment-bypass', acResult.reason || 'granted');
		res.setHeader('cache-control', 'no-store');
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.end(JSON.stringify(result));
		return;
	}

	const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
	if (!paymentHeader) return send402(res, challenge);

	const clientPaymentId = extractIdFromHeader(paymentHeader);
	const payloadHash = hashRequestPayload({ method: req.method, url: req.url, body: null });
	const paymentHash = hashPaymentProof(paymentHeader);
	const paymentId = clientPaymentId || (paymentHash ? `proof:${paymentHash}` : null);
	// Close the check-then-act window: N concurrent requests carrying the same
	// payment could all miss the cache, all run the paid work, and all settle
	// before the first response was stored. The NX claim admits exactly one;
	// the rest are answered inside claimSlotOrRespond (replay/conflict/in-flight).
	let ownsReservation = false;
	if (paymentId) {
		const lookup = await checkCache({ route: ROUTE, paymentId, payloadHash, paymentHash });
		if (lookup.kind === 'hit') return writeCachedResponse(res, lookup.entry);
		if (lookup.kind === 'conflict') {
			return writeConflict(res, {
				route: ROUTE,
				attemptedHash: lookup.attemptedHash,
				existingHash: lookup.existingHash,
				reason: lookup.reason,
			});
		}
		ownsReservation = await claimSlotOrRespond({ res, route: ROUTE, paymentId, payloadHash, paymentHash });
		if (!ownsReservation) return;
	}

	let verified;
	try {
		verified = await verifyPayment({ paymentHeader, requirements });
	} catch (err) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		if (err.status === 402) return send402(res, { ...challenge, error: err.message });
		return error(res, err.status || 502, err.code || 'verify_failed', err.message);
	}

	// Grind AFTER verify but BEFORE settle: an exhausted budget throws here and
	// settlement never runs, so the buyer isn't charged for a failed grind.
	let result;
	try {
		result = await grindAndBuildReceipt(pattern);
	} catch (err) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		return error(res, err.status || 500, err.code || 'grind_failed', err.message);
	}

	let settled;
	try {
		settled = await settlePayment({ verified });
	} catch (err) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		return error(res, err.status || 502, err.code || 'settle_failed', err.message);
	}

	const paymentResponseHeader = encodePaymentResponseHeader(settled);
	const contentType = 'application/json; charset=utf-8';
	const body = JSON.stringify(result);

	res.setHeader('x-payment-response', paymentResponseHeader);
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', contentType);
	res.end(body);

	if (paymentId) {
		await storeResponse({
			route: ROUTE,
			paymentId,
			payloadHash,
			paymentHash,
			status: 200,
			body: cacheSafeBody(result),
			contentType,
			paymentResponseHeader,
		});
	}
});
