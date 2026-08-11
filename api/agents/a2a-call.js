// POST /api/agents/a2a-call — autonomous, mandate-authorized agent-to-agent payment.
//
// This is the load-bearing piece of agent-to-agent commerce: it lets one of the
// caller's agents discover a peer's paid A2A skill, pay for it under a signed
// Intent Mandate, and return the peer's result — without a human approving each
// individual payment. Safety comes from four gates, all enforced here before a
// single token moves:
//
//   1. Mandate signature + per-call policy (mandate.js): is this spend authorized
//      at all, on this network, to this peer, in this currency, under the per-call cap?
//   2. Cumulative budget (spend-ledger.js): would this push lifetime spend under
//      the mandate over its total cap? Reserved atomically, released on failure.
//   3. Reputation (reputation-gate.js): does the peer clear the caller's ERC-8004
//      trust bar? Opt-in per call.
//   4. The subject agent's own spend policy (agent-trade-guards.js): the freeze
//      switch, the per-transaction ceiling, the rolling daily ceiling, the
//      per-counterparty ceiling, the owner's natural-language rules, the anomaly
//      guard, and any scoped capability. This is the gate a mandate CANNOT widen.
//      A mandate is a signed, offline-verifiable bearer credential that lives for
//      up to 90 days, so on its own it has no revocation story: whoever holds it
//      can spend its remaining budget until it expires. Routing every A2A payment
//      through the same server-side policy every other outbound path already uses
//      is what makes an outstanding mandate stoppable, and it is what makes each
//      payment leave a durable receipt in the agent's custody ledger instead of
//      only a response body the caller may never persist.
//
// Settlement itself reuses the existing A2A x402 client (api/_lib/x402/a2a-client.js)
// so this inherits the spec-compliant two-leg handshake. Solana is the primary
// rail — USDC SPL TransferChecked, partially signed by the platform payer and
// co-signed by the peer's facilitator fee payer — with EVM EIP-3009 as fallback.

import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, rateLimited, readJson, respondError, serverError, wrap } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { assertSafePublicUrl, SsrfBlockedError } from '../_lib/ssrf-guard.js';
import { assertMandateAllows, MandateError, verifyIntentMandate } from '../_lib/a2a/mandate.js';
import { issueCartMandate } from '../_lib/a2a/cart-mandate.js';
import { release, reserve } from '../_lib/a2a/spend-ledger.js';
import { assertReputationOk, ReputationError } from '../_lib/a2a/reputation-gate.js';
import {
	getSpendLimits,
	releaseSpendReservation,
	reserveSpendUsd,
	SpendLimitError,
	updateCustodyEvent,
} from '../_lib/agent-trade-guards.js';
import {
	A2AClientError,
	buildEvmExactPayload,
	buildSolanaExactPayload,
	createPrivateKeySigner,
	createSolanaSigner,
	isSolanaNetwork,
	NETWORK_SOLANA_DEVNET,
	NETWORK_SOLANA_MAINNET,
	requestQuote,
	submitPayment,
} from '../_lib/x402/a2a-client.js';

// Solana is the primary settlement rail; EVM chains are the fallback.
const DEFAULT_NETWORK_PREFERENCE = [
	NETWORK_SOLANA_MAINNET,
	'eip155:8453',
	'eip155:84532',
	'eip155:1',
];

// Choose the accept entry to pay against, honoring the caller's network
// preference and only ever picking a `scheme=exact` entry on a rail we can
// settle — Solana SPL or an EVM chain. Solana is preferred when both are
// offered without an explicit preference.
function pickAccept(accepts, preference) {
	const order = preference?.length ? preference : DEFAULT_NETWORK_PREFERENCE;
	for (const net of order) {
		const match = accepts.find((a) => a.network === net && a.scheme === 'exact');
		if (match) return match;
	}
	const solana = accepts.find((a) => a.scheme === 'exact' && isSolanaNetwork(a.network));
	if (solana) return solana;
	const evm = accepts.find((a) => a.scheme === 'exact' && /^eip155:\d+$/.test(a.network));
	if (evm) return evm;
	throw new A2AClientError(
		'no_supported_accept',
		'peer offered no supported (scheme=exact) accept entry on Solana or EVM',
		{ accepts: accepts.map(({ network, scheme }) => ({ network, scheme })) },
	);
}

// Normalize the on-chain asset name to a currency symbol for the mandate check.
function currencyOf(accept) {
	const name = accept?.extra?.name || '';
	return /usdc|usd coin/i.test(name) ? 'USDC' : name || undefined;
}

// USDC is the only currency the A2A rails settle in, and it is a dollar with six
// decimals, so the atomic amount IS the USD value. Any other asset is left
// unpriced rather than guessed: the spend guard treats a null USD as unpriceable
// and still writes the receipt, but will not pretend to meter a number it does
// not have. Returns null when the amount is unusable.
const USDC_ATOMICS_PER_USD = 1e6;
function spendUsdOf(amountAtomics, currency) {
	if (currency !== 'USDC') return null;
	const n = Number(amountAtomics);
	if (!Number.isFinite(n) || n < 0) return null;
	return n / USDC_ATOMICS_PER_USD;
}

// Map a CAIP-2 settlement network onto the custody ledger's coarse network name.
// The ledger meters one budget per (agent, network); folding every mainnet rail
// (Solana mainnet and every EVM mainnet) into 'mainnet' is deliberate, so an agent
// cannot double its real daily cap by alternating rails. Solana devnet is the only
// test rail and keeps its own budget.
function custodyNetworkOf(caip2) {
	return caip2 === NETWORK_SOLANA_DEVNET ? 'devnet' : 'mainnet';
}

// Bare hostname of a peer endpoint, used as the capability holder ref so a
// per-integration scoped key resolves preferentially. Never throws: the URL was
// already parsed by the SSRF guard, but a caller-shaped string is not worth a 500.
function hostOf(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer?.userId;

	const rl = await limits.mcpAgentPay(userId || 'anon');
	if (!rl.success) return rateLimited(res, rl, 'a2a payment rate limit exceeded');

	const body = await readJson(req);
	const {
		mandate: mandateJws,
		endpoint,
		text = 'Initiate paid skill.',
		networkPreference,
		reputation,
	} = body || {};

	if (!endpoint || typeof endpoint !== 'string') {
		return error(res, 400, 'validation_error', 'endpoint (peer A2A URL) is required');
	}

	// The peer endpoint is fully caller-controlled and we make a server-side
	// request to it — guard against SSRF into internal addresses.
	let safeEndpoint;
	try {
		safeEndpoint = (await assertSafePublicUrl(endpoint, { allowHttp: false })).toString();
	} catch (err) {
		if (err instanceof SsrfBlockedError) {
			return error(res, 400, 'invalid_endpoint', err.message);
		}
		throw err;
	}

	// ── Gate 1a: mandate is valid and belongs to this user ──────────────────
	let mandate;
	try {
		mandate = await verifyIntentMandate(mandateJws);
	} catch (err) {
		if (err instanceof MandateError) return respondError(res, err.status, err.code, err);
		throw err;
	}
	if (mandate.ownerUserId !== userId) {
		return error(res, 403, 'mandate_not_yours', 'this mandate was issued to a different user');
	}

	// ── Gate 4a: the subject agent still exists and is still the caller's ───
	// The mandate names the agent that may spend. Re-resolving it here (rather than
	// trusting the signed claim alone) is what binds a long-lived credential to the
	// CURRENT state of the account: an agent that was deleted, or transferred to
	// another owner since the mandate was issued, stops being spendable immediately.
	const [agent] = await sql`
		SELECT id, user_id, meta FROM agent_identities
		WHERE id = ${mandate.subjectAgentId} AND deleted_at IS NULL
	`;
	if (!agent) {
		return error(res, 404, 'agent_not_found', 'the agent this mandate authorizes no longer exists');
	}
	if (String(agent.user_id) !== String(userId)) {
		return error(res, 403, 'agent_not_yours', 'the agent this mandate authorizes is not yours');
	}

	// ── Gate 4b: kill switch ────────────────────────────────────────────────
	// Checked BEFORE the peer is contacted. A halted agent must not spend, and it
	// must not phone a paid endpoint either: the quote leg is outbound traffic in
	// the agent's name, and letting it through would leak that the agent is live
	// and keep the peer's meter running while the owner believes it is stopped.
	const agentLimits = getSpendLimits(agent.meta);
	if (agentLimits.frozen) {
		return error(
			res,
			403,
			'wallet_frozen',
			'This agent is halted. Autonomous spending (trades, snipes, payments) is paused, so this mandate cannot be used. Unfreeze it under Limits & Safety to resume.',
			{ agent_id: String(agent.id) },
		);
	}

	// ── Discover the peer's price (first leg of the A2A handshake) ──────────
	let quote;
	try {
		quote = await requestQuote({ endpoint: safeEndpoint, text });
	} catch (err) {
		if (err instanceof A2AClientError) {
			console.error('[agents/a2a-call] peer quote failed', err?.message);
			return serverError(res, 502, 'quote_failed', err);
		}
		throw err;
	}

	let accept;
	try {
		accept = pickAccept(quote.required.accepts, networkPreference);
	} catch (err) {
		return error(res, 422, err.code || 'no_supported_accept', err.message);
	}
	const amount = accept.amount;
	const network = accept.network;

	// ── Gate 1b: per-call policy ────────────────────────────────────────────
	try {
		assertMandateAllows({
			mandate,
			amountAtomics: amount,
			network,
			resource: safeEndpoint,
			currency: currencyOf(accept),
		});
	} catch (err) {
		if (err instanceof MandateError) return respondError(res, err.status, err.code, err);
		throw err;
	}

	// ── Gate 3: peer reputation (opt-in) ────────────────────────────────────
	if (reputation && typeof reputation === 'object') {
		try {
			await assertReputationOk({
				agentId: reputation.agentId,
				chainId: reputation.chainId,
				minAverage: Number(reputation.minAverage) || 0,
				minCount: Number(reputation.minCount) || 0,
			});
		} catch (err) {
			if (err instanceof ReputationError) {
				return respondError(res, err.status, err.code, err);
			}
			throw err;
		}
	}

	// ── Gate 2: reserve against the total budget (atomic) ───────────────────
	const nowSec = Math.floor(Date.now() / 1000);
	const ledgerTtl = Math.max(60, (mandate.expiresAt || nowSec) - nowSec);
	const reservation = await reserve(mandate.mandateId, amount, mandate.maxAtomics, ledgerTtl);
	if (!reservation.ok) {
		return error(res, 402, 'budget_exceeded', 'mandate budget would be exceeded by this payment', {
			spent: reservation.spent,
			cap: reservation.cap,
			amount,
		});
	}

	// ── Gate 4c: the agent's own spend policy + the receipt ─────────────────
	// Atomic: this both enforces the per-transaction, rolling-daily and
	// per-counterparty ceilings (plus the owner's English rules, the anomaly guard
	// and any scoped capability) AND writes the pending receipt row under a
	// per-agent lock, so concurrent A2A calls cannot all pass on the same stale
	// total. The counterparty is the peer's on-chain payee, the same identity the
	// x402 pay path meters, so an agent that pays one peer through two different
	// surfaces still draws down one per-counterparty budget.
	const custodyNetwork = custodyNetworkOf(network);
	const spendUsd = spendUsdOf(amount, currencyOf(accept));
	let receiptId = null;
	try {
		const guarded = await reserveSpendUsd({
			agentId: String(agent.id),
			userId,
			meta: agent.meta,
			limits: agentLimits,
			category: 'x402',
			usdValue: spendUsd,
			destination: accept.payTo || null,
			network: custodyNetwork,
			asset: currencyOf(accept) || 'USDC',
			target: safeEndpoint,
			capabilityHolderRef: hostOf(safeEndpoint),
			rowMeta: {
				kind: 'a2a',
				mandate_id: mandate.mandateId,
				endpoint: safeEndpoint,
				task_id: quote.taskId,
				settlement_network: network,
				amount_atomics: String(amount),
			},
		});
		receiptId = guarded.reservationId;
	} catch (err) {
		await release(mandate.mandateId, amount);
		if (err instanceof SpendLimitError) {
			return error(res, err.status, err.code, err.message, err.detail);
		}
		throw err;
	}

	// Every exit below this point must settle the receipt one way or the other: a
	// pending row left behind would hold daily headroom forever for a payment that
	// never happened.
	const abandonReceipt = async (reason) => {
		await releaseSpendReservation(receiptId, reason).catch((e) =>
			console.error('[agents/a2a-call] receipt release failed', e?.message || e),
		);
		await release(mandate.mandateId, amount);
	};

	// ── Settle ──────────────────────────────────────────────────────────────
	// Pick the payer wallet for the chosen rail. Solana is primary (SPL
	// TransferChecked co-signed by the peer's facilitator fee payer); EVM is the
	// fallback (EIP-3009 transferWithAuthorization).
	const onSolana = isSolanaNetwork(network);
	const payerKey = onSolana ? env.A2A_PAYER_SOLANA_SECRET : env.A2A_PAYER_PRIVATE_KEY;
	if (!payerKey) {
		await abandonReceipt('payer_not_configured');
		return error(
			res,
			501,
			'payer_not_configured',
			onSolana
				? 'autonomous Solana payer wallet is not configured (set A2A_PAYER_SOLANA_SECRET)'
				: 'autonomous EVM payer wallet is not configured (set A2A_PAYER_PRIVATE_KEY)',
			{ network },
		);
	}

	// ── Cart Mandate: sign the exact transaction (AP2 per-tx approval) ──────
	// Bound to the intent mandate + the precise cart, this is the non-repudiable
	// record of WHAT was paid. Issued before settlement so it accompanies the
	// payment and is returned to the caller as a verifiable receipt.
	const cartCurrency = currencyOf(accept) || null;
	let cartMandateJws = null;
	let cartMandate = null;
	try {
		({ jws: cartMandateJws, cartMandate } = await issueCartMandate({
			intentMandate: mandate,
			cart: {
				resource: safeEndpoint,
				amountAtomics: amount,
				currency: cartCurrency || mandate.currency,
				network,
				taskId: quote.taskId,
				items: [{ name: text, amountAtomics: amount }],
			},
		}));
	} catch (err) {
		await abandonReceipt('cart_mandate_failed');
		if (err instanceof MandateError) return respondError(res, err.status, err.code, err);
		throw err;
	}

	try {
		const resource = quote.required.resource || { url: safeEndpoint, mimeType: 'application/json' };
		let signer;
		let paymentPayload;
		let payerAddress;
		if (onSolana) {
			signer = await createSolanaSigner(payerKey);
			payerAddress = signer.address;
			paymentPayload = await buildSolanaExactPayload({
				accept,
				signer,
				resource,
				rpcUrl: env.SOLANA_RPC_URL,
			});
		} else {
			signer = await createPrivateKeySigner(payerKey);
			payerAddress = signer.address;
			paymentPayload = await buildEvmExactPayload({ accept, signer, resource });
		}
		const result = await submitPayment({
			endpoint: safeEndpoint,
			taskId: quote.taskId,
			paymentPayload,
		});

		if (result.state !== 'completed') {
			await abandonReceipt('peer_task_incomplete');
			return error(res, 502, 'payment_failed', result.receipts?.[0]?.errorReason || `peer task ended in state ${result.state}`, {
				state: result.state,
				receipts: result.receipts || [],
			});
		}

		// Settled. Finalize the receipt with everything needed to audit this payment
		// later without re-reading the peer: who was paid, on what rail, under which
		// mandate, and the signed cart proving what was bought. The owner reads these
		// back from GET /api/agents/:id/solana/custody?category=x402.
		const settlementSignature = result.receipts?.find((r) => r?.transaction)?.transaction || null;
		await updateCustodyEvent(receiptId, {
			status: 'confirmed',
			signature: settlementSignature,
			meta: {
				payer: payerAddress,
				cart_mandate: cartMandateJws,
				peer_receipts: result.receipts || [],
				mandate_spent_atomics: String(reservation.spent),
				mandate_cap_atomics: String(reservation.cap),
			},
		}).catch((e) => console.error('[agents/a2a-call] receipt finalize failed', e?.message || e));

		const artifacts = Array.isArray(result.task?.artifacts) ? result.task.artifacts : [];
		return json(res, 200, {
			ok: true,
			mandate_id: mandate.mandateId,
			agent_id: String(agent.id),
			task_id: quote.taskId,
			amount,
			network,
			currency: cartCurrency,
			payer: payerAddress,
			spent: reservation.spent,
			cap: reservation.cap,
			// The custody-ledger row for this payment. Queryable at
			// GET /api/agents/:id/solana/custody — the durable side of the receipt,
			// where the signed cart below is the portable, verifiable side.
			receipt_id: receiptId != null ? String(receiptId) : null,
			usd: spendUsd,
			// AP2 Cart Mandate: a signed, independently-verifiable proof of this exact
			// transaction (verify via POST /api/agents/a2a-cart-verify).
			cart_mandate: cartMandateJws,
			cart: cartMandate,
			receipts: result.receipts || [],
			artifacts,
		});
	} catch (err) {
		// Any failure after reservation but before a confirmed settlement must
		// release the hold so neither the mandate's budget nor the agent's daily
		// headroom is silently consumed by a payment that never landed.
		await abandonReceipt('settlement_failed');
		if (err instanceof A2AClientError) {
			console.error('[agents/a2a-call] peer payment failed', err?.code, err?.message);
			return serverError(res, 502, err.code || 'payment_failed', err);
		}
		return respondError(res, err.status || 502, 'payment_failed', err);
	}
});
