// /api/vanity/bounties — the x402 grind-bounty market.
//
// A decentralized, secret-blind, pay-for-results market for HARD vanity Solana
// addresses. A requester posts a pattern and escrows an x402 USDC bounty; a fleet
// of independent workers grind in parallel and race to find a matching key. The
// FIRST worker to submit a verified, sealed, pattern-matching claim is paid the
// bounty on-chain — but the found secret is sealed to the requester's X25519 key,
// so the worker earns the bounty yet never sees the wallet. If a bounty expires
// unfilled, its escrow is refunded to the requester.
//
//   GET  ?view=board&status=open|all|settled&sort=recency|reward|expiry  → board
//   GET  ?view=open                       → claimable queue (workers poll this)
//   GET  ?view=stats                      → open count, escrowed, paid out
//   GET  ?view=leaderboard                → top grinders by USDC earned
//   GET  ?view=get&id=<id>                → one bounty (public view)
//   GET  ?view=quote&prefix=&suffix=&ignoreCase=  → honest difficulty→price oracle
//   GET  ?view=config                     → payout availability + asset metadata
//   POST ?action=create  (x402 PAID)      → fund + post a bounty. Escrow held.
//        query: prefix, suffix, ignoreCase, amount(atomics), recipient(X25519),
//               refundAddress(Solana), expiryHours, label
//   POST ?action=claim                    → worker submits { bountyId, address,
//               sealedSecret, workerId, payoutAddress }. Atomic single-winner
//               settle + real on-chain USDC payout. Secret-blind verified server-side.
//   POST ?action=refund                   → trigger expiry refund for an expired,
//               unfilled bounty (atomic, exactly-once). body: { bountyId }.
//   POST ?action=reveal                   → requester fetches the sealed envelope
//               for a settled bounty by proving control of the X25519 key (a
//               signature is not possible over X25519, so this returns the sealed
//               envelope to anyone — it is useless without the private key — and
//               the open happens entirely client-side).
//
// Money + key safety (see vanity-bounty-store.js + vanity-bounty-payout.js):
//   • escrow is funded by a real x402 USDC payment before the bounty goes live;
//   • a worker is paid ONLY after an atomic open→settled compare-and-set marks the
//     bounty for that exact claim — never two workers, never a losing/unverified
//     claim, never plaintext;
//   • payout + refund are exactly-once (recorded tx short-circuits a re-send) and
//     mutually exclusive (settle XOR refund);
//   • the worker path is secret-blind by construction — the only thing it may
//     submit is a sealed envelope addressed to the requester (verified server-side
//     before paying); the operator never holds the plaintext key either.

import { wrap, cors, error, json, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
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
import {
	PAYMENT_IDENTIFIER,
	checkCache,
	extractIdFromHeader,
	hashPaymentProof,
	hashRequestPayload,
	paymentIdentifierExtension,
	storeResponse,
	writeCachedResponse,
	writeConflict,
} from '../_lib/x402/payment-identifier-server.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { parseX25519Key, SEALED_ENVELOPE_SCHEME } from '../../src/solana/vanity/sealed-envelope.js';
import {
	BOUNTY_PROTOCOL_VERSION,
	normalizeBountyPattern,
	validateBountyAtomics,
	suggestBountyAtomics,
	bountyDifficulty,
	deriveBountyId,
	claimDigest,
	verifyClaimEnvelope,
	PRICING,
	USDC,
} from '../../src/solana/vanity/bounty-protocol.js';
import {
	createBounty,
	activateBounty,
	voidBounty,
	getBounty,
	getBountyRecord,
	claimBounty,
	markRefundable,
	queryBounties,
	listClaimable,
	bountyStats,
	topGrinders,
} from '../_lib/vanity-bounty-store.js';
import { payWinner, refundRequester, payoutConfigured } from '../_lib/vanity-bounty-payout.js';
import { randomSeed } from '../../src/solana/vanity/verifiable-grind.js';
import { bytesToHex } from '@noble/hashes/utils';
import bs58 from 'bs58';

const ROUTE = '/api/vanity/bounties';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBLIC_ORIGIN = env.APP_ORIGIN || 'https://three.ws';

// Expiry band: a bounty must live long enough for the fleet to find a hard
// pattern, but not so long that escrow is locked indefinitely.
const MIN_EXPIRY_HOURS = 1;
const MAX_EXPIRY_HOURS = 24 * 30; // 30 days
const DEFAULT_EXPIRY_HOURS = 48;

const READ_CACHE = 'public, max-age=10, s-maxage=30, stale-while-revalidate=120';

// ── x402 escrow challenge ─────────────────────────────────────────────────────

function buildEscrowRequirements(resourceUrl, priceAtomics) {
	const amount = String(priceAtomics);
	const out = [];
	if (env.X402_PAY_TO_BASE && env.X402_ASSET_ADDRESS_BASE) {
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
		out.push(eip3009);
		const permit2 = permit2VariantOf(eip3009);
		if (permit2) out.push(permit2);
	}
	if (env.X402_PAY_TO_SOLANA && env.X402_FEE_PAYER_SOLANA && env.X402_ASSET_MINT_SOLANA) {
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

const ESCROW_DESCRIPTION =
	'three.ws Grind-Bounty Market — escrow a USDC bounty for a HARD Solana vanity ' +
	'address and a fleet of independent workers grinds it in parallel. The first worker ' +
	'to submit a verified key matching your pattern is paid automatically — but the found ' +
	'secret is ECIES-sealed to YOUR X25519 key, so the worker earns the bounty yet never ' +
	'sees the wallet. Unfilled bounties refund on expiry. Pay-per-post in USDC on Base or ' +
	'Solana mainnet. Set prefix/suffix/ignoreCase, amount (USDC atomic units), recipient ' +
	'(your X25519 public key), refundAddress (Solana), expiryHours, and an optional label.';

const ESCROW_INPUT_EXAMPLE = {
	prefix: 'THREE', suffix: '', ignoreCase: '0', amount: '500000',
	recipient: '<Base58 X25519 public key>', refundAddress: '<Base58 Solana address>',
	expiryHours: '48', label: 'My agent wallet',
};

const ESCROW_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['amount', 'recipient'],
	properties: {
		prefix: { type: 'string', description: 'Base58 prefix the address must start with.' },
		suffix: { type: 'string', description: 'Base58 suffix the address must end with.' },
		ignoreCase: { type: 'string', enum: ['0', '1', 'true', 'false'] },
		amount: { type: 'string', description: 'Bounty in USDC atomic units (6 decimals). Min 50000 ($0.05).' },
		recipient: { type: 'string', description: 'Your 32-byte X25519 public key (Base58/Base64url/hex) — the found secret is sealed to it.' },
		refundAddress: { type: 'string', description: 'Solana address refunded if the bounty expires unfilled.' },
		expiryHours: { type: 'string', description: 'Hours until the bounty expires + refunds. 1–720, default 48.' },
		label: { type: 'string', description: 'Optional public label for the board.' },
	},
};

const ESCROW_OUTPUT_EXAMPLE = {
	posted: true,
	bounty: {
		id: 'a1b2c3d4e5f60718293a4b5c',
		protocol: BOUNTY_PROTOCOL_VERSION,
		pattern: { prefix: 'THREE', suffix: null, ignoreCase: false },
		recipient: '<Base58 X25519 public key>',
		amountAtomics: 500000, asset: 'USDC', network: 'solana',
		status: 'open', createdAt: 1750000000000, expiresAt: 1750172800000,
		difficulty: { expectedAttempts: 656356768, tier: 'epic', tierLabel: 'Epic' },
	},
	escrow: { funded: true, txHash: '<settlement tx>', payer: '<payer>' },
	boardUrl: 'https://three.ws/vanity/bounties#a1b2c3d4e5f60718293a4b5c',
};

const ESCROW_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['posted', 'bounty'],
	properties: {
		posted: { type: 'boolean' },
		bounty: { type: 'object' },
		escrow: { type: 'object' },
		boardUrl: { type: 'string', format: 'uri' },
	},
};

const ESCROW_BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', body: ESCROW_INPUT_EXAMPLE, bodyType: 'json' },
		output: { type: 'json', example: ESCROW_OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST', bodyType: 'json', bodySchema: ESCROW_INPUT_SCHEMA, outputSchema: ESCROW_OUTPUT_SCHEMA,
	}),
};

// ── parse + validate a create request from query params ───────────────────────

function parseCreate(url) {
	const p = url.searchParams;
	const pattern = normalizeBountyPattern({
		prefix: p.get('prefix') || '',
		suffix: p.get('suffix') || '',
		ignoreCase: p.get('ignoreCase') === '1' || p.get('ignoreCase') === 'true',
	});

	const amountAtomics = validateBountyAtomics(p.get('amount'));

	const recipient = (p.get('recipient') || '').trim();
	if (!recipient) throw bad('recipient (your X25519 public key) is required so the found secret can be sealed to you', 'validation_error');
	const recipientCanonical = bs58X25519(recipient); // validates shape + canonicalizes to Base58

	const refundAddress = (p.get('refundAddress') || '').trim();
	if (refundAddress && !BASE58_RE.test(refundAddress)) {
		throw bad('refundAddress must be a Base58 Solana address', 'validation_error');
	}

	let expiryHours = Number(p.get('expiryHours'));
	if (!Number.isFinite(expiryHours) || expiryHours <= 0) expiryHours = DEFAULT_EXPIRY_HOURS;
	expiryHours = Math.max(MIN_EXPIRY_HOURS, Math.min(MAX_EXPIRY_HOURS, expiryHours));

	const label = (p.get('label') || '').trim().slice(0, 80) || null;

	return { pattern, amountAtomics, recipient: recipientCanonical, refundAddress: refundAddress || null, expiryHours, label };
}

// Validate + canonicalize an X25519 key to Base58 (parseX25519Key accepts
// Base58/Base64url/hex; we re-encode to Base58 so the stored recipient and the
// claim's envelope.recipient — which sealed-envelope.js also encodes as Base58 —
// compare equal regardless of the input encoding the requester used).
function bs58X25519(key) {
	const bytes = parseX25519Key(key, 'recipient'); // throws a clean 400 on bad shape
	return bs58.encode(bytes);
}

function bad(message, code) {
	return Object.assign(new Error(message), { status: 400, code: code || 'validation_error' });
}

// ── GET handlers ──────────────────────────────────────────────────────────────

async function handleGet(req, res, url) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const view = (url.searchParams.get('view') || 'board').toLowerCase();

	// quote and config are pure computation — no Redis, no try-catch needed.
	if (view === 'quote') {
		const pattern = normalizeBountyPattern({
			prefix: url.searchParams.get('prefix') || '',
			suffix: url.searchParams.get('suffix') || '',
			ignoreCase: url.searchParams.get('ignoreCase') === '1' || url.searchParams.get('ignoreCase') === 'true',
		});
		const oracle = suggestBountyAtomics(pattern);
		return json(res, 200, {
			pattern: { prefix: pattern.prefix || null, suffix: pattern.suffix || null, ignoreCase: pattern.ignoreCase },
			difficulty: bountyDifficulty(pattern),
			oracle,
			band: { floorAtomics: PRICING.floorAtomics, maxAtomics: PRICING.maxAtomics, decimals: 6, asset: 'USDC' },
		}, { 'cache-control': READ_CACHE });
	}

	if (view === 'config') {
		return json(res, 200, {
			payoutConfigured: payoutConfigured(),
			asset: 'USDC',
			decimals: 6,
			networks: escrowNetworks(),
			band: { floorAtomics: PRICING.floorAtomics, maxAtomics: PRICING.maxAtomics },
			protocol: BOUNTY_PROTOCOL_VERSION,
			sealedScheme: SEALED_ENVELOPE_SCHEME,
		}, { 'cache-control': READ_CACHE });
	}

	// All remaining views hit the Redis-backed store. A single try-catch converts
	// an Upstash auth failure (WRONGPASS) into a 503 rather than an unhandled 500.
	try {
		if (view === 'get') {
			const id = (url.searchParams.get('id') || '').trim();
			if (!/^[0-9a-f]{8,32}$/.test(id)) return error(res, 400, 'validation_error', 'id must be a hex bounty id');
			const bounty = await getBounty(id);
			if (!bounty) return error(res, 404, 'not_found', 'no bounty with that id');
			return json(res, 200, { bounty }, { 'cache-control': READ_CACHE });
		}

		if (view === 'open') {
			const limit = Number(url.searchParams.get('limit')) || 30;
			const bounties = await listClaimable(limit);
			return json(res, 200, { bounties, count: bounties.length }, { 'cache-control': 'no-store' });
		}

		if (view === 'stats') {
			const stats = await bountyStats();
			return json(res, 200, stats, { 'cache-control': READ_CACHE });
		}

		if (view === 'leaderboard') {
			const limit = Number(url.searchParams.get('limit')) || 10;
			const grinders = await topGrinders(limit);
			return json(res, 200, { grinders, count: grinders.length }, { 'cache-control': READ_CACHE });
		}

		// Default: paginated board.
		const status = (url.searchParams.get('status') || 'open').toLowerCase();
		const sort = (url.searchParams.get('sort') || 'recency').toLowerCase();
		const limit = Number(url.searchParams.get('limit')) || 24;
		const offset = Number(url.searchParams.get('offset')) || 0;
		const result = await queryBounties({ status, sort, limit, offset });
		return json(res, 200, { ...result, status, sort }, { 'cache-control': READ_CACHE });
	} catch (err) {
		// circuitOpen → the shared Redis auth breaker is fast-failing (it already
		// logged the credential failure once). Otherwise match a raw Upstash auth
		// error. Either way the store is unreachable: return 503, don't 500.
		const isRedisAuth = err?.circuitOpen ||
			(err?.constructor?.name === 'UpstashError' &&
				(err.message?.includes('WRONGPASS') || err.message?.includes('invalid or missing auth token')));
		if (isRedisAuth) {
			if (!err?.circuitOpen) console.warn('[vanity/bounties] redis unavailable:', err.message);
			return error(res, 503, 'store_unavailable', 'the bounty store is temporarily unavailable');
		}
		throw err;
	}
}

function escrowNetworks() {
	const nets = [];
	if (env.X402_PAY_TO_BASE && env.X402_ASSET_ADDRESS_BASE) nets.push('base');
	if (env.X402_PAY_TO_SOLANA && env.X402_FEE_PAYER_SOLANA && env.X402_ASSET_MINT_SOLANA) nets.push('solana');
	return nets;
}

// ── POST: create (x402-escrowed) ──────────────────────────────────────────────

async function handleCreate(req, res, url) {
	let parsed;
	try {
		parsed = parseCreate(url);
	} catch (err) {
		return error(res, err.status || 400, err.code || 'validation_error', err.message);
	}

	// Without a payout wallet the platform can neither pay a winner nor refund —
	// refuse to take escrow it couldn't return. Fail BEFORE the payment challenge.
	if (!payoutConfigured()) {
		return error(res, 503, 'payout_unconfigured', 'the bounty market payout wallet is not configured — posting is temporarily unavailable');
	}

	const resourceUrl = resolveResourceUrl(req, ROUTE);
	const priceAtomics = parsed.amountAtomics;
	const requirements = buildEscrowRequirements(resourceUrl, priceAtomics);
	if (!requirements.length) {
		return error(res, 503, 'escrow_unconfigured', 'no x402 escrow network is configured (X402_PAY_TO_*)');
	}

	const service = withService({
		serviceName: 'three.ws Grind-Bounty Market',
		tags: ['solana', 'vanity', 'bounty', 'escrow', 'sealed', 'x402'],
	});
	const challenge = {
		resourceUrl,
		accepts: requirements,
		description: ESCROW_DESCRIPTION,
		bazaar: ESCROW_BAZAAR,
		extensions: { [PAYMENT_IDENTIFIER]: paymentIdentifierExtension(false) },
		serviceName: service.serviceName,
		tags: service.tags,
		iconUrl: service.iconUrl,
	};

	const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
	if (!paymentHeader) return await send402(res, challenge);

	// Only requests carrying a payment proof reach the facilitator /verify round-trip,
	// so gate exactly here with the shared critical x402-verify limiters (per-IP +
	// global). Without this, one cheap junk-X-PAYMENT request amplifies into one
	// outbound facilitator call at our expense — the same protection paidEndpoint()
	// applies, which this hand-rolled handler would otherwise skip.
	const vIp = await limits.x402VerifyIp(clientIp(req));
	if (!vIp.success) return rateLimited(res, vIp);
	const vGlobal = await limits.x402VerifyGlobal();
	if (!vGlobal.success) return rateLimited(res, vGlobal);

	// Idempotency: a retried POST with the same payment proof returns the same
	// stored bounty rather than escrowing twice.
	const clientPaymentId = extractIdFromHeader(paymentHeader);
	const payloadHash = hashRequestPayload({ method: 'POST', url: req.url, body: null });
	const paymentHash = hashPaymentProof(paymentHeader);
	const paymentId = clientPaymentId || (paymentHash ? `proof:${paymentHash}` : null);
	if (paymentId) {
		const lookup = await checkCache({ route: ROUTE, paymentId, payloadHash, paymentHash });
		if (lookup.kind === 'hit') return writeCachedResponse(res, lookup.entry);
		if (lookup.kind === 'conflict') {
			return writeConflict(res, { route: ROUTE, attemptedHash: lookup.attemptedHash, existingHash: lookup.existingHash, reason: lookup.reason });
		}
	}

	let verified;
	try {
		verified = await verifyPayment({ paymentHeader, requirements });
	} catch (err) {
		if (err.status === 402) return await send402(res, { ...challenge, error: err.message });
		return error(res, err.status || 502, err.code || 'verify_failed', err.message);
	}

	// Build + persist the bounty record AFTER verify but BEFORE settle, so a store
	// failure throws before the requester is charged. It is persisted as
	// `escrow_pending`: recorded and id-reserved, but in no index, invisible to the
	// board and to workers, and refused by both the claim and the refund
	// compare-and-set. Only a settled escrow promotes it (activateBounty). Without
	// that gate a settle failure would leave a live bounty backed by nothing, and
	// the platform would pay its winner — or its expiry refund — out of pocket.
	const nonce = bytesToHex(randomSeed());
	const id = deriveBountyId({ recipient: parsed.recipient, pattern: parsed.pattern, amountAtomics: parsed.amountAtomics, nonce });
	const now = Date.now();
	const record = {
		id,
		protocol: BOUNTY_PROTOCOL_VERSION,
		pattern: { prefix: parsed.pattern.prefix || null, suffix: parsed.pattern.suffix || null, ignoreCase: parsed.pattern.ignoreCase },
		recipient: parsed.recipient,
		refundAddress: parsed.refundAddress,
		amountAtomics: parsed.amountAtomics,
		asset: 'USDC',
		network: verified.requirement?.network === NETWORK_SOLANA_MAINNET ? 'solana' : 'base',
		difficulty: bountyDifficulty(parsed.pattern),
		label: parsed.label,
		nonce,
		createdAt: now,
		expiresAt: now + parsed.expiryHours * 3600_000,
		status: 'escrow_pending',
		// Escrow audit trail — proves the requester funded it. Not exposed publicly.
		escrowPayer: verified.payer || null,
	};

	try {
		await createBounty(record);
	} catch (err) {
		return error(res, err.status || 500, err.code || 'store_failed', err.message);
	}

	// Settle the escrow on-chain. A failure here means we never collected the
	// money, so the pending bounty is voided rather than left behind: an unfunded
	// record must never reach a worker or a refund. The requester is told to retry.
	let settled;
	try {
		settled = await settlePayment({ verified });
	} catch (err) {
		await voidBounty({ id, reason: `escrow settle failed: ${err.message}` }).catch(() => {});
		return error(res, err.status || 502, err.code || 'settle_failed', `${err.message} — no bounty was posted; retry with a fresh payment`);
	}

	// Escrow collected: promote the bounty to live + indexed in one atomic step.
	// If the store is unreachable at exactly this moment the money HAS landed, so
	// we retry once and then hand back the settlement tx: the record stays pending
	// with its escrow proof, recoverable, never silently dropped.
	let activation;
	try {
		activation = await activateBounty({ id, escrowTx: settled.transaction, escrowNetwork: settled.network });
	} catch {
		activation = await activateBounty({ id, escrowTx: settled.transaction, escrowNetwork: settled.network }).catch(() => 'error');
	}
	if (activation !== 'live') {
		return error(res, 502, 'activation_failed', `your escrow settled (tx ${settled.transaction || 'unknown'}) but the bounty could not be published; contact support with bounty id ${id}`, {
			bountyId: id,
			escrowTx: settled.transaction || null,
		});
	}

	const paymentResponseHeader = encodePaymentResponseHeader(settled);
	const body = JSON.stringify({
		posted: true,
		bounty: await getBounty(id),
		escrow: { funded: true, txHash: settled.transaction || null, payer: settled.payer || verified.payer || null, network: settled.network || null },
		boardUrl: `${PUBLIC_ORIGIN}/vanity/bounties#${id}`,
		notice: 'Save your X25519 PRIVATE key — it is the ONLY way to open the sealed wallet when a worker finds it. three.ws never sees it.',
	});
	const contentType = 'application/json; charset=utf-8';

	res.setHeader('x-payment-response', paymentResponseHeader);
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', contentType);
	res.statusCode = 201;
	res.end(body);

	if (paymentId) {
		await storeResponse({ route: ROUTE, paymentId, payloadHash, paymentHash, status: 201, body, contentType, paymentResponseHeader });
	}
}

// ── POST: claim (worker submits a sealed key; atomic settle + payout) ─────────

async function handleClaim(req, res) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'validation_error', err.message || 'invalid JSON body');
	}

	const bountyId = String(body?.bountyId || '').trim();
	const address = String(body?.address || '').trim();
	const sealedSecret = body?.sealedSecret;
	const workerId = sanitizeWorkerId(body?.workerId);
	const payoutAddress = String(body?.payoutAddress || '').trim();

	if (!/^[0-9a-f]{8,32}$/.test(bountyId)) return error(res, 400, 'validation_error', 'bountyId must be a hex bounty id');
	if (!BASE58_RE.test(payoutAddress)) return error(res, 400, 'validation_error', 'payoutAddress must be a Base58 Solana address to receive the bounty');

	const record = await getBountyRecord(bountyId);
	if (!record) return error(res, 404, 'not_found', 'no bounty with that id');

	// Reject fast on a closed/expired bounty before doing crypto work.
	if (record.status !== 'open') {
		return json(res, 409, { claimed: false, status: record.status, reason: `bounty is ${record.status} — too late`, winnerAddress: record.winnerAddress || null });
	}
	if (record.expiresAt && Date.now() > record.expiresAt) {
		return json(res, 409, { claimed: false, status: 'expired', reason: 'bounty expired before this claim' });
	}

	// Secret-blind anti-cheat: verify the address matches the pattern AND the
	// sealed envelope is addressed to the requester — WITHOUT ever decrypting it.
	const verification = verifyClaimEnvelope(record, { address, sealedSecret });
	if (!verification.ok) {
		const failed = verification.checks.filter((c) => !c.pass).map((c) => c.id);
		return error(res, 422, 'claim_rejected', `claim failed verification (${failed.join(', ')}): ${verification.reason}`, { checks: verification.checks });
	}

	// Atomic single-winner settle. First valid claim wins; later ones lose.
	const digest = claimDigest({ bountyId, address, sealedSecret });
	let outcome;
	try {
		outcome = await claimBounty({ id: bountyId, claimDigest: digest, winnerAddress: address, workerId, sealedSecret });
	} catch (err) {
		return error(res, err.status || 500, err.code || 'claim_failed', err.message);
	}

	if (outcome === 'missing') return error(res, 404, 'not_found', 'bounty disappeared during claim');
	if (outcome === 'closed') {
		return json(res, 409, { claimed: false, status: 'closed', reason: 'bounty closed/expired during claim' });
	}
	if (outcome === 'lost') {
		const fresh = await getBounty(bountyId);
		return json(res, 409, { claimed: false, status: 'settled', reason: 'another worker submitted a valid key first', winnerAddress: fresh?.winnerAddress || null });
	}

	// outcome === 'won' (or an idempotent re-submit of the same winning claim).
	// Pay the worker on-chain. Payout is idempotent: a retried winning claim that
	// already has a payoutTx returns it without re-sending.
	let payout;
	try {
		payout = await payWinner({ id: bountyId, toAddress: payoutAddress });
	} catch (err) {
		// The bounty is settled to this worker, but payout failed (RPC hiccup,
		// unfunded wallet). The worker can re-submit the SAME claim to retry payout
		// without re-racing — the atomic claim already locked them in as the winner.
		return json(res, 502, {
			claimed: true,
			paid: false,
			status: 'settled',
			reason: `you won the bounty, but the on-chain payout failed: ${err.message}. Re-submit this exact claim to retry the payout.`,
			retryable: true,
		});
	}

	const fresh = await getBounty(bountyId);
	return json(res, 200, {
		claimed: true,
		paid: true,
		status: 'settled',
		bountyId,
		address,
		amountAtomics: payout.amountAtomics,
		amountUsdc: (payout.amountAtomics / USDC).toFixed(6),
		payoutTx: payout.payoutTx,
		alreadyPaid: payout.alreadyPaid,
		explorerUrl: `https://solscan.io/tx/${payout.payoutTx}`,
		bounty: fresh,
		notice: 'You earned the bounty without ever seeing the wallet secret — it is sealed to the requester. The requester opens it with their X25519 private key.',
	});
}

// ── POST: refund (expiry refund for an unfilled bounty) ───────────────────────

async function handleRefund(req, res) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'validation_error', err.message || 'invalid JSON body');
	}
	const bountyId = String(body?.bountyId || '').trim();
	if (!/^[0-9a-f]{8,32}$/.test(bountyId)) return error(res, 400, 'validation_error', 'bountyId must be a hex bounty id');

	const record = await getBountyRecord(bountyId);
	if (!record) return error(res, 404, 'not_found', 'no bounty with that id');

	// Atomic open→refunded compare-and-set, only for EXPIRED bounties. Mutually
	// exclusive with settlement — a settled bounty can never be refunded.
	const eligibility = await markRefundable(bountyId);
	if (eligibility === 'missing') return error(res, 404, 'not_found', 'bounty disappeared');
	if (eligibility === 'ineligible') {
		const fresh = await getBounty(bountyId);
		const why = fresh?.status === 'settled' ? 'bounty was already won — no refund' : 'bounty has not expired yet';
		return json(res, 409, { refunded: false, status: fresh?.status, reason: why });
	}

	// Refund destination is BOUND to the address recorded when the bounty was
	// funded — never a value supplied in this request. Refund is unauthenticated
	// (it needs only an expired bounty id, and expired ids are listed on the public
	// board), so honoring a body-supplied `refundAddress` would let anyone redirect
	// every expired escrow to their own wallet. A bounty funded without a refund
	// address can only be recovered out-of-band by the operator, never to a stranger.
	const refundTo = record.refundAddress;
	if (!refundTo || !BASE58_RE.test(refundTo)) {
		return error(res, 409, 'no_refund_address', 'this bounty was funded without a refund address; a self-service refund requires one set when posting');
	}

	let refund;
	try {
		refund = await refundRequester({ id: bountyId, toAddress: refundTo });
	} catch (err) {
		return json(res, 502, { refunded: false, status: 'refunded', reason: `refund payout failed: ${err.message}. Retry to complete the refund.`, retryable: true });
	}

	return json(res, 200, {
		refunded: true,
		bountyId,
		amountAtomics: refund.amountAtomics,
		amountUsdc: (refund.amountAtomics / USDC).toFixed(6),
		refundTx: refund.refundTx,
		alreadyRefunded: refund.alreadyRefunded,
		explorerUrl: `https://solscan.io/tx/${refund.refundTx}`,
		refundAddress: refundTo,
	});
}

// ── POST: reveal (requester fetches the sealed envelope of a settled bounty) ──

async function handleReveal(req, res) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'validation_error', err.message || 'invalid JSON body');
	}
	const bountyId = String(body?.bountyId || '').trim();
	if (!/^[0-9a-f]{8,32}$/.test(bountyId)) return error(res, 400, 'validation_error', 'bountyId must be a hex bounty id');

	const record = await getBountyRecord(bountyId);
	if (!record) return error(res, 404, 'not_found', 'no bounty with that id');
	if (record.status !== 'settled' || !record.sealedSecret) {
		return json(res, 409, { revealed: false, status: record.status, reason: 'bounty is not settled yet — no sealed wallet to reveal' });
	}

	// The sealed envelope is useless without the requester's X25519 PRIVATE key —
	// it is ECIES ciphertext addressed to `record.recipient`. Returning it to any
	// caller leaks nothing: only the private-key holder can open it. The open
	// happens entirely client-side (openSealed), so the operator never sees the key.
	return json(res, 200, {
		revealed: true,
		bountyId,
		address: record.winnerAddress,
		recipient: record.recipient,
		sealedSecret: record.sealedSecret,
		sealedScheme: SEALED_ENVELOPE_SCHEME,
		settledAt: record.settledAt,
		explorerUrl: `https://solscan.io/account/${record.winnerAddress}`,
		notice: 'Open this envelope client-side with your X25519 private key (openSealed). three.ws cannot — it never held your private key.',
	});
}

function sanitizeWorkerId(raw) {
	const s = String(raw || '').trim();
	if (!s) return 'anon';
	// Keep it short + safe for a Redis member + leaderboard label.
	return s.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48) || 'anon';
}

// ── dispatch ──────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	const url = new URL(req.url, `http://${req.headers.host || 'three.ws'}`);

	if (req.method === 'GET') return handleGet(req, res, url);

	if (req.method === 'POST') {
		const action = (url.searchParams.get('action') || 'create').toLowerCase();
		if (action === 'create') return handleCreate(req, res, url);
		if (action === 'claim') return handleClaim(req, res);
		if (action === 'refund') return handleRefund(req, res);
		if (action === 'reveal') return handleReveal(req, res);
		return error(res, 400, 'unknown_action', 'action must be create, claim, refund, or reveal');
	}

	res.setHeader('allow', 'GET, POST, OPTIONS');
	return error(res, 405, 'method_not_allowed', 'use GET or POST');
});
