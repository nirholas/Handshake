// /api/vanity/drops — sealed wallet drops (end-to-end-encrypted crypto gifting).
//
// A "drop" is a pre-funded Solana wallet handed to a recipient as an E2E-encrypted
// gift, claimable by link / QR / 3D agent. The wallet secret is ECIES-sealed so
// neither the operator, the database, a log, nor anyone but the holder of the
// matching X25519 key can open it. Funding is real on-chain (SOL / USDC / $THREE).
// The create step is x402-paid. Claims are exactly-once; expired unclaimed drops
// are reclaimed by the sender on-chain.
//
//   GET  ?view=config                  → assets, networks, funding availability, limits
//   GET  ?view=get&id=<id>             → one drop (public view; no secret, no envelope)
//   GET  ?view=stats                   → funded / claimed / reclaimed counts
//   GET  ?view=mine&senderTag=<tag>    → a sender's drops (to reclaim)
//   GET  ?view=balance&id=<id>         → live on-chain balance of the drop address
//
//   POST ?action=create  (x402 PAID)   → grind (optional vanity) + seal + fund + persist.
//        body: { asset, amount, sealMode:'direct'|'claim-time', recipientPubKey?,
//                claimTokenHash? (claim-time), prefix?, suffix?, ignoreCase?,
//                format?, expiryHours, message?, theme?, senderLabel?, reclaimAddress?,
//                senderTag?, irlPinId?, roomId? }
//   POST ?action=claim                 → present the one-time claim token, atomically
//        claim, and receive the SEALED envelope to open client-side.
//        body: { id, claimToken (claim-time mode), claimRecipientPubKey? }
//   POST ?action=reveal                → direct-seal mode: fetch the sealed envelope
//        (useless without the recipient's private key) for client-side open.
//        body: { id }
//   POST ?action=reclaim               → sender sweeps an EXPIRED, unclaimed drop's
//        funds back on-chain (atomic, exactly-once). body: { id } — funds always
//        return to the reclaimAddress recorded at create time (never a body value).
//
// Money + key safety (see sealed-drop-store.js + sealed-drop-funding.js +
// src/solana/vanity/drop-protocol.js):
//   • The plaintext drop secret NEVER appears in a response, a log, or an
//     unsealed store field. It is sealed (ECIES) for delivery and held only as an
//     AES-256-GCM ciphertext at rest for the reclaim-sweep path.
//   • Funding is confirmed on-chain BEFORE the drop is persisted as claimable.
//   • A drop is claimed EXACTLY ONCE (atomic CAS, idempotent on the claim token)
//     OR reclaimed by the sender after expiry — never both.
//   • $THREE is the only coin featured as *a coin*; SOL/USDC are runtime rails.

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
import {
	sealToRecipient,
	parseX25519Key,
	SEALED_ENVELOPE_SCHEME,
} from '../../src/solana/vanity/sealed-envelope.js';
import {
	grindVanityNode,
	validatePattern,
	MAX_SERVER_PATTERN_LENGTH,
} from '../../src/solana/vanity/grinder-node.js';
import { grindVanityMnemonic, MAX_MNEMONIC_PATTERN_LENGTH } from '../../src/solana/vanity/mnemonic-grinder.js';
import { STRENGTH_WORD_COUNTS, DEFAULT_STRENGTH } from '../../src/solana/vanity/mnemonic.js';
import {
	DROP_PROTOCOL_VERSION,
	deriveDropId,
	hashClaimToken,
	timingSafeHexEqual,
	isValidDropId,
	normalizeAsset,
	SEAL_MODES,
} from '../../src/solana/vanity/drop-protocol.js';
import {
	createDrop,
	activateDrop,
	voidDrop,
	getDrop,
	getDropRecord,
	claimDrop,
	markReclaimable,
	recordClaimDelivery,
	listBySender,
	dropStats,
	isTransientDrop,
} from '../_lib/sealed-drop-store.js';
import {
	fundingConfigured,
	fundingWalletAddress,
	fundDropAddress,
	readDropBalance,
	sweepReclaim,
	amountToAtomics,
	atomicsToAmount,
} from '../_lib/sealed-drop-funding.js';
import { encryptSecret, decryptSecret } from '../_lib/secret-box.js';
import { randomBytes as nobleRandomBytes, bytesToHex } from '@noble/hashes/utils';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

const ROUTE = '/api/vanity/drops';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBLIC_ORIGIN = env.APP_ORIGIN || 'https://three.ws';

const MIN_EXPIRY_HOURS = 1;
const MAX_EXPIRY_HOURS = 24 * 90; // 90 days
const DEFAULT_EXPIRY_HOURS = 24 * 7; // a week
const READ_CACHE = 'public, max-age=10, s-maxage=30, stale-while-revalidate=120';

// Curate the themes the share card + claim page render. Coin-agnostic visuals.
const THEMES = new Set(['default', 'birthday', 'congrats', 'thanks', 'welcome', 'tip']);

// Flat x402 create FEE (USDC atomics, 6dp). This is the platform charge for the
// create operation — independent of the funding amount, which the platform moves
// from its own funding wallet (a gift the creator arranges out-of-band or via the
// funding wallet top-up). Vanity grinding adds nothing extra at ≤3 chars.
const CREATE_FEE_ATOMICS = 50_000; // $0.05

// ── x402 challenge ────────────────────────────────────────────────────────────

function buildRequirements(resourceUrl, priceAtomics) {
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

const CREATE_DESCRIPTION =
	'three.ws Sealed Wallet Drops — mint a pre-funded Solana wallet and deliver it as an ' +
	'end-to-end-encrypted gift, claimable by link / QR / 3D agent. The wallet secret is ' +
	'ECIES-sealed (x25519-hkdf-sha256-aes256gcm) so neither three.ws, our database, nor ' +
	'anyone but the recipient can open it. Fund it with SOL, USDC, or $THREE (real on-chain ' +
	'transfer, confirmed before the drop goes live). Optional vanity prefix/suffix. Two seal ' +
	'modes: direct (seal to a known X25519 recipient key) or claim-time (a bearer link whose ' +
	'fragment carries the claim key the server never sees). Exactly-once claim; expired drops ' +
	'reclaim to the sender. Pay the flat create fee in USDC on Base or Solana mainnet.';

const CREATE_INPUT_EXAMPLE = {
	asset: 'SOL', amount: '0.01', sealMode: 'claim-time',
	prefix: 'gift', expiryHours: '168', message: 'Happy birthday!', theme: 'birthday',
	senderLabel: 'Alex', reclaimAddress: '<Base58 Solana address>',
};

const CREATE_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['asset', 'amount', 'sealMode'],
	properties: {
		asset: { type: 'string', enum: ['SOL', 'USDC', 'THREE'], description: 'Funding asset. $THREE is the platform coin; SOL/USDC are rails.' },
		amount: { type: 'string', description: 'Funding amount as a decimal (e.g. "0.01"). Moved on-chain into the drop wallet.' },
		sealMode: { type: 'string', enum: ['direct', 'claim-time'], description: 'direct = seal to recipientPubKey now; claim-time = bearer link, the server mints a claim key and returns its secret once (you embed it in the link fragment).' },
		recipientPubKey: { type: 'string', description: 'direct mode: the recipient X25519 public key the secret is sealed to.' },
		prefix: { type: 'string', description: 'Optional Base58 vanity prefix (≤3 chars combined).' },
		suffix: { type: 'string', description: 'Optional Base58 vanity suffix (≤3 chars combined).' },
		ignoreCase: { type: 'string', enum: ['0', '1', 'true', 'false'] },
		format: { type: 'string', enum: ['keypair', 'mnemonic'], description: 'mnemonic delivers an importable seed phrase (≤2 vanity chars).' },
		expiryHours: { type: 'string', description: 'Hours until the drop expires + becomes reclaimable. 1–2160, default 168.' },
		message: { type: 'string', description: 'Optional gift message (≤280 chars).' },
		theme: { type: 'string', description: 'Optional card theme: default|birthday|congrats|thanks|welcome|tip.' },
		senderLabel: { type: 'string', description: 'Optional public "from" label (≤40 chars).' },
		reclaimAddress: { type: 'string', description: 'Solana address the funds reclaim to if the drop expires unclaimed.' },
		senderTag: { type: 'string', description: 'Optional opaque tag to list your drops later (non-PII).' },
		irlPinId: { type: 'string', description: 'Optional IRL pin id this drop is attached to (3D-agent handoff).' },
		roomId: { type: 'string', description: 'Optional room id a 3D agent hands the drop out in.' },
	},
};

const CREATE_OUTPUT_EXAMPLE = {
	created: true,
	drop: {
		id: 'a1b2c3d4e5f607182930a1b2',
		address: 'giftEXAMPLE1111111111111111111111111111111',
		asset: 'SOL', amount: '0.01', sealMode: 'claim-time', status: 'funded',
		expiresAt: 1750172800000, theme: 'birthday',
	},
	funding: { confirmed: true, tx: '<funding tx>', explorerUrl: 'https://solscan.io/tx/...' },
	claimUrl: 'https://three.ws/drop/a1b2c3d4e5f607182930a1b2',
	qrUrl: 'https://three.ws/api/vanity/drops?view=qr&id=a1b2c3d4e5f607182930a1b2',
	ogUrl: 'https://three.ws/api/og/sealed-drop?id=a1b2c3d4e5f607182930a1b2',
};

const CREATE_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['created', 'drop'],
	properties: {
		created: { type: 'boolean' },
		drop: { type: 'object' },
		funding: { type: 'object' },
		claimUrl: { type: 'string', format: 'uri' },
		qrUrl: { type: 'string', format: 'uri' },
		ogUrl: { type: 'string', format: 'uri' },
	},
};

const CREATE_BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', body: CREATE_INPUT_EXAMPLE, bodyType: 'json' },
		output: { type: 'json', example: CREATE_OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST', bodyType: 'json', bodySchema: CREATE_INPUT_SCHEMA, outputSchema: CREATE_OUTPUT_SCHEMA,
	}),
};

function bad(message, code) {
	return Object.assign(new Error(message), { status: 400, code: code || 'validation_error' });
}

function activeNetworks() {
	const nets = [];
	if (env.X402_PAY_TO_BASE && env.X402_ASSET_ADDRESS_BASE) nets.push('base');
	if (env.X402_PAY_TO_SOLANA && env.X402_FEE_PAYER_SOLANA && env.X402_ASSET_MINT_SOLANA) nets.push('solana');
	return nets;
}

// ── parse + validate a create request body ────────────────────────────────────

function parseCreate(body) {
	const asset = normalizeAsset(body?.asset);
	const amount = String(body?.amount ?? '').trim();
	if (!amount) throw bad('amount is required (decimal, e.g. "0.01")');
	const atomics = amountToAtomics(amount, asset); // validates shape/decimals

	const sealMode = String(body?.sealMode || '').trim();
	if (!SEAL_MODES.includes(sealMode)) {
		throw bad(`sealMode must be one of ${SEAL_MODES.join(', ')}`, 'invalid_seal_mode');
	}

	// In direct mode the sender supplies the recipient's X25519 public key. In
	// claim-time mode the server mints the claim key itself (returned once in the
	// response, embedded by the creator in the link fragment) — no client input.
	let recipientPubKey = null;
	if (sealMode === 'direct') {
		recipientPubKey = String(body?.recipientPubKey || '').trim();
		if (!recipientPubKey) throw bad('direct seal mode requires recipientPubKey (X25519 public key)', 'recipient_required');
		recipientPubKey = bs58.encode(parseX25519Key(recipientPubKey, 'recipientPubKey')); // validate + canonicalize
	}

	// Optional vanity pattern.
	const prefix = typeof body?.prefix === 'string' ? body.prefix.trim() : '';
	const suffix = typeof body?.suffix === 'string' ? body.suffix.trim() : '';
	const ignoreCase = body?.ignoreCase === '1' || body?.ignoreCase === 'true' || body?.ignoreCase === true;
	const format = String(body?.format || 'keypair').toLowerCase();
	if (format !== 'keypair' && format !== 'mnemonic') throw bad('format must be keypair or mnemonic', 'invalid_format');
	let strength = DEFAULT_STRENGTH;
	if (body?.strength != null && body?.strength !== '') {
		strength = Number(body.strength);
		if (!STRENGTH_WORD_COUNTS[strength]) throw bad('strength must be 128 or 256', 'invalid_strength');
	}
	for (const [label, pat] of [['prefix', prefix], ['suffix', suffix]]) {
		if (!pat) continue;
		const v = validatePattern(pat);
		if (!v.valid) throw bad(`invalid ${label}: ${v.errors.join('; ')}`);
	}
	const maxLen = format === 'mnemonic' ? MAX_MNEMONIC_PATTERN_LENGTH : MAX_SERVER_PATTERN_LENGTH;
	if (prefix.length + suffix.length > maxLen) {
		throw Object.assign(new Error(`combined vanity pattern exceeds the ${format} server limit of ${maxLen} chars`), { status: 400, code: 'pattern_too_long' });
	}

	let expiryHours = Number(body?.expiryHours);
	if (!Number.isFinite(expiryHours) || expiryHours <= 0) expiryHours = DEFAULT_EXPIRY_HOURS;
	expiryHours = Math.max(MIN_EXPIRY_HOURS, Math.min(MAX_EXPIRY_HOURS, expiryHours));

	const message = String(body?.message || '').trim().slice(0, 280) || null;
	const theme = THEMES.has(String(body?.theme || '').trim()) ? String(body.theme).trim() : 'default';
	const senderLabel = String(body?.senderLabel || '').trim().slice(0, 40) || null;

	const reclaimAddress = String(body?.reclaimAddress || '').trim();
	if (reclaimAddress && !BASE58_RE.test(reclaimAddress)) throw bad('reclaimAddress must be a Base58 Solana address');

	const senderTag = sanitizeTag(body?.senderTag);
	const irlPinId = String(body?.irlPinId || '').trim().slice(0, 64) || null;
	const roomId = String(body?.roomId || '').trim().slice(0, 64) || null;

	return {
		asset, amount, atomics, sealMode, recipientPubKey,
		prefix, suffix, ignoreCase, format, strength,
		expiryHours, message, theme, senderLabel, reclaimAddress: reclaimAddress || null,
		senderTag, irlPinId, roomId,
	};
}

// Every public path reads drops through here. A pending or voided record is a
// create that never completed (its fee never settled), so it is not a drop at
// all: it answers 404 exactly like an id that was never minted, and its sealed
// envelope stays unreachable.
async function getLiveDropRecord(id) {
	const record = await getDropRecord(id);
	return isTransientDrop(record) ? null : record;
}

function sanitizeTag(raw) {
	const s = String(raw || '').trim();
	if (!s) return null;
	return s.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64) || null;
}

// Grind (or generate) the drop wallet. Returns { address, secretBundle, vanity }.
// secretBundle is the JSON that gets BOTH sealed (for delivery) and encrypted at
// rest (for reclaim). The plaintext never leaves this function.
function generateDropWallet({ prefix, suffix, ignoreCase, format, strength }) {
	const wantsVanity = prefix || suffix;
	if (format === 'mnemonic') {
		const r = grindVanityMnemonic({ prefix, suffix, ignoreCase, strength, timeBudgetMs: 45_000 });
		return {
			address: r.publicKey,
			vanity: wantsVanity ? { prefix: prefix || null, suffix: suffix || null, ignoreCase } : null,
			secretBundle: {
				format: 'mnemonic',
				mnemonic: r.mnemonic,
				wordCount: r.wordCount,
				derivationPath: r.derivationPath,
				secretKeyBase58: bs58.encode(r.secretKey),
				secretKey: Array.from(r.secretKey),
			},
			secretKeyBytes: r.secretKey,
		};
	}
	if (wantsVanity) {
		const r = grindVanityNode({ prefix, suffix, ignoreCase, timeBudgetMs: 45_000 });
		return {
			address: r.publicKey,
			vanity: { prefix: prefix || null, suffix: suffix || null, ignoreCase },
			secretBundle: { format: 'keypair', secretKeyBase58: bs58.encode(r.secretKey), secretKey: Array.from(r.secretKey) },
			secretKeyBytes: r.secretKey,
		};
	}
	// No vanity pattern → a plain fresh keypair (free of grind time).
	const kp = Keypair.generate();
	return {
		address: kp.publicKey.toBase58(),
		vanity: null,
		secretBundle: { format: 'keypair', secretKeyBase58: bs58.encode(kp.secretKey), secretKey: Array.from(kp.secretKey) },
		secretKeyBytes: kp.secretKey,
	};
}

// Undo a create whose fee failed to settle after the drop wallet was already
// funded on-chain: sweep the funds back to the wallet that sent them, then void
// the record so it can never be claimed, revealed, or swept as a live drop.
// Returns a sentence to append to the caller's error, so the requester learns
// what happened to the money either way. Never throws: the void is what makes the
// drop unclaimable, and it must happen even when the sweep does not.
async function rollbackFunding({ record, secretKey, reason }) {
	const back = fundingWalletAddress();
	let note = '';
	if (back) {
		try {
			await sweepReclaim({ record: { ...record, status: 'reclaimed' }, dropSecretKey: secretKey, toAddress: back });
			note = ' and its funding was returned';
		} catch (sweepErr) {
			console.error('[vanity/drops] rollback sweep failed', record.id, sweepErr?.message || sweepErr);
			note = ` (funding sweep failed: ${sweepErr?.message || 'unknown error'}; drop ${record.id} is voided and its funds are recoverable by the operator)`;
		}
	}
	await voidDrop({ id: record.id, reason }).catch(() => {});
	return note;
}

// ── POST: create (x402-paid → grind → seal → fund → persist) ─────────────────

async function handleCreate(req, res, url) {
	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'validation_error', err.message || 'invalid JSON body');
	}

	let parsed;
	try {
		parsed = parseCreate(body);
	} catch (err) {
		return error(res, err.status || 400, err.code || 'validation_error', err.message);
	}

	// Without a funding wallet the platform can't fund or reclaim — refuse before
	// charging the create fee.
	if (!fundingConfigured()) {
		return error(res, 503, 'funding_unconfigured', 'the drop funding wallet is not configured — drops are temporarily unavailable');
	}

	const resourceUrl = resolveResourceUrl(req, ROUTE);
	const requirements = buildRequirements(resourceUrl, CREATE_FEE_ATOMICS);
	if (!requirements.length) {
		return error(res, 503, 'payment_unconfigured', 'no x402 network is configured (X402_PAY_TO_*)');
	}

	const service = withService({
		serviceName: 'three.ws Sealed Wallet Drops',
		tags: ['solana', 'vanity', 'gift', 'sealed', 'e2e', 'x402', 'drop'],
	});
	const challenge = {
		resourceUrl,
		accepts: requirements,
		description: CREATE_DESCRIPTION,
		bazaar: CREATE_BAZAAR,
		extensions: { [PAYMENT_IDENTIFIER]: paymentIdentifierExtension(false) },
		serviceName: service.serviceName,
		tags: service.tags,
		iconUrl: service.iconUrl,
	};

	const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
	if (!paymentHeader) return await send402(res, challenge);

	// Only requests carrying a payment proof reach the facilitator /verify round-trip,
	// so gate exactly here with the shared critical x402-verify limiters (per-IP +
	// global) — the same amplification protection paidEndpoint() applies, which this
	// hand-rolled handler would otherwise skip.
	const vIp = await limits.x402VerifyIp(clientIp(req));
	if (!vIp.success) return rateLimited(res, vIp);
	const vGlobal = await limits.x402VerifyGlobal();
	if (!vGlobal.success) return rateLimited(res, vGlobal);

	// Idempotency: a retried create with the same payment proof returns the same
	// stored drop instead of grinding + funding twice.
	const clientPaymentId = extractIdFromHeader(paymentHeader);
	const payloadHash = hashRequestPayload({ method: 'POST', url: req.url, body: JSON.stringify(body) });
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

	// Grind + seal + fund AFTER verify but BEFORE settle, so any failure (bad
	// pattern, RPC outage, insufficient funding balance) aborts with the fee
	// unsettled — the buyer is never charged for a drop that didn't get funded.
	let wallet;
	try {
		wallet = generateDropWallet(parsed);
	} catch (err) {
		return error(res, err.status || 500, err.code || 'grind_failed', err.message);
	}

	// Seal the secret bundle for delivery (operator-blind).
	//   • direct mode: seal to the recipient's known X25519 public key.
	//   • claim-time mode: generate a throwaway claim keypair, seal to its PUBLIC
	//     key, hand the SECRET back to the creator exactly once (it goes into the
	//     link fragment #k=…, never stored). The server then derives + stores only
	//     the one-way claimTokenHash from that secret and discards the secret, so
	//     it can verify a claimant's possession without being able to open the
	//     wallet. (A client-sent claimTokenHash is ignored in this mode — the
	//     claim key is server-generated, so the canonical hash is the server's.)
	let sealRecipientPub;
	let claimSecretForSender = null; // returned ONCE to the creator in claim-time mode
	if (parsed.sealMode === 'direct') {
		sealRecipientPub = parsed.recipientPubKey;
	} else {
		const claimSecret = nobleRandomBytes(32);
		const { x25519 } = await import('@noble/curves/ed25519.js');
		sealRecipientPub = bs58.encode(x25519.getPublicKey(claimSecret));
		claimSecretForSender = bs58.encode(claimSecret);
		parsed._claimSecretBytes = claimSecret;
	}

	let sealedSecret;
	try {
		sealedSecret = await sealToRecipient(JSON.stringify(wallet.secretBundle), sealRecipientPub);
	} catch (err) {
		return error(res, err.status || 500, err.code || 'seal_failed', err.message);
	}

	// Encrypt the SAME plaintext at rest ONLY for the reclaim-sweep path (so the
	// platform can refund an expired, unclaimed drop). This never weakens the
	// recipient's E2E guarantee — the claim path always delivers the sealed
	// envelope the recipient opens with their own key.
	let encryptedAtRest;
	try {
		encryptedAtRest = await encryptSecret(JSON.stringify(wallet.secretBundle));
	} catch (err) {
		return error(res, err.status || 500, err.code || 'encrypt_failed', err.message);
	}

	// Derive the drop id + (claim-time) the canonical claim token hash.
	const nonce = bytesToHex(nobleRandomBytes(16));
	const id = deriveDropId({ address: wallet.address, nonce, sealMode: parsed.sealMode });
	let storedClaimTokenHash = null;
	if (parsed.sealMode === 'claim-time') {
		const { deriveClaimToken } = await import('../../src/solana/vanity/drop-protocol.js');
		const claimToken = deriveClaimToken(id, parsed._claimSecretBytes);
		storedClaimTokenHash = hashClaimToken(claimToken);
		// Wipe the claim secret from our memory now that the hash + sealed envelope
		// exist; only the creator (in the response) retains it.
		parsed._claimSecretBytes.fill(0);
	}

	// Fund the drop wallet on-chain. Confirmed before we persist a claimable record.
	let funding;
	try {
		funding = await fundDropAddress({ toAddress: wallet.address, asset: parsed.asset, atomics: parsed.atomics });
	} catch (err) {
		return error(res, err.status || 502, err.code || 'funding_failed', `on-chain funding failed: ${err.message}`);
	}

	const now = Date.now();
	const record = {
		id,
		protocol: DROP_PROTOCOL_VERSION,
		address: wallet.address,
		vanity: wallet.vanity,
		asset: parsed.asset,
		amount: parsed.amount,
		amountAtomics: parsed.atomics.toString(),
		network: 'solana',
		sealMode: parsed.sealMode,
		recipient: parsed.sealMode === 'direct' ? parsed.recipientPubKey : null,
		claimTokenHash: storedClaimTokenHash, // claim-time only; one-way
		sealedSecret, // ECIES envelope — opaque, addressed to recipient/claim key
		encryptedAtRest, // AES-256-GCM ciphertext for the reclaim sweep ONLY
		message: parsed.message,
		theme: parsed.theme,
		senderLabel: parsed.senderLabel,
		reclaimAddress: parsed.reclaimAddress,
		senderTag: parsed.senderTag,
		irlPinId: parsed.irlPinId,
		roomId: parsed.roomId,
		fundingTx: funding.fundingTx,
		fundingConfirmed: true,
		escrowPayer: verified.payer || null,
		createdAt: now,
		expiresAt: now + parsed.expiryHours * 3600_000,
		// Persisted as pending: recorded and id-reserved, but in no index and
		// refused by claim/reveal/reclaim until the create fee actually settles.
		// Otherwise a settle failure would leave a real, platform-funded wallet that
		// a direct-mode recipient could still reveal and drain for free.
		status: 'escrow_pending',
	};

	try {
		await createDrop(record);
	} catch (err) {
		return error(res, err.status || 500, err.code || 'store_failed', err.message);
	}

	let settled;
	try {
		settled = await settlePayment({ verified });
	} catch (err) {
		// The fee never landed, but the drop wallet is already funded on-chain. Undo
		// that: sweep the funds back to the wallet they came from (we still hold the
		// freshly-ground key in memory) and void the record.
		const rollback = await rollbackFunding({ record, secretKey: wallet.secretKeyBytes, reason: `create fee settle failed: ${err.message}` });
		return error(res, err.status || 502, err.code || 'settle_failed', `${err.message}. No drop was created${rollback}`);
	}

	// Fee collected: publish the drop (status funded + indexed) in one step.
	const activation = await activateDrop({ id, escrowTx: settled.transaction }).catch(() => 'error');
	if (activation !== 'live') {
		return error(res, 502, 'activation_failed', `your create fee settled (tx ${settled.transaction || 'unknown'}) but the drop could not be published; contact support with drop id ${id}`, {
			dropId: id,
			escrowTx: settled.transaction || null,
		});
	}

	const claimUrl = `${PUBLIC_ORIGIN}/drop/${id}`;
	const body200 = JSON.stringify({
		created: true,
		drop: await getDrop(id),
		funding: {
			confirmed: true,
			tx: funding.fundingTx,
			explorerUrl: `https://solscan.io/tx/${funding.fundingTx}`,
		},
		// In claim-time mode this is the bearer secret the creator embeds in the
		// link fragment (#k=…). Returned ONCE; the server discards it. In direct
		// mode it is null (the recipient already holds their private key).
		claimSecret: claimSecretForSender,
		claimUrl: claimSecretForSender ? `${claimUrl}#k=${claimSecretForSender}` : claimUrl,
		shareUrl: claimUrl,
		qrUrl: `${PUBLIC_ORIGIN}/api/vanity/drops?view=qr&id=${id}`,
		ogUrl: `${PUBLIC_ORIGIN}/api/og/sealed-drop?id=${id}`,
		escrow: { funded: true, txHash: settled.transaction || null, payer: settled.payer || verified.payer || null },
		notice: claimSecretForSender
			? 'The claim link contains the ONLY key that opens this wallet. Share the full link (with #k=…) with the recipient. Anyone who has the full link can claim it once.'
			: 'Sealed to the recipient X25519 key. Only they can open it — three.ws cannot.',
	});
	const contentType = 'application/json; charset=utf-8';

	res.setHeader('x-payment-response', encodePaymentResponseHeader(settled));
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', contentType);
	res.statusCode = 201;
	res.end(body200);

	if (paymentId) {
		await storeResponse({ route: ROUTE, paymentId, payloadHash, paymentHash, status: 201, body: body200, contentType, paymentResponseHeader: encodePaymentResponseHeader(settled) });
	}
}

// ── POST: claim (present claim token → atomic claim → release sealed envelope) ─

async function handleClaim(req, res) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'validation_error', err.message || 'invalid JSON body');
	}

	const id = String(body?.id || '').trim();
	if (!isValidDropId(id)) return error(res, 400, 'validation_error', 'id must be a 24-char hex drop id');

	const record = await getLiveDropRecord(id);
	if (!record) return error(res, 404, 'not_found', 'no drop with that id');

	if (record.status !== 'funded') {
		return json(res, 409, {
			claimed: false,
			status: record.status,
			reason: record.status === 'claimed' ? 'this drop was already claimed' : `this drop is ${record.status}`,
		});
	}
	if (record.expiresAt && Date.now() > record.expiresAt) {
		return json(res, 409, { claimed: false, status: 'expired', reason: 'this drop expired before it was claimed — the sender can reclaim it' });
	}

	// Authorize the claim.
	let claimerTag;
	if (record.sealMode === 'claim-time') {
		const claimToken = String(body?.claimToken || '').trim().toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(claimToken)) {
			return error(res, 400, 'claim_token_required', 'claimToken (64-char hex) is required to claim this bearer drop');
		}
		const presentedHash = hashClaimToken(claimToken);
		if (!timingSafeHexEqual(presentedHash, record.claimTokenHash || '')) {
			return error(res, 403, 'wrong_claim_token', 'this claim token does not match the drop — you need the original claim link');
		}
		// The claimerTag dedups idempotent retries of the SAME winning claim.
		claimerTag = presentedHash;
	} else {
		// direct mode: anyone may fetch the envelope; it's useless without the
		// recipient's private key. The claim simply marks the gift "opened". The
		// claimerTag is a constant so an idempotent re-claim returns the envelope.
		claimerTag = 'direct';
	}

	const claimRecipient = String(body?.claimRecipientPubKey || '').trim().slice(0, 64) || '';

	// Atomic single-claim CAS.
	let outcome;
	try {
		outcome = await claimDrop({ id, claimerTag, claimRecipient });
	} catch (err) {
		return error(res, err.status || 500, err.code || 'claim_failed', err.message);
	}

	if (outcome === 'missing') return error(res, 404, 'not_found', 'drop disappeared during claim');
	if (outcome === 'closed') {
		const fresh = await getDrop(id);
		return json(res, 409, { claimed: false, status: fresh?.status || 'closed', reason: 'drop closed/expired during claim' });
	}
	if (outcome === 'lost') {
		return json(res, 409, { claimed: false, status: 'claimed', reason: 'this drop was already claimed by someone else' });
	}

	// outcome === 'won' (first claim, or an idempotent re-claim with the same
	// token). Release the SEALED envelope for client-side opening. The plaintext
	// secret NEVER appears here — only the ECIES ciphertext.
	if (claimRecipient) {
		await recordClaimDelivery({ id, claimRecipient }).catch(() => {});
	}
	const fresh = await getDrop(id);
	return json(res, 200, {
		claimed: true,
		status: 'claimed',
		id,
		address: record.address,
		asset: record.asset,
		amount: record.amount,
		sealMode: record.sealMode,
		recipient: record.recipient || null,
		sealedSecret: record.sealedSecret,
		sealedScheme: SEALED_ENVELOPE_SCHEME,
		message: record.message || null,
		theme: record.theme || 'default',
		senderLabel: record.senderLabel || null,
		explorerUrl: `https://solscan.io/account/${record.address}`,
		drop: fresh,
		notice: record.sealMode === 'claim-time'
			? 'Open this envelope in your browser with the claim key from your link (#k=…). three.ws never saw that key.'
			: 'Open this envelope in your browser with your X25519 private key. three.ws never held it.',
	}, { 'cache-control': 'no-store' });
}

// ── POST: reveal (direct-seal: fetch the sealed envelope without claiming) ────

async function handleReveal(req, res) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'validation_error', err.message || 'invalid JSON body');
	}
	const id = String(body?.id || '').trim();
	if (!isValidDropId(id)) return error(res, 400, 'validation_error', 'id must be a 24-char hex drop id');

	const record = await getLiveDropRecord(id);
	if (!record) return error(res, 404, 'not_found', 'no drop with that id');
	if (record.sealMode !== 'direct') {
		return error(res, 409, 'wrong_mode', 'reveal is for direct-seal drops; bearer drops claim with their claim token');
	}

	// The envelope is ECIES ciphertext addressed to record.recipient — returning
	// it leaks nothing without the recipient's private key. The open is client-side.
	return json(res, 200, {
		revealed: true,
		id,
		address: record.address,
		asset: record.asset,
		amount: record.amount,
		recipient: record.recipient,
		sealedSecret: record.sealedSecret,
		sealedScheme: SEALED_ENVELOPE_SCHEME,
		message: record.message || null,
		theme: record.theme || 'default',
		senderLabel: record.senderLabel || null,
		status: record.status,
		explorerUrl: `https://solscan.io/account/${record.address}`,
		notice: 'Open this envelope client-side with your X25519 private key (openSealed). three.ws cannot — it never held your key.',
	}, { 'cache-control': 'no-store' });
}

// ── POST: reclaim (sender sweeps an expired, unclaimed drop on-chain) ──────────

async function handleReclaim(req, res) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'validation_error', err.message || 'invalid JSON body');
	}
	const id = String(body?.id || '').trim();
	if (!isValidDropId(id)) return error(res, 400, 'validation_error', 'id must be a 24-char hex drop id');

	const record = await getLiveDropRecord(id);
	if (!record) return error(res, 404, 'not_found', 'no drop with that id');

	// Atomic funded→reclaimed CAS, only for EXPIRED drops. Mutually exclusive with
	// claim — a claimed drop can never be reclaimed.
	const eligibility = await markReclaimable(id);
	if (eligibility === 'missing') return error(res, 404, 'not_found', 'drop disappeared');
	if (eligibility === 'ineligible') {
		const fresh = await getDrop(id);
		const why = fresh?.status === 'claimed'
			? 'this drop was already claimed — nothing to reclaim'
			: 'this drop has not expired yet';
		return json(res, 409, { reclaimed: false, status: fresh?.status, reason: why });
	}

	// Reclaim destination is BOUND to the address recorded when the drop was
	// created — never a value supplied in this (unauthenticated) request. A drop id
	// leaks through share links / OG cards, so trusting a body-supplied address
	// would let anyone who sees an id sweep the funded drop wallet to themselves.
	const refundTo = record.reclaimAddress;
	if (!refundTo || !BASE58_RE.test(refundTo)) {
		return error(res, 409, 'no_reclaim_address', 'this drop was created without a reclaim address; a self-service reclaim requires one set at create time');
	}

	// Reconstruct the drop wallet's key from the at-rest ciphertext ONLY to sign
	// the sweep. Never returned, never logged.
	let dropSecretKey;
	try {
		const bundle = JSON.parse(await decryptSecret(record.encryptedAtRest));
		dropSecretKey = Uint8Array.from(bundle.secretKey);
	} catch (err) {
		return error(res, 500, 'reclaim_key_error', 'could not reconstruct the drop key for the sweep');
	}

	let sweep;
	try {
		sweep = await sweepReclaim({ record: { ...record, status: 'reclaimed' }, dropSecretKey, toAddress: refundTo });
	} catch (err) {
		return json(res, 502, { reclaimed: false, status: 'reclaimed', reason: `reclaim sweep failed: ${err.message}. Retry to complete the reclaim.`, retryable: true });
	} finally {
		dropSecretKey?.fill?.(0);
	}

	return json(res, 200, {
		reclaimed: true,
		id,
		asset: record.asset,
		amount: record.amount,
		reclaimTx: sweep.reclaimTx,
		alreadyReclaimed: sweep.alreadyReclaimed,
		reclaimAddress: refundTo,
		explorerUrl: sweep.reclaimTx === 'empty' ? null : `https://solscan.io/tx/${sweep.reclaimTx}`,
		notice: sweep.reclaimTx === 'empty' ? 'The drop wallet was already empty; nothing to sweep.' : 'Funds swept back to your reclaim address.',
	}, { 'cache-control': 'no-store' });
}

// ── GET handlers ──────────────────────────────────────────────────────────────

async function handleGet(req, res, url) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const view = (url.searchParams.get('view') || 'config').toLowerCase();

	if (view === 'config') {
		return json(res, 200, {
			fundingConfigured: fundingConfigured(),
			assets: ['SOL', 'USDC', 'THREE'],
			networks: activeNetworks(),
			createFeeAtomics: CREATE_FEE_ATOMICS,
			createFeeUsd: (CREATE_FEE_ATOMICS / 1e6).toFixed(2),
			expiry: { minHours: MIN_EXPIRY_HOURS, maxHours: MAX_EXPIRY_HOURS, defaultHours: DEFAULT_EXPIRY_HOURS },
			themes: [...THEMES],
			sealModes: SEAL_MODES,
			protocol: DROP_PROTOCOL_VERSION,
			sealedScheme: SEALED_ENVELOPE_SCHEME,
		}, { 'cache-control': READ_CACHE });
	}

	if (view === 'get') {
		const id = (url.searchParams.get('id') || '').trim();
		if (!isValidDropId(id)) return error(res, 400, 'validation_error', 'id must be a 24-char hex drop id');
		const record = await getLiveDropRecord(id);
		if (!record) return error(res, 404, 'not_found', 'no drop with that id');
		// Public view + a claimable flag so the page knows which path to render,
		// WITHOUT exposing the envelope or token hash.
		const pub = await getDrop(id);
		const expired = record.expiresAt && Date.now() > record.expiresAt && record.status === 'funded';
		return json(res, 200, {
			drop: pub,
			claimable: record.status === 'funded' && !expired,
			expired,
			sealMode: record.sealMode,
		}, { 'cache-control': 'no-store' });
	}

	if (view === 'balance') {
		const id = (url.searchParams.get('id') || '').trim();
		if (!isValidDropId(id)) return error(res, 400, 'validation_error', 'id must be a 24-char hex drop id');
		const record = await getLiveDropRecord(id);
		if (!record) return error(res, 404, 'not_found', 'no drop with that id');
		const { atomics } = await readDropBalance({ address: record.address, asset: record.asset });
		return json(res, 200, {
			id,
			address: record.address,
			asset: record.asset,
			atomics,
			amount: atomics != null ? atomicsToAmount(atomics, record.asset) : null,
			explorerUrl: `https://solscan.io/account/${record.address}`,
		}, { 'cache-control': 'no-store' });
	}

	if (view === 'stats') {
		return json(res, 200, await dropStats(), { 'cache-control': READ_CACHE });
	}

	if (view === 'mine') {
		const tag = sanitizeTag(url.searchParams.get('senderTag'));
		if (!tag) return error(res, 400, 'validation_error', 'senderTag is required');
		const drops = await listBySender(tag, Number(url.searchParams.get('limit')) || 50);
		return json(res, 200, { drops, count: drops.length }, { 'cache-control': 'no-store' });
	}

	if (view === 'qr') {
		const id = (url.searchParams.get('id') || '').trim();
		if (!isValidDropId(id)) return error(res, 400, 'validation_error', 'id must be a 24-char hex drop id');
		const record = await getLiveDropRecord(id);
		if (!record) return error(res, 404, 'not_found', 'no drop with that id');
		// The QR encodes the share URL (no fragment — the fragment claim key never
		// goes server-side, so the QR shown server-side is the share landing only;
		// the page re-renders a QR WITH the fragment client-side for the holder).
		const target = `${PUBLIC_ORIGIN}/drop/${id}`;
		try {
			const QRCode = (await import('qrcode')).default;
			const svg = await QRCode.toString(target, { type: 'svg', margin: 1, width: 320, color: { dark: '#000000', light: '#ffffff' } });
			res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
			res.setHeader('cache-control', 'public, max-age=3600, s-maxage=86400');
			res.statusCode = 200;
			return res.end(svg);
		} catch (err) {
			return error(res, 500, 'qr_failed', 'could not render QR');
		}
	}

	return error(res, 400, 'unknown_view', 'view must be config, get, balance, stats, mine, or qr');
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
		if (action === 'reveal') return handleReveal(req, res);
		if (action === 'reclaim') return handleReclaim(req, res);
		return error(res, 400, 'unknown_action', 'action must be create, claim, reveal, or reclaim');
	}

	res.setHeader('allow', 'GET, POST, OPTIONS');
	return error(res, 405, 'method_not_allowed', 'use GET or POST');
});
