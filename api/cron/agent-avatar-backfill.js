// GET /api/cron/agent-avatar-backfill
//
// Steady-state drain of the "agent with no avatar" gap.
//
// Several agent-creation paths (minimal auto-provision, external registration,
// swarm treasuries, x402 ring agents) insert agent_identities rows with
// avatar_id = NULL, so their cards on /agents and the marketplace can never
// show a 3D preview. Each tick this cron assigns those agents a cloned public
// avatar from the platform gallery (see api/_lib/agent-avatars.js) — pure DB
// work, no rendering, no new storage bytes — until every agent has a body.
//
// Sibling cron avatar-thumbnail-backfill handles the other half of the
// guarantee (every public avatar has a thumbnail); together they make "every
// agent card has a real preview" an invariant instead of a hope.
//
// Env:
//   CRON_SECRET                 required (Bearer)
//   AGENT_AVATAR_BACKFILL_BATCH agents assigned per tick (default 100)

import { json, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { logger } from '../_lib/usage.js';
import { backfillAgentAvatars, agentAvatarCoverage } from '../_lib/agent-avatars.js';

export const maxDuration = 120;

const log = logger('agent-avatar-backfill');

const BATCH = Math.max(0, Number(process.env.AGENT_AVATAR_BACKFILL_BATCH || 100));

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		json(res, 503, { error: 'CRON_SECRET unset' });
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(token, secret)) {
		json(res, 401, { error: 'unauthorized' });
		return false;
	}
	return true;
}

export default wrapCron(async (req, res) => {
	if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
	if (!requireCron(req, res)) return;

	let result = { claimed: 0, assigned: 0, failed: 0 };
	if (BATCH > 0) {
		try {
			result = await backfillAgentAvatars({ limit: BATCH });
			if (result.assigned) log.info('agent_avatars_assigned', result);
			if (result.failed) log.warn('agent_avatar_assign_failed', result);
		} catch (err) {
			log.warn('agent_avatar_backfill_failed', { message: err?.message });
			return json(res, 200, { ok: false, reason: `backfill_failed: ${err?.message}` });
		}
	}

	const cov = await agentAvatarCoverage().catch(() => null);

	return json(res, 200, {
		ok: true,
		...result,
		coverage: cov,
	});
});
