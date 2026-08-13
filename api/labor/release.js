// POST /api/labor/release: a platform moderator force-resolves a bounty's
// on-chain escrow WITHOUT ever holding or seeing the escrow private key.
//
// The escrow secret lives only on the server (LABOR_ESCROW_SECRET_BASE58). A
// moderator never owns it, never sees it, and never signs an escrow transaction
// themselves: they authorize the move through their authenticated admin session
// and the server signs. This is the human-override lane on top of the autonomous
// verifier-gated settlement: use it to resolve a stuck or disputed bounty.
//
//   action: 'release' → pay the awarded worker (+ skill royalty + poster surplus)
//   action: 'refund'  → return the full reward to the poster (no worker blame)
//
// Both reuse runSettlement with a forced verdict, so every payout leg, the
// settle_key idempotency guard (a retry never double-pays), and the on-chain
// invocation receipt are identical to the autonomous path. An open bounty with
// no awarded worker can only be refunded.

import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { requireAdmin, isAdminRequest } from '../_lib/admin.js';
import { requireUuid } from '../_lib/labor-auth.js';
import {
	getBounty, getJobByBounty, getJob, markJobDelivered, setBountyStatus,
	atomicsToThree, _toBig as toBig,
} from '../_lib/agent-labor.js';
import { runSettlement } from '../_lib/labor-settle.js';
import { payFromEscrow, ensureEscrowGas } from '../_lib/labor-escrow.js';
import { emitReasoning } from '../_lib/labor-match.js';
import { sql } from '../_lib/db.js';

const TERMINAL = new Set(['settled', 'failed', 'refunded', 'cancelled']);

async function posterSolanaAddress(bounty) {
	const [row] = await sql`
		SELECT meta FROM agent_identities WHERE id = ${bounty.poster_agent_id} AND deleted_at IS NULL`;
	return row?.meta?.solana_address || null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;

	// Read-only probe: does the caller have moderator (admin) rights? The UI uses
	// this to decide whether to reveal the release/refund controls. Never mutates.
	if (req.method === 'GET') {
		return json(res, 200, { data: { moderator: await isAdminRequest(req) } });
	}

	if (!method(req, res, ['GET', 'POST'])) return;

	// Moderator gate. requireAdmin writes the 401/403 itself; the escrow key is
	// never returned to or touched by the caller.
	const admin = await requireAdmin(req, res);
	if (!admin) return;
	if (!(await requireCsrf(req, res, admin.id))) return;

	const body = (await readJson(req)) || {};
	const bountyId = body.bountyId;
	const action = body.action === 'refund' ? 'refund' : body.action === 'release' ? 'release' : null;
	if (!bountyId) return error(res, 400, 'validation_error', 'bountyId is required');
	if (!requireUuid(res, bountyId, 'bountyId')) return;
	if (!action) return error(res, 400, 'validation_error', "action must be 'release' or 'refund'");

	const bounty = await getBounty(bountyId);
	if (!bounty) return error(res, 404, 'not_found', 'bounty not found');
	if (TERMINAL.has(bounty.status)) return error(res, 409, 'already_resolved', `bounty is already ${bounty.status}`);
	if (!bounty.escrow_fund_sig) return error(res, 409, 'no_escrow', 'this bounty has no funded escrow to move');

	const moderator = { admin_id: admin.id, wallet: admin.wallet_address || null, reason: typeof body.reason === 'string' ? body.reason.slice(0, 280) : null };
	let job = await getJobByBounty(bountyId);

	// Open bounty (escrow funded, no worker awarded): only a refund makes sense.
	if (!job) {
		if (action === 'release') return error(res, 409, 'no_worker', 'no worker has been awarded, so only refund is available');
		await ensureEscrowGas().catch(() => {});
		const to = await posterSolanaAddress(bounty);
		if (!to) return error(res, 409, 'no_poster_wallet', 'poster has no Solana wallet to refund to');
		let refundSig;
		try {
			refundSig = await payFromEscrow({ toAddress: to, amountAtomics: toBig(bounty.reward_atomics) });
		} catch (e) {
			return error(res, 502, 'refund_failed', `escrow refund did not land, no $THREE moved: ${e?.message || 'transfer failed'}`);
		}
		await setBountyStatus(bounty.id, 'refunded', { refundSig });
		emitReasoning({
			agentId: bounty.poster_agent_id, kind: 'labor.moderator_refund',
			summary: `Moderator refunded "${bounty.title}" (no worker awarded)`,
			detail: { bounty_id: bounty.id, moderator, refund_sig: refundSig },
		});
		return json(res, 200, {
			ok: true, action, status: 'refunded', moderator, settled: false,
			refund_sig: refundSig, refund_three: atomicsToThree(bounty.reward_atomics),
			explorer: refundSig ? `https://solscan.io/tx/${refundSig}` : null,
		});
	}

	// Awarded job: the shared settlement path only claims 'delivered'/'verifying'
	// jobs, so flip a still-'working' job to delivered (moderator override) first.
	if (job.status === 'working') {
		const delivered = await markJobDelivered(job.id, { moderator_override: true, action, by: moderator });
		job = delivered || (await getJob(job.id));
	}

	const verdict = {
		pass: action === 'release',
		score: action === 'release' ? 1 : 0,
		reason: `moderator ${action} by ${moderator.wallet || moderator.admin_id}${moderator.reason ? `: ${moderator.reason}` : ''}`,
		moderator,
	};

	const result = await runSettlement({ job, bounty, verdict });
	return json(res, 200, { ok: true, action, moderator, ...result });
});
