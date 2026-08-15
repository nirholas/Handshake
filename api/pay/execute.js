// POST /api/pay/execute: execute an x402 payment using a Payment Session token.
//
// This is the core "agent proposes spend, governance enforces" endpoint.
// The agent presents:
//   - session_token: their payment session bearer token
//   - url: the x402 endpoint to pay
//   - method: GET | POST (optional, default GET)
//   - body: JSON body for POST requests (optional)
//   - idempotency_key: caller's dedup key (optional, recommended)
//
// The platform:
//   1. Verifies the session token and reads the session's network preference
//   2. Probes the endpoint for its 402 challenge, selecting the right network accept
//   3. Enforces governance (budget, allowlist, per-tx cap) and reserves budget atomically
//   4. Signs the payment using the platform Solana payer wallet (loadSeedKeypair:
//      X402_SEED_SOLANA_SECRET_BASE58, falling back to X402_AGENT_SOLANA_SECRET_BASE58)
//   5. Presents X-PAYMENT header and returns the endpoint's response
//   6. Records the execution in payment_session_executions
//   7. On failure, rolls back the budget reservation so the session isn't charged
//
// No private key is ever exposed to the caller. The only secret is the session
// token, which is a time-bounded spending grant, not wallet access.

import {
	PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getMint,
} from '@solana/spl-token';

import { loadSeedKeypair } from '../_lib/x402/pay.js';
import { cors, error, json, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { validatePublicUrl, SsrfError } from '../_lib/ssrf.js';
import {
	guardedFetch,
	safeJson,
	b64decodeJson,
	readChallenge,
	USDC_SOLANA_MINT,
} from '../_lib/pay/probe.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import {
	atomicsToUsd,
	verifySessionToken,
	reserveSessionSpend,
	rollbackReservation,
	recordExecution,
	SpendGovernorError,
} from '../_lib/pay/spend-governor.js';

const SOLANA_RPC = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// ── Platform payer: Solana ───────────────────────────────────────────────────
let _solanaKeypair = null;

function loadSolanaKeypair() {
	if (_solanaKeypair) return _solanaKeypair;
	// Same payer wallet as the x402 ring and /api/x402-pay: loadSeedKeypair reads
	// X402_SEED_SOLANA_SECRET_BASE58 (primary) then X402_AGENT_SOLANA_SECRET_BASE58
	// (fallback), auto-detects the key encoding, and falls back to the dev test
	// keypair off disk outside production. See api/_lib/solana-signers.js.
	try {
		_solanaKeypair = loadSeedKeypair();
		return _solanaKeypair;
	} catch (err) {
		const e = new Error(err?.message || 'Platform Solana payer wallet not configured');
		e.status = 503;
		e.code = /undecodable/i.test(err?.message || '') ? 'wallet_misconfigured' : 'wallet_unconfigured';
		e.cause = err;
		throw e;
	}
}

// ── Probe a 402 endpoint and select a Solana USDC accept ────────────────────
// Exported for tests/pay-probe-endpoint-error.test.js: this is where a caller's
// URL turns into an amount the session is about to be charged, so its refusals
// are worth pinning independently of the signing path around them.
export async function probe402(rawUrl, { method, body }) {
	let res;
	try {
		res = await guardedFetch(rawUrl, { method, body });
	} catch (err) {
		if (err instanceof SsrfError) {
			throw Object.assign(new Error('Target URL is not a reachable public endpoint'), {
				status: 400, code: 'blocked_url',
			});
		}
		throw Object.assign(new Error(`Could not reach endpoint: ${err?.message}`), {
			status: 502, code: 'endpoint_unreachable',
		});
	}

	if (res.status !== 402) {
		// A success without a challenge is genuinely free and is handed straight
		// back. An error status is not: answering `ok: true, paid: false, "no
		// payment needed"` for a 500 told the agent its call succeeded for free
		// when the endpoint had in fact failed. Nothing was signed and no budget
		// was reserved at this point, so this is a clean 502 about the endpoint.
		if (res.ok) {
			return { free: true, status: res.status, result: safeJson(res.text) ?? res.text };
		}
		const parsed = safeJson(res.text);
		throw Object.assign(
			new Error(`Endpoint answered HTTP ${res.status} with no payment challenge, so there was nothing to pay`),
			{
				status: 502,
				code: 'endpoint_error',
				detail: {
					upstream_status: res.status,
					upstream_body: parsed ?? String(res.text ?? '').slice(0, 500),
				},
			},
		);
	}

	const challenge = readChallenge(res);
	if (!challenge || !Array.isArray(challenge.accepts)) {
		throw Object.assign(new Error('Service returned an unreadable payment challenge'), {
			status: 502, code: 'invalid_challenge',
		});
	}

	let accept = challenge.accepts.find(
		(a) => typeof a?.network === 'string' &&
			a.network.startsWith('solana') &&
			a.asset === USDC_SOLANA_MINT,
	);
	if (!accept) {
		accept = challenge.accepts.find(
			(a) => typeof a?.network === 'string' && a.network.startsWith('solana'),
		);
	}
	if (!accept) {
		throw Object.assign(new Error('Service has no Solana USDC payment option'), {
			status: 422, code: 'no_solana_accept',
			detail: { networks: [...new Set(challenge.accepts.map((a) => a?.network).filter(Boolean))] },
		});
	}
	if (accept.asset !== USDC_SOLANA_MINT) {
		throw Object.assign(new Error(`Service requested payment in a non-USDC asset (${accept.asset})`), {
			status: 422, code: 'unsupported_asset',
			detail: { asset: accept.asset, expected: USDC_SOLANA_MINT },
		});
	}
	if (!accept.extra?.feePayer) {
		throw Object.assign(new Error('Solana 402 challenge is missing feePayer'), {
			status: 422, code: 'missing_fee_payer',
		});
	}
	if (!accept.payTo) {
		throw Object.assign(new Error('Solana 402 challenge is missing payTo'), {
			status: 422, code: 'missing_pay_to',
		});
	}

	// The price is third-party input and every later step treats it as a BigInt:
	// it sizes the budget reservation and the transfer instruction. Parsing it
	// here means a challenge quoting "1.5" or "free" is a 422 about the service,
	// not an uncaught throw that reserves nothing and reports a 500.
	let amountAtomics;
	try {
		amountAtomics = BigInt(accept.amount);
	} catch {
		throw Object.assign(
			new Error(`Service quoted an unreadable price (${accept.amount})`),
			{ status: 422, code: 'invalid_amount', detail: { amount: accept.amount ?? null } },
		);
	}
	if (amountAtomics <= 0n) {
		throw Object.assign(
			new Error('Service quoted a non-positive price, which cannot be paid'),
			{ status: 422, code: 'invalid_amount', detail: { amount: String(amountAtomics) } },
		);
	}

	const resource =
		challenge.resource && typeof challenge.resource === 'object'
			? challenge.resource
			: { url: typeof challenge.resource === 'string' ? challenge.resource : rawUrl };

	return { challenge, accept, resource, amountAtomics };
}

// ── Build and sign the Solana USDC transfer ─────────────────────────────────
async function buildSolanaPayload({ accept, amount, buyer, conn, resourceUrl }) {
	const mint = new PublicKey(accept.asset);
	const payTo = new PublicKey(accept.payTo);
	const feePayer = new PublicKey(accept.extra.feePayer);

	const senderAta = getAssociatedTokenAddressSync(
		mint, buyer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const receiverAta = getAssociatedTokenAddressSync(
		mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const mintInfo = await getMint(conn, mint);

	const ixs = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
	];
	const receiverInfo = await conn.getAccountInfo(receiverAta);
	if (!receiverInfo) {
		ixs.push(createAssociatedTokenAccountIdempotentInstruction(
			feePayer, receiverAta, payTo, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		));
	}
	ixs.push(createTransferCheckedInstruction(
		senderAta, mint, receiverAta, buyer.publicKey,
		amount, mintInfo.decimals, [], TOKEN_PROGRAM_ID,
	));

	const { blockhash } = await conn.getLatestBlockhash('confirmed');
	const message = new TransactionMessage({
		payerKey: feePayer,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(message);
	vtx.sign([buyer]);

	return {
		x402Version: 2,
		scheme: 'exact',
		network: accept.network,
		resource: { url: resourceUrl, mimeType: 'application/json' },
		accepted: accept,
		payload: { transaction: Buffer.from(vtx.serialize()).toString('base64') },
	};
}

// Explorer URL for a given tx hash
function explorerUrl(txHash) {
	if (!txHash) return null;
	return `https://solscan.io/tx/${txHash}`;
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (req.method?.toUpperCase() !== 'POST') {
		return error(res, 405, 'method_not_allowed', 'POST required');
	}

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// readJson's second argument is a byte limit, not the response. Passing `res`
	// there made every size comparison `n > [object]`, i.e. NaN, i.e. false, so
	// the 1 MB body cap this call was meant to apply never applied at all.
	const body = await readJson(req);
	if (!body || typeof body !== 'object') {
		return error(res, 400, 'invalid_body', 'a JSON object body is required');
	}

	const sessionToken = body.session_token;
	if (!sessionToken) return error(res, 400, 'missing_token', 'session_token is required');

	const targetUrl = body.url;
	if (!targetUrl) return error(res, 400, 'missing_url', 'url is required');

	const method = body.method === 'POST' ? 'POST' : 'GET';
	const requestBody = method === 'POST' ? body.body ?? null : null;
	const idempotencyKey = body.idempotency_key ?? null;

	try {
		// allowHttp is pinned off rather than left to the default, which relaxes
		// to http outside production. This endpoint hands a caller-chosen URL a
		// signed payment; a plaintext hop is not something a dev box should allow
		// when the error message promises https.
		validatePublicUrl(targetUrl, { allowHttp: false });
	} catch {
		return error(res, 400, 'invalid_url', 'url must be a public https endpoint');
	}

	const t0 = Date.now();

	// Phase 0: verify the token is valid before probing the endpoint.
	// The atomic reservation happens later in phase 2.
	try {
		await verifySessionToken(sessionToken);
	} catch (err) {
		if (err instanceof SpendGovernorError) {
			return error(res, err.status, err.code, err.message, err.detail);
		}
		throw err;
	}

	// Phase 1: probe the endpoint for its 402 challenge
	let probeResult;
	try {
		probeResult = await probe402(targetUrl, { method, body: requestBody });
	} catch (err) {
		return error(res, err.status ?? 502, err.code ?? 'probe_failed', err.message, err.detail);
	}

	// Endpoint is free: return the result directly without touching the session
	if (probeResult.free) {
		return json(res, 200, {
			ok: true,
			paid: false,
			note: 'Endpoint served response without a 402. No payment needed.',
			status: probeResult.status,
			result: probeResult.result,
		});
	}

	const { accept, resource, amountAtomics } = probeResult;
	const amountUsd = atomicsToUsd(amountAtomics);

	// Phase 2: governance enforcement (check session, allowlist, budget) is atomic
	let sessionRecord, reservationId;
	try {
		const reservation = await reserveSessionSpend({
			token: sessionToken,
			url: targetUrl,
			amountAtomics,
		});
		sessionRecord = reservation.session;
		reservationId = reservation.reservationId;
	} catch (err) {
		if (err instanceof SpendGovernorError) {
			return error(res, err.status, err.code, err.message, err.detail);
		}
		throw err;
	}

	// Phase 3: load platform Solana payer and build the signed payment payload
	let paymentPayload;
	let payerAddress;

	let keypair;
	try {
		keypair = loadSolanaKeypair();
	} catch (err) {
		await rollbackReservation(sessionRecord.id, amountAtomics).catch(() => {});
		// loadSolanaKeypair separates "no key configured" from "key present but
		// undecodable". Collapsing both into wallet_unconfigured sent an operator
		// looking for a missing env var that was in fact already set.
		return error(
			res,
			err.status ?? 503,
			err.code ?? 'wallet_unconfigured',
			err.message || 'Platform Solana payment wallet is not configured',
		);
	}
	payerAddress = keypair.publicKey.toBase58();
	const conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
	try {
		paymentPayload = await buildSolanaPayload({
			accept,
			amount: amountAtomics,
			buyer: keypair,
			conn,
			resourceUrl: resource.url || targetUrl,
		});
	} catch (err) {
		await rollbackReservation(sessionRecord.id, amountAtomics).catch(() => {});
		return error(res, 502, 'build_failed', `Failed to build Solana payment: ${err?.message}`);
	}

	const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

	// Phase 4: submit payment to the endpoint
	let paid;
	try {
		paid = await guardedFetch(targetUrl, {
			method,
			body: requestBody,
			headers: { 'X-PAYMENT': xPayment },
		});
	} catch (err) {
		// Network failure AFTER signing: chain state unknown, do NOT roll back.
		await recordExecution({
			sessionId: sessionRecord.id,
			userId: sessionRecord.user_id,
			endpointUrl: targetUrl,
			method,
			amountAtomics,
			network: accept.network,
			txHash: null,
			payerAddress,
			payeeAddress: accept.payTo,
			status: 'failed',
			errorCode: 'settle_uncertain',
			errorMessage: err?.message,
			durationMs: Date.now() - t0,
			idempotencyKey,
		}).catch(() => {});
		return error(res, 502, 'settle_uncertain',
			'Payment was submitted but confirmation was not received. Do not retry immediately.');
	}

	const paidJson = safeJson(paid.text) ?? paid.text;
	const settled = b64decodeJson(paid.headers.get('x-payment-response'));
	const txHash = settled?.transaction || settled?.txHash || null;
	const payer = settled?.payer || payerAddress;
	const durationMs = Date.now() - t0;

	// Explicit pre-settlement rejection: no funds moved, safe to roll back
	if (paid.status === 402) {
		await rollbackReservation(sessionRecord.id, amountAtomics).catch(() => {});
		await recordExecution({
			sessionId: sessionRecord.id,
			userId: sessionRecord.user_id,
			endpointUrl: targetUrl,
			method,
			amountAtomics,
			network: accept.network,
			txHash: null,
			payerAddress: payer,
			payeeAddress: accept.payTo,
			status: 'failed',
			errorCode: 'payment_rejected',
			errorMessage: 'Service rejected the payment before settlement',
			durationMs,
			idempotencyKey,
		}).catch(() => {});
		return error(res, 402, 'payment_rejected',
			'Service rejected the payment before settlement. Budget has been restored.',
			typeof paidJson === 'object' ? paidJson : null);
	}

	// Non-402 non-success: chain state uncertain
	if (!paid.ok) {
		await recordExecution({
			sessionId: sessionRecord.id,
			userId: sessionRecord.user_id,
			endpointUrl: targetUrl,
			method,
			amountAtomics,
			network: accept.network,
			txHash,
			payerAddress: payer,
			payeeAddress: accept.payTo,
			status: 'failed',
			errorCode: 'upstream_error',
			errorMessage: `Endpoint returned HTTP ${paid.status}`,
			responseBody: typeof paidJson === 'object' ? paidJson : null,
			durationMs,
			idempotencyKey,
		}).catch(() => {});
		return error(res, 502, 'upstream_error',
			`Endpoint returned HTTP ${paid.status} after payment. Check wallet activity before retrying.`);
	}

	// Phase 5: success, record the settled execution
	await recordExecution({
		sessionId: sessionRecord.id,
		userId: sessionRecord.user_id,
		endpointUrl: targetUrl,
		method,
		amountAtomics,
		network: accept.network,
		txHash,
		payerAddress: payer,
		payeeAddress: accept.payTo,
		status: 'settled',
		responseBody: typeof paidJson === 'object' ? paidJson : null,
		durationMs,
		idempotencyKey,
	}).catch(() => {});

	return json(res, 200, {
		ok: true,
		paid: true,
		result: paidJson,
		payment: {
			session_id: sessionRecord.id,
			amount_usd: amountUsd,
			network: accept.network,
			payer,
			pay_to: accept.payTo,
			tx_hash: txHash,
			explorer: explorerUrl(txHash),
		},
		session: {
			id: sessionRecord.id,
			spent_usd: atomicsToUsd(BigInt(sessionRecord.spent_usdc)),
			remaining_usd: atomicsToUsd(
				BigInt(sessionRecord.budget_usdc) - BigInt(sessionRecord.spent_usdc),
			),
		},
		duration_ms: durationMs,
	});
});
