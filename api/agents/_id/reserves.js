// GET /api/agents/:id/solana/reserves  (also reachable at /api/agents/:id/reserves)
//
// Proof-of-Reserves for an agent's wallet — verifiable, on-chain-derived
// transparency. Public read: an agent's reserves and its flow history are public
// on-chain facts, so owner, visitor, and logged-out all see the same numbers and
// the same one-tap "verify on-chain" link. Only owner-only data (spend policy,
// keys, private notes) is ever withheld — and none of that is in this payload.
//
// Everything here is either a LIVE read of real Solana chain state or a real,
// already-settled custody-ledger row linking to its on-chain signature. When RPC
// is throttled, reserves degrade to the last verified snapshot with an honest
// timestamp — never a stale "verified now". All compute lives in
// api/_lib/trust/proof-of-reserves.js.

import { cors, json, error, method, wrap, rateLimited, varyOn } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { sql } from '../../_lib/db.js';
import { getProofOfReserves } from '../../_lib/trust/proof-of-reserves.js';

async function resolveUserId(req) {
	try {
		const session = await getSessionUser(req);
		if (session) return session.id;
		const bearer = await authenticateBearer(extractBearer(req));
		if (bearer) return bearer.userId;
	} catch {
		/* anonymous */
	}
	return null;
}

export const handleReserves = wrap(async (req, res, agentId) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const flowsLimit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10) || 25));
	const beforeRaw = url.searchParams.get('before');
	const beforeId = beforeRaw && /^\d+$/.test(beforeRaw) ? beforeRaw : null;

	// Ownership only unlocks the "improve your solvency" affordances client-side;
	// the figures themselves are public, so we resolve it but never gate the data.
	const userId = await resolveUserId(req);
	let isOwner = false;
	if (userId) {
		const [own] = await sql`
			select 1 from agent_identities where id = ${agentId} and user_id = ${userId} and deleted_at is null limit 1
		`.catch(() => []);
		isOwner = Boolean(own);
	}

	let payload;
	try {
		payload = await getProofOfReserves(agentId, { network, isOwner, flowsLimit, beforeId });
	} catch (err) {
		if (err.status === 404) return error(res, 404, 'not_found', 'agent not found');
		throw err;
	}

	// Reserves are live; flows are a paginated ledger window. Short public cache so
	// the "verify on-chain" claim stays close to real-time, but only for the
	// anonymous variant. The payload echoes `is_owner`, so an authenticated read is
	// personal and must never land in the shared CDN cache under this URL.
	varyOn(res, 'Cookie', 'Authorization');
	return json(res, 200, payload, {
		'cache-control': userId
			? 'private, no-store'
			: 'public, max-age=30, stale-while-revalidate=120',
	});
});
