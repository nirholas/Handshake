// IRL Money Drops & Bounties — the SDK twin of /api/irl/drops. Real value
// escrowed at a real-world spot: create a drop, fund its fresh escrow wallet
// on-chain, and anyone who physically walks up (proven by the same fix token
// the nearby read enforces) claims a release to their own wallet.

import { ThreeWsError } from './http.js';
import { presenceFix, fixHeader, prune, normalizeEnum, requireId } from './shared.js';

const DROP_KINDS = ['drop', 'bounty'];
const DROP_ASSETS = ['SOL', 'USDC', 'THREE'];
const CLAIM_RULES = ['first', 'each-once', 'quiz'];
const BOUNTY_CONDITIONS = ['presence', 'quiz', 'chat'];

// Base58 shape of a Solana address — the claim wallet is validated before any
// network round-trip so a typo fails fast, not at the release step.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Build the drops slice of the IRL client. `request` is the bound HTTP core and
 * `deviceHeader` merges the caller's anonymous device token into headers.
 */
export function createDropsApi({ request, deviceHeader }) {
	/**
	 * Live drops within the radius of where you checked in. Wraps
	 * `GET /api/irl/drops?lat=&lng=&radius=` with the presence token in the
	 * `x-irl-fix` header — like every IRL location read, you only see drops
	 * where you physically stand. Radius is clamped server-side to 10–80 m.
	 */
	async function nearbyDrops(presence, opts = {}) {
		const { lat, lng, token } = presenceFix(presence, 'nearbyDrops()');
		const radius = opts.radius;
		if (radius !== undefined && !Number.isFinite(radius)) {
			throw new ThreeWsError('nearbyDrops() radius must be a finite number of metres.', { code: 'invalid_input' });
		}
		const res = await request('/api/irl/drops', {
			query: { lat, lng, radius },
			headers: deviceHeader(opts, fixHeader(token, opts.headers)),
			signal: opts.signal,
		});
		return (res?.drops || []).map(shapeDrop);
	}

	/**
	 * One drop by id (public projection). Not presence-gated, so for anyone but
	 * the owner the location comes back coarsened to ~110 m (`coarse: true`) —
	 * a leaked id never reveals the exact spot someone placed real money.
	 */
	async function getDrop(id, opts = {}) {
		requireId(id, 'getDrop()');
		const res = await request(`/api/irl/drops/${encodeURIComponent(id)}`, {
			headers: deviceHeader(opts),
			signal: opts.signal,
		});
		return shapeDrop(res?.drop);
	}

	/**
	 * The caller's created drops (every status) plus their claim receipts.
	 * Wraps `GET /api/irl/drops?mine=1` — identity is the signed-in session or
	 * the anonymous device token.
	 */
	async function myDrops(opts = {}) {
		const res = await request('/api/irl/drops', {
			query: { mine: '1' },
			headers: deviceHeader(opts),
			signal: opts.signal,
		});
		return {
			drops: (res?.drops || []).map(shapeDrop),
			claims: (res?.claims || []).map(shapeClaim),
			raw: res,
		};
	}

	/**
	 * Place value in the real world. Wraps `POST /api/irl/drops`.
	 *
	 * Two funding paths:
	 * - Default: returns `{ drop (pending_funding), escrowAddress, fundAmount }` —
	 *   send the funds to `escrowAddress` from your own wallet, then call
	 *   `fundDrop({ dropId, signature })` with the transfer signature to activate.
	 * - With `agentId` (signed-in owner): the agent's custodial wallet funds the
	 *   escrow server-side under its spend limits — returns already active with
	 *   `funded: true` and the on-chain `fundingTx`.
	 */
	async function createDrop(input, opts = {}) {
		const p = input || {};
		const lat = Number(p.lat);
		const lng = Number(p.lng);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
			throw new ThreeWsError('createDrop() needs finite `lat` and `lng`.', { code: 'invalid_input' });
		}
		if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
			throw new ThreeWsError('createDrop() coordinates are out of range.', { code: 'invalid_input' });
		}
		const amount = Number(p.amount);
		if (!Number.isFinite(amount) || amount <= 0) {
			throw new ThreeWsError('createDrop() needs a positive `amount`.', { code: 'invalid_input' });
		}
		const asset = p.asset === undefined ? undefined
			: normalizeEnum(String(p.asset).toUpperCase(), DROP_ASSETS, 'asset');
		const kind = normalizeEnum(p.kind, DROP_KINDS, 'kind');
		const claimRule = normalizeEnum(p.claimRule, CLAIM_RULES, 'claimRule');
		const bountyCondition = normalizeEnum(p.bountyCondition, BOUNTY_CONDITIONS, 'bountyCondition');

		const body = prune({
			kind,
			asset,
			amount,
			maxClaims: p.maxClaims,
			claimRule,
			bountyCondition,
			quizQuestion: p.quizQuestion,
			quizAnswer: p.quizAnswer,
			title: p.title,
			note: p.note,
			lat,
			lng,
			radiusM: p.radiusM,
			expiresInMs: p.expiresInMs,
			refundAddress: p.refundAddress,
			agentId: p.agentId,
		});
		const res = await request('/api/irl/drops', {
			method: 'POST',
			body,
			headers: deviceHeader(opts),
			signal: opts.signal,
		});
		return {
			drop: shapeDrop(res?.drop),
			escrowAddress: res?.escrow_address ?? null,
			fundAtomics: res?.fund_atomics ?? null,
			fundAmount: res?.fund_amount ?? null,
			funded: Boolean(res?.funded),
			fundingTx: res?.funding_tx ?? null,
			agent: res?.agent ?? null,
			raw: res,
		};
	}

	/**
	 * Confirm a user-signed funding transfer on-chain and activate the drop.
	 * Wraps `POST /api/irl/drops/:id/fund`. Returns `{ pending: true }` (202)
	 * while the transfer is still confirming — retry shortly.
	 */
	async function fundDrop(input, opts = {}) {
		const p = input || {};
		const dropId = requireId(p.dropId ?? p.id, 'fundDrop()');
		if (!p.signature || typeof p.signature !== 'string') {
			throw new ThreeWsError('fundDrop() needs the funding transfer `signature`.', { code: 'invalid_input' });
		}
		const res = await request(`/api/irl/drops/${encodeURIComponent(dropId)}/fund`, {
			method: 'POST',
			body: prune({ signature: p.signature, refundAddress: p.refundAddress }),
			headers: deviceHeader(opts),
			signal: opts.signal,
		});
		return {
			pending: Boolean(res?.pending),
			status: res?.status ?? null,
			drop: res?.drop ? shapeDrop(res.drop) : null,
			fundingTx: res?.funding_tx ?? null,
			raw: res,
		};
	}

	/**
	 * Claim a drop you are physically standing at — a real on-chain release to
	 * YOUR wallet. Wraps `POST /api/irl/drops/:id/claim`; the presence token is
	 * always verified, and the claimed point must be inside the drop's radius.
	 * Quiz bounties also need the `answer`.
	 */
	async function claimDrop(input, opts = {}) {
		const p = input || {};
		const dropId = requireId(p.dropId ?? p.id, 'claimDrop()');
		const { lat, lng, token } = presenceFix(p.presence, 'claimDrop()');
		const wallet = typeof p.wallet === 'string' ? p.wallet.trim() : '';
		if (!BASE58_RE.test(wallet)) {
			throw new ThreeWsError('claimDrop() needs a valid Solana `wallet` to receive the funds.', { code: 'invalid_input' });
		}
		const res = await request(`/api/irl/drops/${encodeURIComponent(dropId)}/claim`, {
			method: 'POST',
			body: prune({ lat, lng, wallet, answer: p.answer }),
			headers: deviceHeader(opts, fixHeader(token)),
			signal: opts.signal,
		});
		return {
			ok: Boolean(res?.ok),
			asset: res?.asset ?? null,
			amount: res?.amount ?? null,
			signature: res?.signature ?? null,
			explorerUrl: res?.explorer_url ?? null,
			wallet: res?.wallet ?? wallet,
			raw: res,
		};
	}

	/**
	 * Cancel an unclaimed drop you created — a real on-chain refund sweep back
	 * to your refund address. Wraps `POST /api/irl/drops/:id/cancel`. Idempotent:
	 * an already-refunded drop returns `{ ok, refunded: true }` with the tx.
	 */
	async function cancelDrop(id, opts = {}) {
		requireId(id, 'cancelDrop()');
		const res = await request(`/api/irl/drops/${encodeURIComponent(id)}/cancel`, {
			method: 'POST',
			headers: deviceHeader(opts),
			signal: opts.signal,
		});
		return {
			ok: Boolean(res?.ok),
			cancelled: Boolean(res?.cancelled),
			refunded: Boolean(res?.refunded),
			refundTx: res?.refund_tx ?? null,
			explorerUrl: res?.explorer_url ?? null,
			raw: res,
		};
	}

	return { nearbyDrops, getDrop, myDrops, createDrop, fundDrop, claimDrop, cancelDrop };
}

// ── Response shaping (snake_case → camelCase, with a .raw escape hatch) ──────

// A drop from the public projection (api/_lib/irl-drops.js toPublicDrop).
function shapeDrop(r) {
	if (!r || typeof r !== 'object') return r;
	return {
		id: r.id,
		kind: r.kind,
		asset: r.asset,
		amount: r.amount,
		amountAtomics: r.amount_atomics ?? null,
		maxClaims: Number(r.max_claims) || 0,
		claimsCount: Number(r.claims_count) || 0,
		claimsLeft: Number(r.claims_left) || 0,
		claimRule: r.claim_rule ?? null,
		bountyCondition: r.bounty_condition ?? null,
		quizQuestion: r.quiz_question ?? null,
		title: r.title ?? null,
		note: r.note ?? null,
		lat: r.lat,
		lng: r.lng,
		radiusM: r.radius_m ?? null,
		// Metres from your fix (nearby read only).
		distanceM: r.distance_m ?? null,
		// True when the location was coarsened to ~110 m for a non-owner id read.
		coarse: Boolean(r.coarse),
		network: r.network ?? null,
		status: r.status ?? null,
		escrowAddress: r.escrow_address ?? null,
		fundingTx: r.funding_tx ?? null,
		refundTx: r.refund_tx ?? null,
		expiresAt: r.expires_at ?? null,
		createdAt: r.created_at ?? null,
		isMine: Boolean(r.is_mine),
		raw: r,
	};
}

// A claim receipt from `myDrops().claims`.
function shapeClaim(r) {
	if (!r || typeof r !== 'object') return r;
	return {
		id: r.id,
		dropId: r.drop_id,
		title: r.title ?? null,
		kind: r.kind ?? null,
		asset: r.asset ?? null,
		amount: r.amount ?? null,
		signature: r.signature ?? null,
		status: r.status ?? null,
		network: r.network ?? null,
		createdAt: r.created_at ?? null,
		confirmedAt: r.confirmed_at ?? null,
		raw: r,
	};
}
