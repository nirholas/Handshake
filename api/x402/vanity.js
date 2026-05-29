// GET /api/x402/vanity?prefix=<base58>&suffix=<base58>&ignoreCase=<0|1>
//
// Paid endpoint cataloged by the CDP x402 Bazaar (agentic.market) and the
// pay-skills registry. The server grinds a brand-new Solana Ed25519 keypair
// whose Base58 address starts with `prefix` and/or ends with `suffix`, then
// returns the address plus its secret key (Base58 and 64-byte array forms).
// Buyers pay programmatically with @x402/fetch — no API keys, no accounts.
//
// Pricing is difficulty-tiered: a 1-char pattern is $0.01, 2 chars $0.05,
// 3 chars $0.25 — reflecting the ~58× jump in expected work per character.
// The 402 challenge quotes the price for the exact pattern requested. The
// combined pattern is capped at 3 characters server-side; the grind runs
// single-threaded in a Rust/WASM ed25519 engine (~25k keypairs/sec) under a
// 45-second budget. Longer patterns belong in the browser grinder at /vanity.
//
// The keypair is generated fresh per request and never persisted — the secret
// key exists only in the response body, served once over TLS. Settlement runs
// only after a successful grind, so an exhausted budget (rare, <1% at 3 chars)
// costs the buyer nothing and can be retried.
//
// Networks: Base mainnet (EIP-3009 + Permit2 sibling) and Solana mainnet
// (USDC). verifyPayment / settlePayment in x402-spec.js route per network. The
// Solana entry is omitted when X402_PAY_TO_SOLANA is unset so the 402 stays valid.

import { wrap, cors, error } from '../_lib/http.js';
import {
	NETWORK_BASE_MAINNET,
	NETWORK_SOLANA_MAINNET,
	send402,
	verifyPayment,
	settlePayment,
	encodePaymentResponseHeader,
	permit2VariantOf,
	resolveResourceUrl,
	buildBazaarSchema,
} from '../_lib/x402-spec.js';
import { env } from '../_lib/env.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	PAYMENT_IDENTIFIER,
	checkCache,
	extractIdFromHeader,
	hashRequestPayload,
	paymentIdentifierExtension,
	storeResponse,
	writeCachedResponse,
	writeConflict,
} from '../_lib/x402/payment-identifier-server.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import {
	grindVanityNode,
	validatePattern,
	expectedAttemptsFor,
	MAX_SERVER_PATTERN_LENGTH,
} from '../../src/solana/vanity/grinder-node.js';
import bs58 from 'bs58';

const ROUTE = '/api/x402/vanity';
const REQUIRED_SCOPE = 'x402:bypass';
const accessControl = installAccessControl({ requiredScope: REQUIRED_SCOPE });
const routeConfig = { path: ROUTE, method: 'GET', requiredScope: REQUIRED_SCOPE };

// Wall-clock budget for the grind. Kept under the route's 60s maxDuration with
// headroom for facilitator verify + settle round-trips.
const GRIND_TIME_BUDGET_MS = 45_000;

// Difficulty-tiered price in USDC atomic units (6 decimals). Indexed by the
// combined prefix+suffix length. Each character multiplies expected work by 58,
// so the price climbs to track compute cost. Length 0 (discovery probe with no
// pattern) quotes the 1-char base price.
const PRICE_BY_LENGTH = {
	0: 10_000, //  $0.01 — base / probe
	1: 10_000, //  $0.01
	2: 50_000, //  $0.05
	3: 250_000, // $0.25
};

function priceAtomicsFor(combinedLength) {
	return PRICE_BY_LENGTH[combinedLength] ?? PRICE_BY_LENGTH[MAX_SERVER_PATTERN_LENGTH];
}

const ROUTE_DESCRIPTION =
	'three.ws Solana Vanity Grinder — generate a brand-new Solana keypair whose ' +
	'Base58 address starts with your chosen prefix and/or ends with your chosen ' +
	'suffix. Returns the public address and its secret key (Base58 + 64-byte array) ' +
	'so you can import it into any Solana wallet. The key is ground fresh per ' +
	'request in a Rust/WASM ed25519 engine and never stored. Price scales with ' +
	'pattern difficulty ($0.01–$0.25); combined pattern capped at 3 Base58 ' +
	'characters. Pay-per-call in USDC on Base or Solana mainnet — no API keys.';

// Base58 excludes 0/O/I/l. Note also that an address is 32 random bytes
// Base58-encoded, so its LEADING characters are not uniformly distributed —
// a given prefix can be markedly harder than the naive 58^n estimate, while
// suffix characters are uniform. The example uses a reliable 2-char prefix.
const DISCOVERY_INPUT_EXAMPLE = { prefix: 'So', suffix: '', ignoreCase: '0' };

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
	},
};

const DISCOVERY_OUTPUT_EXAMPLE = {
	address: 'Sonh98bek7doEoRsv3kQ4wiGpXKoLjykwwMMW7j855U',
	prefix: 'So',
	suffix: null,
	ignoreCase: false,
	secretKeyBase58:
		'3yDa7yKFum6UDfu1xmMPaD4oi4VoWVs2f3MV8n8W3qb2Aqx6cDEBNs1kPj8M1GHYWBmiQravrwW3vsSVhqKDzfvA',
	secretKey: [
		148, 131, 95, 215, 78, 89, 60, 95, 3, 101, 148, 82, 38, 181, 56, 16, 169, 211, 230, 246,
		175, 77, 65, 244, 238, 93, 134, 100, 61, 49, 160, 234, 6, 156, 108, 96, 247, 163, 149, 94,
		138, 213, 165, 193, 67, 185, 170, 128, 123, 198, 234, 243, 158, 120, 123, 177, 250, 231,
		248, 199, 144, 30, 122, 75,
	],
	attempts: 160000,
	durationMs: 6030,
	expectedAttempts: 3364,
	network: 'solana',
	explorerUrl: 'https://solscan.io/account/Sonh98bek7doEoRsv3kQ4wiGpXKoLjykwwMMW7j855U',
};

const DISCOVERY_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['address', 'secretKeyBase58', 'secretKey', 'attempts'],
	properties: {
		address: { type: 'string', description: 'Base58 Solana public key.' },
		prefix: { type: ['string', 'null'] },
		suffix: { type: ['string', 'null'] },
		ignoreCase: { type: 'boolean' },
		secretKeyBase58: {
			type: 'string',
			description: 'Base58-encoded 64-byte Ed25519 secret key (import into Phantom/Solflare).',
		},
		secretKey: {
			type: 'array',
			items: { type: 'integer', minimum: 0, maximum: 255 },
			minItems: 64,
			maxItems: 64,
			description: '64-byte secret key as an int array — save as a Solana CLI keypair JSON.',
		},
		attempts: { type: 'integer', description: 'Keypairs tried before the match.' },
		durationMs: { type: 'number' },
		expectedAttempts: {
			type: 'integer',
			description: 'Naive 58^n expectation (prefix bias can make the real figure higher).',
		},
		network: { type: 'string' },
		explorerUrl: { type: 'string', format: 'uri' },
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
	const amount = String(priceAtomics);
	const eip3009 = {
		scheme: 'exact',
		network: NETWORK_BASE_MAINNET,
		amount,
		payTo: env.X402_PAY_TO_BASE,
		asset: env.X402_ASSET_ADDRESS_BASE,
		maxTimeoutSeconds: 60,
		resource: resourceUrl,
		extra: { name: 'USD Coin', version: '2', decimals: 6 },
	};
	const out = [eip3009];
	const permit2 = permit2VariantOf(eip3009);
	if (permit2) out.push(permit2);
	if (env.X402_PAY_TO_SOLANA) {
		out.push({
			scheme: 'exact',
			network: NETWORK_SOLANA_MAINNET,
			amount,
			payTo: env.X402_PAY_TO_SOLANA,
			asset: env.X402_ASSET_MINT_SOLANA,
			maxTimeoutSeconds: 60,
			resource: resourceUrl,
			extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
		});
	}
	return out;
}

// Parse + validate the requested pattern. Returns { prefix, suffix, ignoreCase,
// combinedLength } or throws an Error with .status/.code for a clean 4xx. A
// request with NO pattern (the Bazaar discovery probe) is allowed through with
// combinedLength 0 so the 402 challenge can still be emitted for indexing.
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
				`combined pattern length ${combinedLength} exceeds the server limit of ` +
					`${MAX_SERVER_PATTERN_LENGTH} characters — grind longer patterns in the browser at /vanity`,
			),
			{ status: 400, code: 'pattern_too_long' },
		);
	}
	return { prefix, suffix, ignoreCase, combinedLength };
}

function grindAndShape({ prefix, suffix, ignoreCase }) {
	const result = grindVanityNode({
		prefix,
		suffix,
		ignoreCase,
		timeBudgetMs: GRIND_TIME_BUDGET_MS,
	});
	return {
		address: result.publicKey,
		prefix: prefix || null,
		suffix: suffix || null,
		ignoreCase,
		secretKeyBase58: bs58.encode(result.secretKey),
		secretKey: Array.from(result.secretKey),
		attempts: result.attempts,
		durationMs: Math.round(result.durationMs),
		expectedAttempts: expectedAttemptsFor(prefix, suffix),
		network: 'solana',
		explorerUrl: `https://solscan.io/account/${result.publicKey}`,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (req.method !== 'GET') {
		res.setHeader('allow', 'GET');
		return error(res, 405, 'method_not_allowed', 'use GET');
	}

	// Light rate limit on the public (pre-payment) path so the 402 challenge
	// and parameter validation can't be hammered. The grind itself is paywalled.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	// Validate the pattern up front so a malformed request is rejected before we
	// ever quote a price. A pattern-free probe is allowed (combinedLength 0).
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
		serviceName: 'three.ws Solana Vanity Grinder',
		tags: ['solana', 'vanity', 'keypair', 'wallet', 'address'],
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

	// USE-23: access-control hook short-circuits payment for internal /
	// subscription / OAuth callers before we read the X-PAYMENT header.
	const acResult = await accessControl(req, routeConfig);
	if (acResult?.abort) {
		if (acResult.headers) {
			for (const [k, v] of Object.entries(acResult.headers)) res.setHeader(k, v);
		}
		return error(res, acResult.status || 403, acResult.code || 'access_denied', acResult.reason || 'access denied');
	}
	if (acResult?.grantAccess) {
		let result;
		try {
			result = grindAndShape(pattern);
		} catch (err) {
			return error(res, err.status || 500, err.code || 'internal_error', err.message);
		}
		if (acResult.headers) {
			for (const [k, v] of Object.entries(acResult.headers)) res.setHeader(k, v);
		}
		res.setHeader('x-payment-bypass', acResult.reason || 'granted');
		res.setHeader('cache-control', 'no-store');
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.end(JSON.stringify(result));
		return;
	}

	const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
	if (!paymentHeader) return send402(res, challenge);

	// USE-15: idempotency cache lookup before paying for /verify. A retried
	// payment (same payment-id, same query) returns the SAME ground keypair
	// instead of grinding a fresh one and double-charging.
	const paymentId = extractIdFromHeader(paymentHeader);
	const payloadHash = hashRequestPayload({ method: req.method, url: req.url, body: null });
	if (paymentId) {
		const lookup = await checkCache({ route: ROUTE, paymentId, payloadHash });
		if (lookup.kind === 'hit') return writeCachedResponse(res, lookup.entry);
		if (lookup.kind === 'conflict') {
			return writeConflict(res, {
				route: ROUTE,
				attemptedHash: lookup.attemptedHash,
				existingHash: lookup.existingHash,
			});
		}
	}

	let verified;
	try {
		verified = await verifyPayment({ paymentHeader, requirements });
	} catch (err) {
		if (err.status === 402) return send402(res, { ...challenge, error: err.message });
		return error(res, err.status || 502, err.code || 'verify_failed', err.message);
	}

	// Grind AFTER verify but BEFORE settle: an invalid pattern or exhausted
	// budget throws here, and settlement never runs, so the buyer isn't charged.
	let result;
	try {
		result = grindAndShape(pattern);
	} catch (err) {
		return error(res, err.status || 500, err.code || 'grind_failed', err.message);
	}

	let settled;
	try {
		settled = await settlePayment({ verified });
	} catch (err) {
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
			status: 200,
			body,
			contentType,
			paymentResponseHeader,
		});
	}
});
