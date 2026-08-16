/**
 * Living Stages: record a real $THREE tip and make the host react (Moonshot 04).
 *
 * The audience member transfers $THREE (or USDC, where the platform's pay path
 * already allows it) directly to the host agent's wallet on-chain, then POSTs the
 * settlement signature here. This endpoint:
 *   1. validates the settlement signature + the $THREE/USDC mint + the atomic
 *      amount, then VERIFIES the transfer on-chain: the referenced transaction
 *      must really have credited the host's wallet with at least the amount
 *      claimed. Shape validation alone (what this did before the 2026-08-06
 *      security review, M4) let anyone POST a well-formed but unrelated signature
 *      with a huge amount and buy the top of the leaderboard plus a host
 *      shout-out for free,
 *   2. is IDEMPOTENT per signature: one settlement records exactly one tip row
 *      (a unique index + ON CONFLICT DO NOTHING is the guarantee, so a client
 *      retry returns the existing row, never a double-credit),
 *   3. computes the host/venue accounting split (the full amount already landed
 *      in the host wallet on-chain; the split records what is owed onward),
 *   4. rolls the show total, and
 *   5. pushes the tip to the live StageRoom over the signed /internal/stage
 *      bridge so the host pre-empts its next beat and shouts the tipper out in ~1s.
 *
 *   POST /api/stage/tip { stageId, signature, currencyMint, amount, message?,
 *                         network?, tipperName?, tipperSession? }
 *   GET  /api/stage/tip?stageId=<id>   → current-show leaderboard + total
 *
 * Never trusts a client-asserted tip without a verifiable settlement. $THREE is
 * the only coin this platform promotes.
 */

import { cors, json, wrap, readJson, rateLimited } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { insertNotification } from '../_lib/notify.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { validateTipPayload, splitTip, tipExplorerUrl } from '../_lib/stage-split.js';
import { notifyStageRoom } from '../_lib/stage-bridge.js';
import { verifySettlement } from '../_lib/settlement-verify.js';
import { hostPayoutWallets } from '../_lib/stage-wallets.js';

const MAX_MESSAGE = 140;
// A tip is "loud" when it clears 10k $THREE (6 decimals), worth a Telegram ping.
const LOUD_TIP_ATOMIC = 10_000 * 1_000_000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	if (req.method === 'GET') return handleGet(req, res);
	if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

	const rl = await limits.stageTipIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req, 20_000);
	} catch (e) {
		return json(res, e.status || 400, { error: e.message || 'bad_request' });
	}

	const stageId = body.stageId;
	if (!isUuid(stageId)) return json(res, 400, { error: 'invalid stage id' });

	// A cookie-borne (session) request is a CSRF target; an anonymous,
	// settlement-proven tip has no ambient credential to abuse, so it is allowed
	// without CSRF (the on-chain signature is the proof), the same posture as the IRL
	// anonymous pay path. When signed in, enforce CSRF + attribute the tipper.
	const session = await getSessionUser(req).catch(() => null);
	if (session && !(await requireCsrf(req, res, session.id))) return;

	const valid = validateTipPayload({
		signature: body.signature,
		currencyMint: body.currencyMint,
		amount: body.amount,
		network: body.network,
	});
	if (!valid.ok) return json(res, 400, { error: valid.error });

	// Load the stage + its open show. A tip must land on a live show so it joins
	// the right ledger + reaches the room the host is performing in.
	const [stage] = await sql`
		SELECT s.id, s.agent_id, s.owner_user_id, s.tip_split_bps, s.title
		FROM stages s WHERE s.id = ${stageId} LIMIT 1
	`;
	if (!stage) return json(res, 404, { error: 'stage not found' });
	const [show] = await sql`
		SELECT id FROM shows WHERE stage_id = ${stageId} AND ended_at IS NULL
		ORDER BY started_at DESC LIMIT 1
	`;
	if (!show) return json(res, 409, { error: 'no live show, tips open when the host goes live' });

	const label = tipperLabel(session, body.tipperName);
	const { hostCredit, venueCut, splitBps } = splitTip(valid.amount, stage.tip_split_bps);
	const network = valid.network;
	const message = cleanMessage(body.message);

	// Prove it. The host's own payout wallets are the only acceptable destination
	// (they are what the tip UI is handed as the transfer target), and the
	// transaction must have credited at least the amount claimed.
	const recipients = await hostPayoutWallets(stage.agent_id);
	const proof = await verifySettlement({
		signature: valid.signature,
		mint: valid.mint,
		amountAtomic: valid.amount,
		recipients,
		network,
	});
	if (proof.status === 'mismatch') {
		return json(res, 402, {
			error: 'settlement_unverified',
			message: proof.reason || 'that settlement does not pay this host',
		});
	}
	const verified = proof.status === 'match';

	// Idempotent insert: the unique index on settlement_sig makes a retry a no-op.
	// A returned row means this is the FIRST time we've seen this settlement.
	// An unverified row is quarantined: it counts for nothing until the chain
	// catches up (see promoteTip / api/cron/settlement-verify.js).
	const [row] = await sql`
		INSERT INTO show_tips
			(show_id, stage_id, tipper_user_id, tipper_label, amount_atomic, currency_mint,
			 host_credit_atomic, venue_cut_atomic, settlement_sig, network, message, verified_at)
		VALUES (
			${show.id}, ${stageId}, ${session?.id ?? null}, ${label},
			${valid.amount}, ${valid.mint}, ${hostCredit}, ${venueCut},
			${valid.signature}, ${network}, ${message}, ${verified ? new Date().toISOString() : null}
		)
		ON CONFLICT (settlement_sig) DO NOTHING
		RETURNING id, amount_atomic, host_credit_atomic, venue_cut_atomic, created_at
	`;
	if (!row) {
		// Already recorded. If that row is still quarantined and the chain has now
		// shown us the transfer, promote it here: a re-POST is the client's own
		// retry path and must not need the sweep to run first.
		const [existing] = await sql`
			SELECT id, amount_atomic, host_credit_atomic, venue_cut_atomic, verified_at
			FROM show_tips WHERE settlement_sig = ${valid.signature} LIMIT 1
		`;
		if (existing && !existing.verified_at && verified) {
			await promoteTip({ tipId: existing.id, showId: show.id, amount: valid.amount });
		}
		return json(res, 200, {
			ok: true,
			deduped: true,
			pending: !!existing && !existing.verified_at && !verified,
			tip: shapeTip(existing),
		});
	}

	const explorer = tipExplorerUrl(valid.signature, network);

	if (!verified) {
		// Real money may well be in flight; the RPC just has not caught up. Keep the
		// row, count nothing, and tell the client so it can retry or poll.
		return json(res, 202, {
			ok: true,
			pending: true,
			message: 'settlement not visible on-chain yet, this tip counts as soon as it is',
			tip: shapeTip(row),
			explorer,
		});
	}

	// Roll the show total (the row is already written, so a failed bump is logged,
	// never fatal: the per-tip rows remain the source of truth for the leaderboard).
	// Awaited like promoteTip does it: an unawaited write can be lost when the
	// container is reclaimed right after the response, which would understate the
	// running total for the rest of the show.
	await sql`
		UPDATE shows SET total_tips_atomic = total_tips_atomic + ${valid.amount}, tip_count = tip_count + 1
		WHERE id = ${show.id}
	`.catch((err) => console.warn('[stage/tip] show total bump failed', { showId: show.id, reason: err?.message }));

	// Notify the owner (in-app bell always; Telegram for a loud one).
	if (stage.owner_user_id) {
		insertNotification(stage.owner_user_id, 'stage_tip', {
			stage_id: stageId,
			agent_id: stage.agent_id,
			amount: valid.amount,
			currency_mint: valid.mint,
			from: label,
			message,
			link: explorer || `/stage?id=${stageId}`,
		});
	}
	if (valid.amount >= LOUD_TIP_ATOMIC) {
		sendOpsAlert(
			'Big stage tip',
			`${label} tipped ${valid.amount} (atomic) on "${stage.title}". /stage?id=${stageId}`,
			{ signature: `stage-tip:${valid.signature}` },
		);
	}

	// Push to the live room so the host reacts within ~1s. Best-effort: the money
	// already settled on-chain + recorded here, so a missed push loses only the
	// in-room flourish, never funds.
	const pushed = await notifyStageRoom(stageId, 'tip', {
		tip: {
			tipperId: session?.id || label,
			tipperSession: typeof body.tipperSession === 'string' ? body.tipperSession.slice(0, 64) : null,
			label,
			amount: valid.amount,
			mint: valid.mint,
			message,
			signature: valid.signature,
			explorer,
		},
	});

	return json(res, 201, {
		ok: true,
		tip: shapeTip(row),
		split: { hostCredit, venueCut, splitBps },
		reacted: pushed?.delivered ?? false,
		explorer,
	});
});

async function handleGet(req, res) {
	const stageId = req.query.stageId;
	if (!isUuid(stageId)) return json(res, 400, { error: 'invalid stage id' });
	const [show] = await sql`
		SELECT id, total_tips_atomic, tip_count FROM shows
		WHERE stage_id = ${stageId}
		ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT 1
	`;
	if (!show) {
		// no-store like the populated branch: a stage that has not opened its first
		// show yet must not be edge-cached as empty for the moment it goes live.
		return json(res, 200, { leaderboard: [], totalTipsAtomic: 0, tipCount: 0 }, { 'cache-control': 'no-store' });
	}
	// Verified tips only: a quarantined row must never reach a public total.
	const rows = await sql`
		SELECT COALESCE(tipper_label, 'someone') AS label,
			SUM(amount_atomic)::numeric AS total, COUNT(*)::int AS count, MIN(created_at) AS first_at
		FROM show_tips WHERE show_id = ${show.id} AND verified_at IS NOT NULL
		GROUP BY COALESCE(tipper_label, 'someone')
		ORDER BY total DESC, first_at ASC LIMIT 10
	`;
	return json(res, 200, {
		leaderboard: rows.map((r) => ({ label: r.label, total: Number(r.total), count: r.count })),
		totalTipsAtomic: Number(show.total_tips_atomic || 0),
		tipCount: show.tip_count ?? 0,
	}, { 'cache-control': 'no-store' });
}

// Mark a quarantined tip verified and roll it into the show total, exactly once.
// The conditional UPDATE is the guard: whoever flips verified_at from null owns
// the total bump, so the client retry and the sweep can both call this safely.
export async function promoteTip({ tipId, showId, amount }) {
	const [claimed] = await sql`
		UPDATE show_tips SET verified_at = now(), verify_error = NULL
		WHERE id = ${tipId} AND verified_at IS NULL
		RETURNING id
	`;
	if (!claimed) return false;
	await sql`
		UPDATE shows SET total_tips_atomic = total_tips_atomic + ${amount}, tip_count = tip_count + 1
		WHERE id = ${showId}
	`.catch((err) => console.warn('[stage/tip] show total bump failed', { showId, reason: err?.message }));
	return true;
}

function tipperLabel(session, tipperName) {
	if (session?.display_name) return cleanLabel(session.display_name);
	if (session?.email) return cleanLabel(session.email.split('@')[0]);
	const n = cleanLabel(tipperName);
	return n || 'someone';
}

function cleanLabel(v) {
	if (typeof v !== 'string') return '';
	return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
}

function cleanMessage(v) {
	if (typeof v !== 'string') return null;
	const m = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
	return m || null;
}

function shapeTip(r) {
	if (!r) return null;
	return {
		id: r.id,
		amount: Number(r.amount_atomic),
		hostCredit: Number(r.host_credit_atomic),
		venueCut: Number(r.venue_cut_atomic),
	};
}
