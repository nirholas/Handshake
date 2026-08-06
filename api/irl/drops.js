/**
 * IRL Money Drops & Bounties — value placed in the real world (Wave II task 06).
 *
 *   GET    /api/irl/drops?lat=&lng=&radius=        live drops near me (presence-gated)
 *   GET    /api/irl/drops?mine=1                   my created drops + my claim receipts
 *   GET    /api/irl/drops/:id                      one drop (public projection)
 *   POST   /api/irl/drops                          create a drop → { drop, escrow_address }
 *                                                  (agent bounties fund server-side, returned active)
 *   POST   /api/irl/drops/:id/fund   { signature } confirm a user-signed funding transfer on-chain
 *   POST   /api/irl/drops/:id/claim  { lat,lng,wallet,answer? }  presence-gated claim → real release
 *   POST   /api/irl/drops/:id/cancel               owner cancels an unclaimed drop → real refund
 *
 * Custody is real (api/_lib/irl-drops.js): a fresh escrow wallet per drop, funded
 * by the creator's own signed transfer (or an agent's spend-limited custodial
 * wallet), confirmed on-chain before claimable; claims release real funds to the
 * claimant's own wallet, presence-proven by the same fix token the nearby read
 * enforces; unclaimed drops auto-refund the creator (cron + owner cancel).
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
	getAssociatedTokenAddress,
	createAssociatedTokenAccountInstruction,
	createTransferInstruction,
} from '@solana/spl-token';

import { cors, json, wrap, error, rateLimited, readJson } from '../_lib/http.js';
import { limits, clientIp, limitFailClosedRead } from '../_lib/rate-limit.js';
import { getSessionUser } from '../_lib/auth.js';
import { readDeviceToken } from '../_lib/irl-auth.js';
import { verifyFixToken, fixEnforced } from '../_lib/irl-presence.js';
import { solanaConnection, loadAgentForSigning } from '../_lib/agent-pumpfun.js';
import { submitProtected } from '../_lib/execution-engine.js';
import { enforceSpendLimit, lamportsToUsd, SpendLimitError } from '../_lib/agent-trade-guards.js';
import { SOLANA_USDC_MINT, SOLANA_USDC_MINT_DEVNET } from '../payments/_config.js';
import { env } from '../_lib/env.js';
import {
	createDrop, confirmFunding, getDropRow, nearbyDrops, myDrops, myClaims,
	reserveClaim, failClaim, confirmClaim, releaseFromEscrow,
	markRefunding, sweepRefund, recordRefundTx, toPublicDrop,
	hasChatSignal, verifyQuiz, haversineM, atomicsToAmount,
	BASE58_RE,
} from '../_lib/irl-drops.js';

const NEARBY_CAP_M = 80; // server-side hard cap on the nearby read radius.
// Single-drop reads are not presence-gated, so a non-owner only ever gets a coarse
// (~110 m, matching the presence token's anchor precision) location — a leaked drop
// id must not reveal the exact spot a stranger placed real money.
const COARSE_DP = 3;

// The stable identity a claim is idempotent against: the authenticated user, else
// the anonymous IRL device token. One claim per identity per drop.
function claimantKeyOf(userId, deviceToken) {
	if (userId) return `u:${userId}`;
	if (deviceToken) return `d:${deviceToken}`;
	return null;
}

function parsePath(req) {
	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean); // ['api','irl','drops', id?, action?]
	return { url, id: parts[3] || null, action: parts[4] || null, query: url.searchParams };
}

// Presence proof: the same fix token the nearby read enforces, bound to the
// caller's claimed point. Returns { ok } or { ok:false, reason }.
async function checkPresence(req, lat, lng) {
	const h = req.headers['x-irl-fix'];
	const token = Array.isArray(h) ? h[0] : h;
	return verifyFixToken(token, lat, lng);
}

export default wrap(async (req, res) => {
	cors(req, res, { methods: ['GET', 'POST', 'OPTIONS'], credentials: true });
	if (req.method === 'OPTIONS') return res.end();

	const { id, action, query } = parsePath(req);
	const session = await getSessionUser(req).catch(() => null);
	const userId = session?.id ?? null;
	const deviceToken = readDeviceToken(req);

	// ── reads ───────────────────────────────────────────────────────────────
	if (req.method === 'GET') {
		// Every drops read either returns a coordinate or is the caller's own data, so
		// the limiter FAILS CLOSED here (H7): a blind limiter on a location read has
		// nothing bounding it downstream, and the backing buckets are in-memory
		// `local` limiters that never touch Redis, so failing closed costs no real
		// availability. See docs/irl/THREAT-MODEL.md.
		const rl = await limitFailClosedRead('publicIp', limits.publicIp, clientIp(req));
		if (!rl.success) return rateLimited(res, rl);

		if (id) {
			const row = await getDropRow(id);
			if (!row) return error(res, 404, 'not_found', 'drop not found');
			const drop = toPublicDrop(row, { viewerKey: deviceToken, viewerUserId: userId });
			// Coarsen the location for anyone but the owner: every other location read in
			// the IRL system is presence-gated (the nearby read needs a fix token bound to
			// where you stand), but this id-addressed read has no presence proof. Precise
			// coordinates are revealed only to the owner or via the presence-gated nearby
			// read when you are physically there.
			if (!drop.is_mine) {
				const plat = Number(drop.lat);
				const plng = Number(drop.lng);
				if (Number.isFinite(plat) && Number.isFinite(plng)) {
					drop.lat = Number(plat.toFixed(COARSE_DP));
					drop.lng = Number(plng.toFixed(COARSE_DP));
					drop.coarse = true;
				}
			}
			return json(res, 200, { drop });
		}

		if (query.get('mine') === '1') {
			if (!userId && !deviceToken) return json(res, 200, { drops: [], claims: [] });
			const [drops, claims] = await Promise.all([
				myDrops({ userId, deviceToken }),
				myClaims({ claimantKey: claimantKeyOf(userId, deviceToken) }),
			]);
			return json(res, 200, { drops, claims });
		}

		const lat = parseFloat(query.get('lat'));
		const lng = parseFloat(query.get('lng'));
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
			return error(res, 400, 'bad_request', 'lat and lng are required');
		}
		// Same dedicated coordinate-read budget as the pins nearby feed: this is a
		// discovery read over other people's placements, so it draws on the /irl
		// location bucket (60/min/IP) rather than only the generic public ceiling.
		const nearbyRl = await limitFailClosedRead('irlNearbyIp', limits.irlNearbyIp, clientIp(req));
		if (!nearbyRl.success) return rateLimited(res, nearbyRl);

		// Same presence gate as the pins nearby read: you only see drops where you
		// stand. Enforced only when proof-of-presence is configured (prod).
		if (fixEnforced()) {
			const v = await checkPresence(req, lat, lng);
			if (!v.ok) return json(res, 401, { error: 'fix_required', reason: v.reason });
		}
		const radius = Math.min(NEARBY_CAP_M, Math.max(10, parseFloat(query.get('radius')) || 60));
		const drops = await nearbyDrops({ lat, lng, radiusM: radius, viewerKey: deviceToken, viewerUserId: userId });
		return json(res, 200, { drops });
	}

	if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method not allowed');

	const rl = await limits.irlPinIp(clientIp(req)).catch(() => ({ success: true }));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try { body = await readJson(req); } catch (err) { return error(res, err.status || 400, 'bad_request', err.message || 'invalid body'); }

	// ── create ────────────────────────────────────────────────────────────────
	if (!id) {
		return handleCreate(req, res, { body, userId, deviceToken, session });
	}

	const row = await getDropRow(id);
	if (!row) return error(res, 404, 'not_found', 'drop not found');

	if (action === 'fund') return handleFund(req, res, { row, body, userId, deviceToken });
	if (action === 'claim') return handleClaim(req, res, { row, body, userId, deviceToken });
	if (action === 'cancel') return handleCancel(req, res, { row, userId, deviceToken });
	return error(res, 404, 'not_found', 'unknown drop action');
});

// ── create ──────────────────────────────────────────────────────────────────
async function handleCreate(req, res, { body, userId, deviceToken, session }) {
	const agentId = typeof body?.agentId === 'string' ? body.agentId : null;

	// Agent-posted bounty: owner-armed, spend-limited, funded server-side from the
	// agent's custodial wallet and returned already active.
	if (agentId) {
		if (!userId) return error(res, 401, 'auth_required', 'sign in to arm an agent bounty');
		return handleAgentBounty(req, res, { body, userId, agentId });
	}

	if (!userId && !deviceToken) {
		return error(res, 401, 'auth_required', 'connect a wallet or enable presence to drop money');
	}

	let result;
	try {
		result = await createDrop({
			creatorUserId: userId,
			creatorDevice: userId ? null : deviceToken,
			kind: body?.kind === 'bounty' ? 'bounty' : 'drop',
			asset: body?.asset,
			amount: body?.amount,
			maxClaims: body?.maxClaims,
			claimRule: body?.claimRule,
			bountyCondition: body?.bountyCondition,
			quizQuestion: body?.quizQuestion,
			quizAnswer: body?.quizAnswer,
			title: body?.title,
			note: body?.note,
			lat: Number(body?.lat),
			lng: Number(body?.lng),
			radiusM: Number(body?.radiusM),
			expiresInMs: Number(body?.expiresInMs),
			refundAddress: body?.refundAddress || null,
			network: 'mainnet',
		});
	} catch (e) {
		if (e.status) return error(res, e.status, e.code || 'bad_request', e.message);
		throw e;
	}
	return json(res, 201, {
		drop: toPublicDrop(result.drop, { viewerKey: deviceToken, viewerUserId: userId }),
		escrow_address: result.escrowAddress,
		fund_atomics: result.total.toString(),
		fund_amount: atomicsToAmount(result.total, result.drop.asset),
	});
}

// ── agent bounty (server-funded from the agent's custodial wallet) ─────────────
async function handleAgentBounty(req, res, { body, userId, agentId }) {
	const loaded = await loadAgentForSigning(agentId, userId, { reason: 'irl_bounty_fund' });
	if (loaded.error) return error(res, loaded.error.status, loaded.error.code, loaded.error.msg);
	const { agent, keypair, meta } = loaded;
	const refundAddress = keypair.publicKey.toBase58();

	let result;
	try {
		result = await createDrop({
			creatorUserId: userId,
			creatorAgentId: agentId,
			kind: 'bounty',
			asset: body?.asset,
			amount: body?.amount,
			maxClaims: body?.maxClaims,
			claimRule: body?.claimRule,
			bountyCondition: body?.bountyCondition || 'presence',
			quizQuestion: body?.quizQuestion,
			quizAnswer: body?.quizAnswer,
			title: body?.title,
			note: body?.note,
			lat: Number(body?.lat),
			lng: Number(body?.lng),
			radiusM: Number(body?.radiusM),
			expiresInMs: Number(body?.expiresInMs),
			refundAddress,
			network: 'mainnet',
		});
	} catch (e) {
		if (e.status) return error(res, e.status, e.code || 'bad_request', e.message);
		throw e;
	}
	const { drop, escrowAddress, total } = result;

	// Spend policy: priced in USD where we can, so the daily ceiling / freeze /
	// allowlist apply uniformly to a bounty just like a trade or withdraw.
	let usdValue = null;
	try {
		if (drop.asset === 'SOL') usdValue = await lamportsToUsd(total);
		else if (drop.asset === 'USDC') usdValue = Number(atomicsToAmount(total, 'USDC'));
	} catch { usdValue = null; }
	try {
		// Enforces frozen / per-tx / daily-ceiling / allowlist uniformly (reads
		// getSpendLimits(meta) internally), exactly like a trade or withdraw.
		await enforceSpendLimit({ agentId, meta, category: 'irl_drop', usdValue, destination: escrowAddress, network: 'mainnet' });
	} catch (e) {
		if (e instanceof SpendLimitError) {
			await sql_cancelUnfunded(drop.id);
			return error(res, e.status || 403, e.code || 'spend_limit', e.message, e.detail || {});
		}
		if (e?.status) { await sql_cancelUnfunded(drop.id); return error(res, e.status, e.code || 'bad_request', e.message); }
		throw e;
	}

	// Real on-chain funding from the agent wallet into the escrow (agent pays fee).
	let signature;
	try {
		signature = await fundEscrowFromAgent({ keypair, escrowAddress, asset: drop.asset, atomics: total, network: 'mainnet' });
	} catch (e) {
		await sql_cancelUnfunded(drop.id);
		return error(res, e.status || 502, e.code || 'funding_failed', `agent funding failed: ${e.message || e}`);
	}

	try {
		await confirmFunding({ drop, signature, refundAddress });
	} catch (e) {
		// Funds did move to the escrow; the auto-refund path will return them. Surface
		// the confirm error but the money is accounted for (escrow → refund on expiry).
		return error(res, e.status || 502, e.code || 'confirm_failed', e.message || 'funding confirm failed');
	}
	const fresh = await getDropRow(drop.id);
	return json(res, 201, {
		drop: toPublicDrop(fresh, { viewerUserId: userId }),
		escrow_address: escrowAddress,
		funding_tx: signature,
		funded: true,
		agent: { id: agentId, name: agent.name || agent.display_name || null },
	});
}

async function sql_cancelUnfunded(dropId) {
	const { sql } = await import('../_lib/db.js');
	await sql`UPDATE irl_drops SET status = 'cancelled', updated_at = now() WHERE id = ${dropId} AND status = 'pending_funding'`;
}

function usdcMintFor(network) {
	return network === 'devnet' ? SOLANA_USDC_MINT_DEVNET : SOLANA_USDC_MINT;
}
function mintFor(asset, network) {
	if (asset === 'USDC') return usdcMintFor(network);
	if (asset === 'THREE') return env.THREE_TOKEN_MINT;
	return null;
}

async function fundEscrowFromAgent({ keypair, escrowAddress, asset, atomics, network }) {
	const conn = solanaConnection(network);
	const recipient = new PublicKey(escrowAddress);
	const amount = BigInt(atomics);
	const instructions = [];
	if (asset === 'SOL') {
		instructions.push(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: recipient, lamports: amount }));
	} else {
		const mint = new PublicKey(mintFor(asset, network));
		const fromATA = await getAssociatedTokenAddress(mint, keypair.publicKey);
		const toATA = await getAssociatedTokenAddress(mint, recipient);
		if (!(await conn.getAccountInfo(toATA))) {
			instructions.push(createAssociatedTokenAccountInstruction(keypair.publicKey, toATA, recipient, mint));
		}
		instructions.push(createTransferInstruction(fromATA, toATA, keypair.publicKey, amount));
	}
	const { signature } = await submitProtected({ network, connection: conn, payer: keypair, instructions });
	return signature;
}

// ── fund (confirm a user-signed transfer) ─────────────────────────────────────
async function handleFund(req, res, { row, body, userId, deviceToken }) {
	if (!isOwner(row, userId, deviceToken)) return error(res, 403, 'forbidden', 'only the creator can fund this drop');
	try {
		const result = await confirmFunding({ drop: row, signature: body?.signature, refundAddress: body?.refundAddress || null });
		if (result.pending) return json(res, 202, { pending: true, status: result.status });
		const fresh = await getDropRow(row.id);
		return json(res, 200, { drop: toPublicDrop(fresh, { viewerKey: deviceToken, viewerUserId: userId }), funding_tx: result.funding_tx });
	} catch (e) {
		if (e.status) return error(res, e.status, e.code || 'bad_request', e.message);
		throw e;
	}
}

// ── claim ─────────────────────────────────────────────────────────────────────
async function handleClaim(req, res, { row, body, userId, deviceToken }) {
	const claimWallet = String(body?.wallet || '').trim();
	if (!BASE58_RE.test(claimWallet)) return error(res, 400, 'invalid_wallet', 'a valid Solana wallet is required to claim');
	const lat = Number(body?.lat);
	const lng = Number(body?.lng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return error(res, 400, 'bad_request', 'your current location is required to claim');

	const claimantKey = claimantKeyOf(userId, deviceToken);
	if (!claimantKey) return error(res, 401, 'auth_required', 'connect a wallet or enable presence to claim');

	if (row.status !== 'active') {
		return error(res, 409, 'not_claimable', row.status === 'exhausted' ? 'this drop has been fully claimed' : `this drop is ${row.status}`);
	}
	if (new Date(row.expires_at).getTime() <= Date.now()) return error(res, 410, 'expired', 'this drop has expired');

	// Presence proof — ALWAYS verified (the whole point of an IRL drop). Bound to
	// the caller's claimed point; the same token the nearby read trusts.
	const presence = await checkPresence(req, lat, lng);
	if (!presence.ok) return error(res, 401, 'fix_required', presenceMessage(presence.reason), { reason: presence.reason });

	// Inside the drop's radius (measured from the real, unrounded server coords).
	const distance = haversineM(lat, lng, row.lat, row.lng);
	if (distance > row.radius_m) {
		return error(res, 403, 'out_of_range', `you're ${Math.round(distance)} m away — get within ${Math.round(row.radius_m)} m to claim`, {
			distance_m: Math.round(distance), radius_m: Math.round(row.radius_m),
		});
	}

	// Bounty completion condition against real signals.
	if (row.kind === 'bounty' && row.bounty_condition && row.bounty_condition !== 'presence') {
		if (row.bounty_condition === 'quiz') {
			const ok = await verifyQuiz({ drop: row, answer: body?.answer });
			if (!ok) return error(res, 422, 'wrong_answer', "that's not the answer — try again");
		} else if (row.bounty_condition === 'chat') {
			const ok = await hasChatSignal({ agentId: row.creator_agent_id, claimantUserId: userId, claimantDevice: deviceToken });
			if (!ok) return error(res, 422, 'condition_unmet', 'chat with the agent first, then claim');
		}
	}

	// Atomic reservation — serialized per drop, idempotent per claimant.
	let reserved;
	try {
		reserved = await reserveClaim({
			dropId: row.id,
			claimantUserId: userId,
			claimantDevice: userId ? null : deviceToken,
			claimantKey,
			claimWallet,
		});
	} catch (e) {
		if (e.status) return error(res, e.status, e.code || 'bad_request', e.message);
		throw e;
	}
	if (!reserved.ok) {
		const map = {
			already_claimed: [409, 'already_claimed', 'you already claimed this drop'],
			exhausted: [409, 'exhausted', 'this drop has been fully claimed'],
			expired: [410, 'expired', 'this drop has expired'],
			inactive: [409, 'not_claimable', 'this drop is no longer claimable'],
			not_found: [404, 'not_found', 'drop not found'],
			unavailable: [409, 'not_claimable', 'this drop is no longer claimable'],
		};
		const [s, c, m] = map[reserved.reason] || map.unavailable;
		return error(res, s, c, m);
	}

	// Real on-chain release to the claimant's own wallet.
	let signature;
	try {
		signature = await releaseFromEscrow({ drop: row, toAddress: claimWallet, atomics: reserved.amount_atomics });
	} catch (e) {
		await failClaim({ dropId: row.id, claimId: reserved.claimId });
		return error(res, e.status || 502, e.code || 'release_failed', `couldn't release the funds — your slot was freed, try again. (${e.message || e})`);
	}
	await confirmClaim({ claimId: reserved.claimId, signature });

	if (row.creator_agent_id) {
		import('../_lib/agent-trade-guards.js').then(({ recordCustodyEvent }) => recordCustodyEvent({
			agentId: row.creator_agent_id, userId: row.creator_user_id, eventType: 'spend', category: 'irl_drop',
			network: row.network, asset: row.asset, signature, destination: claimWallet, status: 'confirmed',
			reason: 'irl_bounty_payout', meta: { drop_id: row.id, claim_id: String(reserved.claimId) },
		})).catch(() => {});
	}

	const cluster = row.network === 'devnet' ? '?cluster=devnet' : '';
	return json(res, 200, {
		ok: true,
		asset: row.asset,
		amount: atomicsToAmount(reserved.amount_atomics, row.asset),
		signature,
		explorer_url: `https://solscan.io/tx/${signature}${cluster}`,
		wallet: claimWallet,
	});
}

function presenceMessage(reason) {
	switch (reason) {
		case 'expired': return 'your location proof expired — move and try again';
		case 'out_of_area': return "you're not standing near this drop";
		case 'missing': return 'turn on location to prove you are here';
		default: return 'a fresh location fix is required to claim';
	}
}

// ── cancel / refund ───────────────────────────────────────────────────────────
async function handleCancel(req, res, { row, userId, deviceToken }) {
	if (!isOwner(row, userId, deviceToken)) return error(res, 403, 'forbidden', 'only the creator can cancel this drop');
	if (row.status === 'refunded') {
		return json(res, 200, { ok: true, refunded: true, refund_tx: row.refund_tx });
	}
	if (!['active', 'exhausted', 'expired', 'pending_funding'].includes(row.status)) {
		return error(res, 409, 'not_cancellable', `this drop is ${row.status}`);
	}

	// Pending-funding drops never moved money — just void them.
	if (row.status === 'pending_funding') {
		await sql_cancelUnfunded(row.id);
		return json(res, 200, { ok: true, cancelled: true });
	}

	const locked = await markRefunding({ dropId: row.id, allowActive: true });
	if (!locked) {
		const fresh = await getDropRow(row.id);
		if (fresh?.status === 'refunded') return json(res, 200, { ok: true, refunded: true, refund_tx: fresh.refund_tx });
		return error(res, 409, 'not_cancellable', 'this drop could not be cancelled');
	}
	try {
		const refundTx = await sweepRefund({ drop: locked });
		await recordRefundTx({ dropId: row.id, refundTx });
		const cluster = row.network === 'devnet' ? '?cluster=devnet' : '';
		return json(res, 200, {
			ok: true, refunded: true, refund_tx: refundTx,
			explorer_url: refundTx && refundTx !== 'empty' ? `https://solscan.io/tx/${refundTx}${cluster}` : null,
		});
	} catch (e) {
		// Status is already 'refunded' (CAS) but the sweep failed — the cron retry
		// will complete it (recordRefundTx only writes when null). Surface the error.
		return error(res, e.status || 502, e.code || 'refund_failed', `refund sweep failed, it will retry automatically (${e.message || e})`);
	}
}

function isOwner(row, userId, deviceToken) {
	if (userId && row.creator_user_id === userId) return true;
	if (deviceToken && row.creator_device === deviceToken) return true;
	return false;
}
