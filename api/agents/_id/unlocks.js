// /api/agents/:id/unlocks
//
//   GET  → the agent's reputation-derived unlock state: which world areas and
//          cosmetics its real, server-computed reputation has earned, how close it
//          is to the rest, and which cosmetics it has already claimed. Public — an
//          agent's tier and unlocks are a trust signal others rely on (mirrors the
//          public /reputation read). `is_owner` is echoed so the client can show
//          owner-only "claim" affordances.
//   POST /claim { key } → owner-only: persist an unlocked cosmetic onto the agent
//          record. Re-authorizes ownership AND the unlock requirement server-side
//          (api/_lib/trust/access.js) and is CSRF-protected — a client can never
//          fake a tier to grant itself a cosmetic.
//
// Real capability gates (e.g. the arena elite floor) call requireUnlock() from the
// protected route itself; this endpoint is the read + the cosmetic-claim surface.

import { cors, json, error, method, wrap, rateLimited, readJson, varyOn } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { getSessionUser } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { sql } from '../../_lib/db.js';
import { getAgentUnlocks, claimUnlock, resolveUserId, AccessError } from '../../_lib/trust/access.js';

export const handleUnlocks = wrap(async (req, res, agentId, action) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;

	if (req.method === 'GET') {
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);

		let payload;
		try {
			payload = await getAgentUnlocks(agentId);
		} catch (err) {
			if (err.status === 404) return error(res, 404, 'not_found', 'agent not found');
			throw err;
		}

		// Echo ownership so the client can reveal owner-only claim controls.
		const userId = await resolveUserId(req);
		let isOwner = false;
		if (userId) {
			const [own] = await sql`
				select 1 from agent_identities where id = ${agentId} and user_id = ${userId} and deleted_at is null limit 1
			`.catch(() => []);
			isOwner = Boolean(own);
		}

		// `is_owner` gates the client's claim controls, so an authenticated read is
		// personal: only the anonymous variant may sit in the shared CDN cache
		// under this URL. Vary states the credential is part of the cache key.
		varyOn(res, 'Cookie', 'Authorization');
		return json(
			res,
			200,
			{ ...payload, is_owner: isOwner },
			{
				'cache-control': userId
					? 'private, no-store'
					: 'public, max-age=30, stale-while-revalidate=180',
			},
		);
	}

	if (req.method === 'POST') {
		if (action !== 'claim') return error(res, 404, 'not_found', 'unknown action');

		const session = await getSessionUser(req).catch(() => null);
		if (!session) return error(res, 401, 'unauthenticated', 'sign in to claim unlocks');
		if (!(await requireCsrf(req, res, session.id))) return;

		const rl = await limits.unlockClaim(session.id);
		if (!rl.success) return rateLimited(res, rl);

		const body = await readJson(req).catch(() => ({}));
		const key = typeof body?.key === 'string' ? body.key : null;
		if (!key) return error(res, 400, 'bad_request', 'missing unlock key');

		try {
			const result = await claimUnlock(req, { agentId, key });
			return json(res, 200, { ok: true, ...result });
		} catch (err) {
			if (err instanceof AccessError) return error(res, err.status, err.code, err.message);
			throw err;
		}
	}

	return method(req, res, ['GET', 'POST']);
});
