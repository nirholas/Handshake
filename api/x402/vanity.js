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
import {
	grindVanityNode,
	validatePattern,
	expectedAttemptsFor,
	MAX_SERVER_PATTERN_LENGTH,
} from '../../src/solana/vanity/grinder-node.js';
import {
	grindVanityMnemonic,
	expectedMnemonicAttempts,
	MAX_MNEMONIC_PATTERN_LENGTH,
} from '../../src/solana/vanity/mnemonic-grinder.js';
import { STRENGTH_WORD_COUNTS, DEFAULT_STRENGTH } from '../../src/solana/vanity/mnemonic.js';
import {
	sealToRecipient,
	parseX25519Key,
	SEALED_ENVELOPE_SCHEME,
} from '../../src/solana/vanity/sealed-envelope.js';
import { buildCertificateCore, signCertificate } from '../../src/solana/vanity/proof-of-grind.js';
import { getServiceIdentity } from '../_lib/vanity-service-key.js';
import { registerCert } from '../_lib/vanity-cert-store.js';
import {
	claimMatchingPattern,
	hasAvailableMatch,
	peekReservedSecret,
	reserveAndReveal,
	releaseReservation,
	isDbUnavailableError,
} from '../_lib/vanity-inventory-store.js';
import { openSecret } from '../_lib/vanity-vault.js';
import { priceFor } from '../_lib/x402-prices.js';
import bs58 from 'bs58';

const ROUTE = '/api/x402/vanity';
const REQUIRED_SCOPE = 'x402:bypass';
const accessControl = installAccessControl({ requiredScope: REQUIRED_SCOPE });
const routeConfig = { path: ROUTE, method: 'GET', requiredScope: REQUIRED_SCOPE };

// Wall-clock budget for the grind. Kept under the route's 60s maxDuration with
// headroom for facilitator verify + settle round-trips.
const GRIND_TIME_BUDGET_MS = 45_000;

// Output formats. `keypair` (default) returns a raw Ed25519 secret key ground in
// the WASM engine. `mnemonic` returns a BIP-39 seed phrase whose derived key
// (m/44'/501'/0'/0', Phantom's default) lands on the vanity address — importable
// as a recovery phrase into any wallet.
const FORMAT_KEYPAIR = 'keypair';
const FORMAT_MNEMONIC = 'mnemonic';
const FORMATS = new Set([FORMAT_KEYPAIR, FORMAT_MNEMONIC]);

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

// Mnemonic mode grinds ~100× slower (PBKDF2-HMAC-SHA512 per attempt) and ships a
// full importable seed phrase, so it is priced as a premium tier and capped at
// 2 characters server-side.
const PRICE_BY_LENGTH_MNEMONIC = {
	0: 50_000, //  $0.05 — base / probe
	1: 50_000, //  $0.05
	2: 500_000, // $0.50
};

// 4–5 Base58 chars is past what a single 45s server grind can reach (58^4 ≈
// 11.3M attempts ≈ 7.5 min at the WASM engine's ~25k/s; 58^5 ≈ 656M ≈ 7+
// hours) — those lengths are ONLY ever fulfilled from the pre-ground premium
// inventory (workers/vanity-grinder, api/x402/vanity-premium.js), never
// ground live. Priced well above the flat per-length grind tiers to reflect
// the batch-CPU cost of stocking them ahead of time; env-overridable per
// api/_lib/x402-prices.js so ops can retune without a redeploy. `format=
// mnemonic` is NOT extended here — the batch grinder only stocks raw
// keypairs (mnemonic grinding is itself ~100× slower to produce ahead of
// time), so mnemonic stays capped at MAX_MNEMONIC_PATTERN_LENGTH.
const PREMIUM_PRICE_BY_LENGTH = {
	4: () => Number(priceFor('vanity-4', '2500000')), // $2.50 default
	5: () => Number(priceFor('vanity-5', '10000000')), // $10 default
};

// Keypair patterns up to this length are OFFERED (priced + quoted), but only
// ever served from inventory (see hasAvailableMatch gate below) — never
// ground live. Patterns longer than MAX_SERVER_PATTERN_LENGTH and up to this
// ceiling are the "premium" band.
export const INVENTORY_MAX_PATTERN_LENGTH = 5;

export function priceAtomicsFor(format, combinedLength) {
	if (format === FORMAT_MNEMONIC) {
		return PRICE_BY_LENGTH_MNEMONIC[combinedLength] ?? PRICE_BY_LENGTH_MNEMONIC[MAX_MNEMONIC_PATTERN_LENGTH];
	}
	if (combinedLength > MAX_SERVER_PATTERN_LENGTH) {
		const premium = PREMIUM_PRICE_BY_LENGTH[Math.min(combinedLength, INVENTORY_MAX_PATTERN_LENGTH)];
		if (premium) return premium();
	}
	return PRICE_BY_LENGTH[combinedLength] ?? PRICE_BY_LENGTH[MAX_SERVER_PATTERN_LENGTH];
}

const ROUTE_DESCRIPTION =
	'three.ws Solana Vanity Grinder — put your brand on-chain: get a Solana address ' +
	'that starts with your ticker/prefix and/or ends with a chosen suffix. Use it as a ' +
	'branded token MINT address, a recognizable agent or treasury wallet, or any wallet ' +
	'you want identifiable at a glance. The server grinds a brand-new keypair to match — ' +
	'no wallet, account, or SOL required. Two output formats: format=keypair (default) ' +
	'returns the public address and its secret key (Base58 + 64-byte array), ground in a ' +
	'Rust/WASM ed25519 engine — live-ground up to 3 Base58 chars, priced $0.01 (1 char) / ' +
	'$0.05 (2) / $0.25 (3). Longer 4–5 char patterns are offered too, priced $2.50 (4) / ' +
	'$10 (5), but ONLY ever served from the pre-ground premium inventory (never ground ' +
	'live) — a pattern with no inventory match 404s as not_in_stock instead of quoting a ' +
	'price you could never redeem; browse stock at GET /api/x402/vanity-premium. ' +
	'format=mnemonic returns a BIP-39 seed phrase (12 or 24 words) whose ' +
	"derived key at m/44'/501'/0'/0' lands on the vanity address, importable as a recovery " +
	'phrase into Phantom / Solflare / the Solana CLI — capped at 2 chars (~100× slower to ' +
	'grind), priced $0.05 (1 char) / $0.50 (2). Security model: nothing is ever stored — ' +
	'the secret exists only in the response, served once over TLS, and is stripped from the ' +
	'replay/idempotency cache. Optional sealTo=<X25519 public key> seals the secret to you ' +
	'(ECIES; x25519-hkdf-sha256-aes256gcm) so the plaintext never appears in the response ' +
	'or any log — open it client-side with the matching private key. Keyless and ' +
	'account-free: pay-per-call in USDC on Base or Solana mainnet — no API keys, no signup. ' +
	'A matching pre-ground address in the premium inventory is delivered instantly instead ' +
	"of grinding one — response.source is 'inventory' (pre-generated server-side, never " +
	"re-served — same one-time delivery guarantee as vanity-premium) or 'ground' (freshly " +
	'mined this request), and pricing is identical either way.';

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
			description:
				'Base58 characters the address must end with. Combined with prefix, max 3 characters.',
		},
		ignoreCase: {
			type: 'string',
			enum: ['0', '1', 'true', 'false'],
			description:
				'When 1/true, match the pattern case-insensitively (faster, less specific).',
		},
		format: {
			type: 'string',
			enum: ['keypair', 'mnemonic'],
			description:
				'keypair (default): return a raw 64-byte Ed25519 secret key, up to 3 chars. ' +
				'mnemonic: return a BIP-39 seed phrase importable into any wallet, up to 2 chars.',
		},
		strength: {
			type: 'string',
			enum: ['128', '256'],
			description:
				'Mnemonic mode only. 128 → 12 words (default), 256 → 24 words. Ignored for keypair format.',
		},
		sealTo: {
			type: 'string',
			description:
				'Optional. Your 32-byte X25519 public key (Base58, Base64url, or hex). When set, ' +
				'the secret is sealed to it (x25519-hkdf-sha256-aes256gcm) and the plaintext secret ' +
				'is omitted from the response — open it client-side with the matching private key.',
		},
	},
};

// SECURITY: this is a discovery-schema EXAMPLE only — it documents the response
// shape, it is NOT a real key. The secretKey/secretKeyBase58 below are synthetic
// placeholders (all-zero bytes), never a funded keypair. The live endpoint grinds
// and returns a fresh keypair per request; never paste a real secret key here.
const DISCOVERY_OUTPUT_EXAMPLE = {
	address: 'SoEXAMPLEdoNotUse1111111111111111111111111111',
	prefix: 'So',
	suffix: null,
	ignoreCase: false,
	format: 'keypair',
	secretKeyBase58: '<example-only — the live endpoint returns the ground secret key here>',
	secretKey: [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0,
	],
	mnemonic: null,
	wordCount: null,
	derivationPath: null,
	attempts: 160000,
	durationMs: 6030,
	expectedAttempts: 57960,
	network: 'solana',
	explorerUrl: 'https://solscan.io/account/SoEXAMPLEdoNotUse1111111111111111111111111111',
	source: 'ground',
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
		format: { type: 'string', enum: ['keypair', 'mnemonic'] },
		secretKeyBase58: {
			type: 'string',
			description:
				'Base58-encoded 64-byte Ed25519 secret key (import into Phantom/Solflare). ' +
				'Present in both formats — in mnemonic mode it is the key derived from the phrase.',
		},
		secretKey: {
			type: 'array',
			items: { type: 'integer', minimum: 0, maximum: 255 },
			minItems: 64,
			maxItems: 64,
			description: '64-byte secret key as an int array — save as a Solana CLI keypair JSON.',
		},
		mnemonic: {
			type: ['string', 'null'],
			description:
				'mnemonic format only: BIP-39 seed phrase (12/24 words). Type it into any wallet ' +
				'to recover this address. null in keypair format.',
		},
		wordCount: { type: ['integer', 'null'], description: 'mnemonic format only: 12 or 24.' },
		derivationPath: {
			type: ['string', 'null'],
			description: "mnemonic format only: BIP-44 path, e.g. m/44'/501'/0'/0'.",
		},
		sealed: {
			type: 'boolean',
			description:
				'Present and true only when sealTo was supplied. The plaintext secret fields ' +
				'(secretKeyBase58/secretKey/mnemonic) are then omitted in favor of sealedSecret.',
		},
		sealedSecret: {
			type: 'object',
			description:
				'sealTo only: ECIES envelope { scheme, epk, nonce, ciphertext, recipient }. Open it ' +
				'with the X25519 private key matching sealTo to recover a JSON bundle of the secret.',
		},
		sealedFields: {
			type: 'array',
			items: { type: 'string' },
			description: 'sealTo only: the field names contained in the decrypted JSON bundle.',
		},
		attempts: { type: 'integer', description: 'Keypairs tried before the match.' },
		durationMs: { type: 'number' },
		expectedAttempts: {
			type: 'integer',
			description: 'Naive 58^n expectation (prefix bias can make the real figure higher).',
		},
		network: { type: 'string' },
		explorerUrl: { type: 'string', format: 'uri' },
		source: {
			type: 'string',
			enum: ['inventory', 'ground'],
			description:
				"'inventory': served instantly from a pre-ground address in the premium inventory " +
				"(delivered once, then destroyed server-side — never re-served). 'ground': mined " +
				'fresh for this request. Price is the same either way.',
		},
		certificate: {
			type: 'object',
			description:
				'Proof-of-grind certificate (three-pog/v1): a public, signed attestation of the ' +
				'pattern, address, difficulty, rarity, and a freshness nonce — verifiable offline ' +
				'with verifyProofOfGrind() or at /vanity/verify. Contains no secret. The attestation ' +
				'public key is published at /.well-known/three-vanity.json.',
		},
		verifyUrl: { type: 'string', format: 'uri', description: 'Public verifier page for the certificate.' },
		serviceKeyUrl: { type: 'string', format: 'uri', description: 'Published attestation key (.well-known).' },
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

// Parse + validate the requested pattern. Returns { prefix, suffix, ignoreCase,
// combinedLength } or throws an Error with .status/.code for a clean 4xx. A
// request with NO pattern (the Bazaar discovery probe) is allowed through with
// combinedLength 0 so the 402 challenge can still be emitted for indexing.
function parsePattern(req) {
	const q = req.query || {};
	const prefix = typeof q.prefix === 'string' ? q.prefix.trim() : '';
	const suffix = typeof q.suffix === 'string' ? q.suffix.trim() : '';
	const ignoreCase = q.ignoreCase === '1' || q.ignoreCase === 'true';

	const format = typeof q.format === 'string' ? q.format.trim().toLowerCase() : FORMAT_KEYPAIR;
	if (!FORMATS.has(format)) {
		throw Object.assign(new Error(`invalid format '${format}' — use keypair or mnemonic`), {
			status: 400,
			code: 'validation_error',
		});
	}

	let strength = DEFAULT_STRENGTH;
	if (q.strength != null && q.strength !== '') {
		strength = Number(q.strength);
		if (!STRENGTH_WORD_COUNTS[strength]) {
			throw Object.assign(
				new Error(`invalid strength '${q.strength}' — use 128 (12 words) or 256 (24 words)`),
				{ status: 400, code: 'validation_error' },
			);
		}
	}

	for (const [label, pattern] of [
		['prefix', prefix],
		['suffix', suffix],
	]) {
		if (!pattern) continue;
		const v = validatePattern(pattern);
		if (!v.valid) {
			throw Object.assign(new Error(`invalid ${label}: ${v.errors.join('; ')}`), {
				status: 400,
				code: 'validation_error',
			});
		}
	}

	// Keypair patterns get a second, wider ceiling: MAX_SERVER_PATTERN_LENGTH is
	// what the live WASM grinder can reach in the 45s budget; anything up to
	// INVENTORY_MAX_PATTERN_LENGTH is OFFERED but only ever fulfilled from the
	// premium inventory (checked below, before any 402 is quoted — see
	// hasAvailableMatch in the handler). Mnemonic format has no inventory
	// backing, so its ceiling stays the live-grind cap.
	const maxLength =
		format === FORMAT_MNEMONIC ? MAX_MNEMONIC_PATTERN_LENGTH : INVENTORY_MAX_PATTERN_LENGTH;
	const combinedLength = prefix.length + suffix.length;
	if (combinedLength > maxLength) {
		const reason =
			format === FORMAT_MNEMONIC
				? `seed-phrase grinding is ~100× slower; drop format=mnemonic for up to ${MAX_SERVER_PATTERN_LENGTH} chars, ` +
					`or grind longer mnemonic patterns on your own machine`
				: 'grind longer patterns in the browser at /vanity, or check /api/x402/vanity-premium for pre-ground stock';
		throw Object.assign(
			new Error(
				`combined pattern length ${combinedLength} exceeds the ${format} server limit of ` +
					`${maxLength} characters — ${reason}`,
			),
			{ status: 400, code: 'pattern_too_long' },
		);
	}
	// 4–5 chars (keypair only) is the premium, inventory-only band — never
	// ground live. See hasAvailableMatch gate in the handler and the "not in
	// stock" 404 it returns for a pattern inventory doesn't hold.
	const premiumOnly = format !== FORMAT_MNEMONIC && combinedLength > MAX_SERVER_PATTERN_LENGTH;

	// Optional confidential delivery: an X25519 public key the secret is sealed
	// to. Validate the key shape up front so a malformed key is a clean 400
	// before the buyer ever pays. parseX25519Key throws status/code on bad input.
	let sealTo = null;
	if (typeof q.sealTo === 'string' && q.sealTo.trim()) {
		sealTo = q.sealTo.trim();
		parseX25519Key(sealTo, 'sealTo');
	}

	return { prefix, suffix, ignoreCase, combinedLength, format, strength, sealTo, premiumOnly };
}

// Confidential delivery: when the caller supplies an X25519 public key, encrypt
// the secret material to it (ECIES sealed envelope) so the plaintext secret
// never appears in the response body, a proxy log, or the idempotency cache.
// The address + grind metadata stay in the clear; only the secret is sealed.
async function sealSecret(result, sealTo) {
	const bundle =
		result.format === FORMAT_MNEMONIC
			? {
					format: FORMAT_MNEMONIC,
					mnemonic: result.mnemonic,
					wordCount: result.wordCount,
					derivationPath: result.derivationPath,
					secretKeyBase58: result.secretKeyBase58,
					secretKey: result.secretKey,
				}
			: {
					format: FORMAT_KEYPAIR,
					secretKeyBase58: result.secretKeyBase58,
					secretKey: result.secretKey,
				};
	const sealedSecret = await sealToRecipient(JSON.stringify(bundle), sealTo);
	// Strip every plaintext secret field; keep public metadata.
	const { secretKeyBase58, secretKey, mnemonic, ...clear } = result;
	return {
		...clear,
		sealed: true,
		sealedScheme: SEALED_ENVELOPE_SCHEME,
		sealedContentType: 'application/json',
		sealedFields: Object.keys(bundle),
		sealedSecret,
	};
}

const PUBLIC_ORIGIN = env.APP_ORIGIN || 'https://three.ws';

// Attach a public, offline-verifiable proof-of-grind certificate to a grind
// result. The certificate attests the pattern, address, difficulty, rarity,
// freshness nonce, and (when sealed) the delivery envelope — signed by the
// long-lived three.ws attestation key. It contains NO secret, so it is safe in
// the response, the idempotency cache, and at rest. The certificate is also
// registered (first-write-wins) so a buyer/marketplace can later confirm this is
// the single canonical "freshly ground" proof for the address. Registry/signing
// failures must never break delivery — the buyer paid for a key, and the
// certificate is additive — so issuance degrades gracefully on error.
async function attachCertificate(result, pattern) {
	let identity;
	try {
		identity = await getServiceIdentity();
	} catch (err) {
		console.error('[vanity/cert] attestation key unavailable; delivering without certificate', err?.message || err);
		return result;
	}
	const delivery = result.sealed
		? { sealed: true, sealedScheme: result.sealedScheme || SEALED_ENVELOPE_SCHEME, sealedRecipient: result.sealedSecret?.recipient || null }
		: { sealed: false };
	let certificate;
	try {
		const core = buildCertificateCore({
			address: result.address,
			pattern: { prefix: pattern.prefix || null, suffix: pattern.suffix || null, ignoreCase: !!pattern.ignoreCase },
			format: result.format,
			attempts: result.attempts,
			delivery,
			network: 'solana',
			keyId: identity.keyId,
		});
		certificate = signCertificate({ core, signingSeed: identity.seed, keyId: identity.keyId });
	} catch (err) {
		console.error('[vanity/cert] failed to sign certificate; delivering without it', err?.message || err);
		return result;
	}
	try {
		await registerCert(certificate);
	} catch (err) {
		// A registry outage degrades to "offline-verifiable only" — the certificate
		// still verifies cryptographically; only the single-issuance check is skipped.
		console.warn('[vanity/cert] registry unavailable; certificate is offline-verifiable only', err?.message || err);
	}
	return {
		...result,
		certificate,
		verifyUrl: `${PUBLIC_ORIGIN}/vanity/verify`,
		certVerifyUrl: `${PUBLIC_ORIGIN}/vanity/verify?cert=${encodeURIComponent(certificate.certId)}`,
		serviceKeyUrl: `${PUBLIC_ORIGIN}/.well-known/three-vanity.json`,
	};
}

async function grindAndShape({ prefix, suffix, ignoreCase, format, strength, sealTo }) {
	let shaped;
	if (format === FORMAT_MNEMONIC) {
		const result = grindVanityMnemonic({
			prefix,
			suffix,
			ignoreCase,
			strength,
			timeBudgetMs: GRIND_TIME_BUDGET_MS,
		});
		shaped = {
			address: result.publicKey,
			prefix: prefix || null,
			suffix: suffix || null,
			ignoreCase,
			format: FORMAT_MNEMONIC,
			secretKeyBase58: bs58.encode(result.secretKey),
			secretKey: Array.from(result.secretKey),
			mnemonic: result.mnemonic,
			wordCount: result.wordCount,
			derivationPath: result.derivationPath,
			attempts: result.attempts,
			durationMs: Math.round(result.durationMs),
			expectedAttempts: Math.round(expectedMnemonicAttempts(prefix, suffix, ignoreCase)),
			network: 'solana',
			explorerUrl: `https://solscan.io/account/${result.publicKey}`,
			source: 'ground',
		};
	} else {
		const result = grindVanityNode({
			prefix,
			suffix,
			ignoreCase,
			timeBudgetMs: GRIND_TIME_BUDGET_MS,
		});
		shaped = {
			address: result.publicKey,
			prefix: prefix || null,
			suffix: suffix || null,
			ignoreCase,
			format: FORMAT_KEYPAIR,
			secretKeyBase58: bs58.encode(result.secretKey),
			secretKey: Array.from(result.secretKey),
			mnemonic: null,
			wordCount: null,
			derivationPath: null,
			attempts: result.attempts,
			durationMs: Math.round(result.durationMs),
			expectedAttempts: expectedAttemptsFor(prefix, suffix, ignoreCase),
			network: 'solana',
			explorerUrl: `https://solscan.io/account/${result.publicKey}`,
			source: 'ground',
		};
	}

	const delivered = sealTo ? await sealSecret(shaped, sealTo) : shaped;
	return attachCertificate(delivered, { prefix, suffix, ignoreCase });
}

// ── Instant inventory fast path ──────────────────────────────────────────────
// Before grinding, check whether a pre-ground address from
// api/_lib/vanity-inventory-store.js already satisfies the requested
// prefix/suffix pattern. A hit is claimed atomically (reserve → decrypt →,
// after settle, reveal-and-destroy) and delivered exactly once — the same
// sealing/certificate pipeline as a fresh grind, just without the CPU cost or
// the wait. A miss (no match, or ANY failure along the way — DB down,
// decrypt error) returns null and the caller falls straight through to
// grindAndShape() unchanged. Never throws: an inventory outage must degrade
// to "grind as normal", not break the endpoint.
export async function tryInstantFromInventory(pattern, { paymentId, purchaser }) {
	const { prefix, suffix, ignoreCase, format, combinedLength, sealTo } = pattern;
	if (!paymentId || (!prefix && !suffix) || combinedLength === 0) return null;

	// Guardrail: never hand out an inventory item worth more than the flat
	// price this pattern length already charges — see claimMatchingPattern's
	// maxPriceUsd doc for why. Anything pricier stays reserved for the priced
	// premium tier (/api/x402/vanity-premium).
	const maxPriceUsd = priceAtomicsFor(format, combinedLength) / 1_000_000;

	let claim;
	try {
		claim = await claimMatchingPattern({ prefix, suffix, ignoreCase, format, maxPriceUsd, paymentId, purchaser });
	} catch (err) {
		if (!isDbUnavailableError(err)) {
			console.error('[vanity] inventory claim lookup failed; falling back to grind', err?.message || err);
		}
		return null;
	}
	if (!claim.ok) return null;

	const item = claim.item;
	const startedAt = Date.now();
	let bundle;
	try {
		const peek = await peekReservedSecret(item.address, { paymentId });
		if (!peek.ok) throw new Error(peek.reason);
		bundle = JSON.parse(await openSecret(peek.ciphertext, peek.scheme));
	} catch (err) {
		console.error('[vanity] inventory decrypt failed; releasing + falling back to grind', err?.message || err);
		await releaseReservation(item.address, { paymentId }).catch(() => {});
		return null;
	}

	const shaped = {
		address: item.address,
		prefix: prefix || null,
		suffix: suffix || null,
		ignoreCase,
		format: bundle.format || item.format || FORMAT_KEYPAIR,
		secretKeyBase58: bundle.secretKeyBase58,
		secretKey: bundle.secretKey,
		mnemonic: bundle.mnemonic || null,
		wordCount: bundle.wordCount || null,
		derivationPath: bundle.derivationPath || null,
		attempts: item.difficultyAttempts,
		durationMs: Date.now() - startedAt,
		expectedAttempts: item.difficultyAttempts,
		network: 'solana',
		explorerUrl: `https://solscan.io/account/${item.address}`,
		source: 'inventory',
	};

	const delivered = sealTo ? await sealSecret(shaped, sealTo) : shaped;
	const withCert = await attachCertificate(delivered, { prefix, suffix, ignoreCase });
	return { result: withCert, item };
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
	if (!rl.success) return rateLimited(res, rl);

	// Validate the pattern up front so a malformed request is rejected before we
	// ever quote a price. A pattern-free probe is allowed (combinedLength 0).
	let pattern;
	try {
		pattern = parsePattern(req);
	} catch (err) {
		return error(res, err.status || 400, err.code || 'validation_error', err.message);
	}

	// Premium 4–5 char band: only ever fulfilled from inventory, so check stock
	// BEFORE quoting a price — a buyer must never be asked to pay for a pattern
	// that isn't sitting in the warehouse. A DB outage here degrades to "not in
	// stock" (honest, refundable-nothing failure) rather than a false quote.
	if (pattern.premiumOnly) {
		let inStock = false;
		try {
			inStock = await hasAvailableMatch({
				prefix: pattern.prefix,
				suffix: pattern.suffix,
				ignoreCase: pattern.ignoreCase,
				format: pattern.format,
			});
		} catch (err) {
			if (!isDbUnavailableError(err)) console.error('[vanity] premium stock check failed', err?.message || err);
		}
		if (!inStock) {
			return error(
				res,
				404,
				'not_in_stock',
				`pattern not in stock — the live grinder's grindable range is 1–${MAX_SERVER_PATTERN_LENGTH} ` +
					`Base58 chars; ${pattern.combinedLength}-char patterns are served only from the premium ` +
					`inventory when a match exists. Browse current stock at GET /api/x402/vanity-premium` +
					`?prefix=${encodeURIComponent(pattern.prefix || '')}.`,
			);
		}
	}

	const resourceUrl = resolveResourceUrl(req, ROUTE);
	const priceAtomics = priceAtomicsFor(pattern.format, pattern.combinedLength);
	const requirements = buildRequirements(resourceUrl, priceAtomics);
	const service = withService({
		serviceName: 'three.ws Solana Vanity Grinder',
		tags: ['solana', 'vanity', 'keypair', 'wallet', 'address', 'mnemonic', 'seed-phrase', 'bip39'],
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
		return error(
			res,
			acResult.status || 403,
			acResult.code || 'access_denied',
			acResult.reason || 'access denied',
		);
	}
	if (acResult?.grantAccess) {
		let result;
		try {
			result = await grindAndShape(pattern);
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
	const clientPaymentId = extractIdFromHeader(paymentHeader);
	const payloadHash = hashRequestPayload({ method: req.method, url: req.url, body: null });
	const paymentHash = hashPaymentProof(paymentHeader);
	// Always-on replay guard: the payment-identifier extension is client-opt-in,
	// so when the client omits it we fall back to the proof hash itself as the
	// dedup key (reproducible only by the original payer), making replay
	// protection unconditional. Same idiom as api/_lib/x402-paid-endpoint.js.
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

	// Instant path FIRST: a matching pre-ground address in inventory is
	// claimed and decrypted here (still before settle, so a claim/decrypt
	// failure costs the buyer nothing — see tryInstantFromInventory). No
	// match (or any failure) returns null and falls straight through to the
	// live grind, unchanged from before this endpoint knew inventory existed.
	const purchaser = verified?.payer || verified?.from || clientPaymentId || 'x402';
	let result;
	let inventoryClaim = null;
	try {
		const instant = paymentId ? await tryInstantFromInventory(pattern, { paymentId, purchaser }) : null;
		if (instant) {
			result = instant.result;
			inventoryClaim = instant.item;
		} else if (pattern.premiumOnly) {
			// The pre-payment hasAvailableMatch check above found stock, but
			// between the 402 quote and this settle another buyer won the race for
			// the (possibly only) matching item. This band is NEVER ground live
			// (58^4-58^5 attempts is hours, far past the 45s budget) — fail clean
			// instead of falling through to an infeasible grind. Settlement has not
			// run, so the buyer is charged nothing and can retry.
			throw Object.assign(
				new Error('the matching inventory item was claimed by another buyer between quote and payment — retry'),
				{ status: 409, code: 'sold_out' },
			);
		} else {
			// Grind AFTER verify but BEFORE settle: an invalid pattern or exhausted
			// budget throws here, and settlement never runs, so the buyer isn't
			// charged. grindAndShape is async (it may seal the secret to the
			// buyer's key), so it must be awaited — otherwise the body serializes
			// an unresolved Promise.
			result = await grindAndShape(pattern);
		}
	} catch (err) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		return error(res, err.status || 500, err.code || 'grind_failed', err.message);
	}

	let settled;
	try {
		settled = await settlePayment({ verified });
	} catch (err) {
		if (inventoryClaim) {
			// Settlement failed after we reserved (but did not yet reveal/destroy)
			// the inventory item — release it back to available so a transient
			// payment failure never strands sellable stock.
			await releaseReservation(inventoryClaim.address, { paymentId }).catch(() => {});
		}
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		return error(res, err.status || 502, err.code || 'settle_failed', err.message);
	}

	if (inventoryClaim) {
		// One-shot reveal AFTER settle: flips reserved→destroyed and nulls the
		// stored ciphertext atomically, so this address can never be served
		// again. We already hold the plaintext (delivered above), so a hiccup
		// here is logged, not fatal to delivery.
		try {
			await reserveAndReveal(inventoryClaim.address, { paymentId });
		} catch (err) {
			console.error('[vanity] inventory reveal/destroy after settle failed', err?.message || err);
		}
	}

	const paymentResponseHeader = encodePaymentResponseHeader(settled);
	const contentType = 'application/json; charset=utf-8';
	const body = JSON.stringify(result);

	res.setHeader('x-payment-response', paymentResponseHeader);
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', contentType);
	res.end(body);

	if (paymentId) {
		// Never persist spendable key material at rest. The live response above
		// delivers the ground secret once over TLS (this endpoint's stated
		// contract); the x402 replay/idempotency cache must NOT hold it, or a
		// Redis read or compromise would recover spendable keys for the cache TTL.
		// Strip the plaintext secret fields from the STORED copy so a replayed
		// payment receives the public metadata plus an explicit marker, not the
		// key. Sealed responses carry only ciphertext (sealedSecret), which is
		// safe at rest, so they are cached unchanged.
		let storedBody = body;
		if (!result?.sealed) {
			const { secretKeyBase58, secretKey, mnemonic, ...publicMeta } = result;
			void secretKeyBase58; void secretKey; void mnemonic;
			storedBody = JSON.stringify({
				...publicMeta,
				secret_omitted_from_cache: true,
				note: 'The ground secret is returned only once in the original response and is never stored. If you did not capture it, grind again.',
			});
		}
		await storeResponse({
			route: ROUTE,
			paymentId,
			payloadHash,
			paymentHash,
			status: 200,
			body: storedBody,
			contentType,
			paymentResponseHeader,
		});
	}
});
