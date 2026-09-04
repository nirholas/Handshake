// /api/x402/pay-by-name
//
// Unified payment routing: pay a recipient identified by *name* instead of by
// raw address. Resolves the name across three namespaces in this order:
//
//   1. `@<username>` (or bare username, 3–30 chars [a-z0-9_-]) — looks up
//      `users.username`, then picks that user's default agent's Solana
//      address. Falls through if no match.
//   2. `<anything>.sol` (including subdomains like `nich.threews.sol`) —
//      resolved on-chain via Bonfida `resolve()`.
//   3. raw base58 address — passes through.
//
// GET  /api/x402/pay-by-name?name=<name>
//   Resolve only. Returns { name, address, source, full?, claim? }.
//
// POST /api/x402/pay-by-name { name, amount_usdc, message?, mode }
//   mode='prep': build an unsigned USDC SPL transfer tx with the caller's
//     `payer_wallet` (passed in body) as fee payer + source. Returns the
//     base64-encoded VersionedTransaction for browser wallet signing.
//   mode='send' (requires auth + agent_id): server signs as the caller's
//     specified agent (must be theirs), broadcasts the transfer, returns
//     the signature.

import {
	Connection,
	PublicKey,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync,
	createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { submitProtected } from '../_lib/execution-engine.js';
import { sql } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { solanaConnection, loadAgentForSigning } from '../_lib/agent-pumpfun.js';
import { blockhashKey, getRecentBlockhashInfo } from '../_lib/solana/read-guards.js';
import { getSpendLimits } from '../_lib/agent-trade-guards.js';
import { PARENT_LABEL } from '../_lib/threews-sns.js';
import {
	NETWORK_SOLANA_MAINNET,
	encodePaymentResponseHeader,
	resolveResourceUrl,
	send402,
	settlePayment,
	verifyPayment,
} from '../_lib/x402-spec.js';
import { logPaymentEvent } from '../_lib/x402/audit-log.js';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HANDLE_RE = /^@?[a-z0-9_-]{3,30}$/i;
const SOL_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.sol$/i;

// ── Paid name resolution (x402 paywall) ──────────────────────────────────────
// POST {"name":"<name>"} without payer_wallet/amount_usdc triggers the 402
// paywall. On payment, resolves the name to an on-chain address and returns
// { data: { name, address, verified, source } }. Used by the autonomous loop
// health check (registry id: pay-by-name-resolve-three-ws) to continuously
// verify the pay-by-name registry is functioning with a real paid call.
const PAID_RESOLVE_ROUTE = '/api/x402/pay-by-name';
const PAID_RESOLVE_PRICE_ATOMIC = 1000; // $0.001 USDC

function buildSolanaAccepts(priceAtomics, resourceUrl) {
	const solTo = env.X402_PAY_TO_SOLANA;
	const feePayer = env.X402_FEE_PAYER_SOLANA;
	const mint = env.X402_ASSET_MINT_SOLANA;
	if (!solTo || !feePayer || !mint) return null;
	return [{
		scheme: 'exact',
		amount: String(priceAtomics),
		maxTimeoutSeconds: 60,
		resource: resourceUrl,
		network: NETWORK_SOLANA_MAINNET,
		payTo: solTo,
		asset: mint,
		extra: { name: 'USDC', decimals: 6, feePayer },
	}];
}

function isOnCurveAddress(addr) {
	try {
		return typeof addr === 'string' && PublicKey.isOnCurve(new PublicKey(addr).toBytes());
	} catch {
		return false;
	}
}

async function handlePaidNameResolve(req, res, body) {
	const name = String(body?.name || '').trim();

	const resourceUrl = resolveResourceUrl(req, PAID_RESOLVE_ROUTE);
	const accepts = buildSolanaAccepts(PAID_RESOLVE_PRICE_ATOMIC, resourceUrl);
	if (!accepts) {
		return error(res, 503, 'not_configured', 'Solana pay-by-name resolution is not configured');
	}

	const paymentHeader = req.headers?.['x-payment'];
	if (!paymentHeader) {
		return send402(res, {
			resourceUrl,
			accepts,
			description: 'Resolve a wallet name to an on-chain Solana address via the three.ws pay-by-name registry',
			serviceName: 'Pay-By-Name Resolution',
			tags: ['identity', 'resolution', 'solana'],
		});
	}

	// The `name` check lives BELOW the challenge on purpose. A bare POST with no
	// body is how a directory validates a paid row before listing it, and a 400
	// tells it this route sells nothing. The probe now reads the 402 it looks
	// for, and a buyer who actually pays without naming anything still gets the
	// validation error, before anything is settled.
	if (!name) return error(res, 400, 'validation_error', 'name required');

	let verified;
	try {
		verified = await verifyPayment({ paymentHeader, requirements: accepts });
	} catch (err) {
		return send402(res, {
			resourceUrl,
			accepts,
			error: err?.message || 'invalid payment',
		});
	}

	// Resolve BEFORE settling. A name that resolves to nothing has no value to
	// sell, so the payment is left unspent and the buyer can retry or pay a
	// different endpoint. Settling first would have charged $0.001 for an
	// { address: null } answer, which is exactly what the pipeline stages take
	// care never to do.
	const resolved = await resolveName(name);
	if (!resolved?.address) {
		return error(res, 404, 'not_found', `could not resolve "${name}" (payment was not taken)`);
	}

	let settleResult;
	try {
		settleResult = await settlePayment({ verified });
	} catch (err) {
		return error(res, 502, 'settle_failed', err?.message || 'settlement failed');
	}

	logPaymentEvent({
		eventType: 'payment_settled',
		route: PAID_RESOLVE_ROUTE,
		resourceUrl,
		payer: verified.payer || null,
		network: verified.requirement?.network || null,
		amount: verified.requirement?.amount || null,
		txHash: settleResult?.transaction || null,
	});

	res.setHeader('x-payment-response', encodePaymentResponseHeader(settleResult, {}));

	return json(res, 200, {
		data: {
			name,
			address: resolved.address,
			verified: isOnCurveAddress(resolved.address),
			source: resolved.source ?? null,
		},
	});
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

/**
 * Resolve a name (handle, .sol domain, or raw address) to a recipient.
 * Returns { address, source, resolved, claim? } or null.
 */
async function resolveName(rawName) {
	const name = String(rawName || '').trim();
	if (!name) return null;

	// 1. raw base58 address — return as-is.
	if (ADDR_RE.test(name)) {
		return { address: name, source: 'address', resolved: name };
	}

	// 2. .sol domains, including subdomains (foo.threews.sol).
	if (SOL_DOMAIN_RE.test(name)) {
		const bare = name.replace(/\.sol$/i, '');
		// If it's a `<label>.threews` form, also surface our DB claim so
		// callers can show the showcase link.
		let claim = null;
		const threewsSuffix = `.${PARENT_LABEL}`;
		if (bare.toLowerCase().endsWith(threewsSuffix)) {
			const label = bare.slice(0, -threewsSuffix.length).toLowerCase();
			const [row] = await sql`
				SELECT s.label, s.parent, u.id AS user_id, u.username, u.display_name
				FROM user_subdomains s
				JOIN users u ON u.id = s.user_id
				WHERE s.label = ${label} AND s.parent = ${PARENT_LABEL}
				LIMIT 1
			`;
			if (row) {
				claim = {
					user_id: row.user_id,
					username: row.username,
					display_name: row.display_name,
				};
			}
		}
		try {
			const sns = await import('@bonfida/spl-name-service');
			const conn = solanaConnection('mainnet');
			const pk = await sns.resolve(conn, bare);
			return {
				address: pk.toBase58(),
				source: 'sns',
				resolved: name.toLowerCase(),
				...(claim ? { claim } : {}),
			};
		} catch {
			return null;
		}
	}

	// 3. @username or bare username.
	if (HANDLE_RE.test(name)) {
		const handle = name.replace(/^@/, '').toLowerCase();
		const [user] = await sql`
			SELECT id, username, display_name FROM users
			WHERE lower(username) = ${handle} AND deleted_at IS NULL
			LIMIT 1
		`;
		if (!user) return null;
		const [agent] = await sql`
			SELECT meta->>'solana_address' AS sol
			FROM agent_identities
			WHERE user_id = ${user.id} AND deleted_at IS NULL
			ORDER BY created_at ASC
			LIMIT 1
		`;
		if (!agent?.sol) return null;
		return {
			address: agent.sol,
			source: 'username',
			resolved: `@${user.username}`,
			claim: { user_id: user.id, username: user.username, display_name: user.display_name },
		};
	}

	return null;
}

function parseAmountUsdc(input) {
	const n = Number(input);
	if (!Number.isFinite(n) || n <= 0) return null;
	// 6 decimals → cap at 10_000 USDC per call to bound damage if misused.
	if (n > 10_000) return null;
	return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

async function buildTransferIxs({ payer, recipient, amountAtoms }) {
	const payerAta = getAssociatedTokenAddressSync(
		USDC_MINT,
		payer,
		false,
		TOKEN_PROGRAM_ID,
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const recipientAta = getAssociatedTokenAddressSync(
		USDC_MINT,
		recipient,
		false,
		TOKEN_PROGRAM_ID,
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const ataIx = createAssociatedTokenAccountIdempotentInstruction(
		payer,
		recipientAta,
		recipient,
		USDC_MINT,
		TOKEN_PROGRAM_ID,
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const transferIx = createTransferCheckedInstruction(
		payerAta,
		USDC_MINT,
		recipientAta,
		payer,
		amountAtoms,
		USDC_DECIMALS,
		[],
		TOKEN_PROGRAM_ID,
	);
	return [ataIx, transferIx];
}

async function handleResolve(req, res) {
	const url = new URL(req.url, 'http://x');
	const name = url.searchParams.get('name');
	if (!name) return error(res, 400, 'validation_error', 'name required');
	const resolved = await resolveName(name);
	if (!resolved) return error(res, 404, 'not_found', `could not resolve "${name}"`);
	return json(res, 200, { data: resolved }, { 'cache-control': 'public, max-age=60' });
}

async function handlePrep(req, res, body) {
	const payerWallet = String(body?.payer_wallet || '').trim();
	if (!ADDR_RE.test(payerWallet)) {
		return error(res, 400, 'validation_error', 'payer_wallet must be a base58 Solana public key');
	}
	const resolved = await resolveName(body?.name);
	if (!resolved) return error(res, 404, 'not_found', `could not resolve "${body?.name}"`);
	const amountAtoms = parseAmountUsdc(body?.amount_usdc);
	if (!amountAtoms) return error(res, 400, 'validation_error', 'amount_usdc must be > 0 and ≤ 10000');

	const payer = new PublicKey(payerWallet);
	const recipient = new PublicKey(resolved.address);
	if (payer.equals(recipient)) {
		return error(res, 400, 'self_pay', 'payer and recipient resolve to the same wallet');
	}
	const conn = solanaConnection('mainnet');
	const ixs = await buildTransferIxs({ payer, recipient, amountAtoms });
	const { blockhash, lastValidBlockHeight } = await getRecentBlockhashInfo(conn, blockhashKey({ network: 'mainnet' }));
	const msg = new TransactionMessage({
		payerKey: payer,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const tx = new VersionedTransaction(msg);

	return json(res, 200, {
		data: {
			recipient: resolved,
			amount_usdc: Number(amountAtoms) / 10 ** USDC_DECIMALS,
			tx_base64: Buffer.from(tx.serialize()).toString('base64'),
			blockhash,
			last_valid_block_height: lastValidBlockHeight,
			mint: USDC_MINT.toBase58(),
		},
	});
}

async function handleSend(req, res, auth, body) {
	const agentId = String(body?.agent_id || '').trim();
	if (!agentId) return error(res, 400, 'validation_error', 'agent_id required when mode=send');

	const resolved = await resolveName(body?.name);
	if (!resolved) return error(res, 404, 'not_found', `could not resolve "${body?.name}"`);
	const amountAtoms = parseAmountUsdc(body?.amount_usdc);
	if (!amountAtoms) return error(res, 400, 'validation_error', 'amount_usdc must be > 0 and ≤ 10000');

	// Recipient-poisoning guard. A name (esp. a raw SNS .sol domain) can repoint
	// between the preview the user approved and this send, or a lookalike name can
	// resolve to an attacker wallet. If the caller passes the address it previewed
	// as `expected_address`, require the fresh resolution to still match it before
	// the agent signs — binds the approved recipient into the signed request.
	if (body?.expected_address && String(body.expected_address) !== resolved.address) {
		return error(res, 409, 'recipient_changed',
			'the name now resolves to a different address than the one you confirmed; re-preview before sending',
			{ expected: String(body.expected_address), resolved: resolved.address });
	}

	let recipient;
	try {
		recipient = new PublicKey(resolved.address);
	} catch {
		return error(res, 400, 'invalid_recipient', 'resolved address is not a valid Solana public key');
	}
	// Reject off-curve targets (PDAs / program addresses can't hold a token account
	// the way a user wallet does, and an off-curve "recipient" is a red flag).
	if (!PublicKey.isOnCurve(recipient.toBytes())) {
		return error(res, 400, 'invalid_recipient', 'resolved address is not a valid wallet (off-curve)');
	}

	const loaded = await loadAgentForSigning(agentId, auth.userId, {
		reason: 'x402_pay_by_name',
		meta: { name: body?.name, amount_usdc: Number(amountAtoms) / 10 ** USDC_DECIMALS },
	});
	if (loaded.error) return error(res, loaded.error.status, loaded.error.code, loaded.error.msg);
	const { keypair } = loaded;

	// Per-transaction USD ceiling: this is a custodial outbound transfer, so bound
	// it by the agent's configured per-tx limit (USDC ≈ $1, 6 decimals).
	const spendUsd = Number(amountAtoms) / 10 ** USDC_DECIMALS;
	const spendLimits = getSpendLimits(loaded.agent?.meta);
	if (spendLimits.per_tx_usd != null && spendUsd > spendLimits.per_tx_usd + 1e-9) {
		return error(res, 403, 'per_tx_exceeded',
			`This $${spendUsd.toFixed(2)} send is over the agent's per-transaction limit of $${spendLimits.per_tx_usd.toFixed(2)}.`);
	}

	if (keypair.publicKey.equals(recipient)) {
		return error(res, 400, 'self_pay', 'agent and recipient resolve to the same wallet');
	}

	const conn = solanaConnection('mainnet');
	const ixs = await buildTransferIxs({
		payer: keypair.publicKey,
		recipient,
		amountAtoms,
	});
	let signature;
	try {
		// Protected send: priority fee + CU estimate, rebroadcast with blockhash
		// refresh until it lands, hard throw on an on-chain revert.
		({ signature } = await submitProtected({ network: 'mainnet', connection: conn, payer: keypair, instructions: ixs }));
	} catch (err) {
		console.error('[pay-by-name] send_failed', err);
		return error(res, 502, 'upstream_error', err?.message || 'transfer failed');
	}

	return json(res, 200, {
		data: {
			recipient: resolved,
			payer: keypair.publicKey.toBase58(),
			amount_usdc: Number(amountAtoms) / 10 ** USDC_DECIMALS,
			signature,
			mode: 'send',
		},
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'GET') return handleResolve(req, res);

	const body = await readJson(req).catch(() => ({}));

	// Paid name resolution — body has `name` but no payer_wallet/amount_usdc and
	// no explicit prep/send mode. Returns 402 challenge; on payment resolves the
	// name and returns { data: { name, address, verified, source } }.
	//
	// A body-less POST lands here too. That is the paid capability this route is
	// cataloged under, and a bare `curl -X POST` is exactly how a directory
	// validates a paid row: it used to fall through to the free prep branch and
	// answer 400, so the row read as selling nothing. mode=prep still reaches
	// prep, it just has to say so (or carry the wallet/amount fields prep needs
	// anyway).
	const paidResolveLane =
		!body?.payer_wallet &&
		!body?.amount_usdc &&
		body?.mode !== 'send' &&
		body?.mode !== 'prep';
	if (paidResolveLane) {
		return handlePaidNameResolve(req, res, body);
	}

	const mode = body?.mode === 'send' ? 'send' : 'prep';

	if (mode === 'prep') return handlePrep(req, res, body);

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required for mode=send');
	return handleSend(req, res, auth, body);
});
