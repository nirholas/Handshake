// GET /api/cron/mirror-fanout - drive the custodial copy-trade (mirror) engine.
//
// For every active follow edge whose leader has made a NEW confirmed trade since
// the edge's cursor, size the trade for the follower and execute it through the
// task-05 engine inside the follower's spend policy (api/_lib/agent-mirror.js).
// Idempotent end to end: the agent_mirror_fills unique key and the custody
// idempotency key both prevent double-mirroring, so re-running this cron (or
// overlapping with an owner "Sync now") never double-spends.
//
// Bounded so a 2-minute cron can never run away: only edges with a leader trade
// in the recent window are scanned, and each edge processes at most N events.

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { syncFollow } from '../_lib/agent-mirror.js';
import { requireCron } from '../_lib/cron-auth.js';

const NETWORKS = ['mainnet', 'devnet'];
const MAX_FOLLOWS_PER_RUN = 120;
const MAX_EVENTS_PER_FOLLOW = 15;

async function fanout(network, stats) {
	// Candidate edges: enabled, not killed by the follower's agent-wide switch, and
	// whose leader has at least one confirmed trade newer than the edge cursor.
	const follows = await sql`
		SELECT f.*, la.name AS leader_name
		FROM agent_mirror_follows f
		JOIN agent_identities fa ON fa.id = f.follower_agent_id AND fa.deleted_at IS NULL
		JOIN agent_identities la ON la.id = f.leader_agent_id AND la.deleted_at IS NULL
		WHERE f.enabled = true
		  AND f.network = ${network}
		  AND COALESCE(fa.meta->>'mirror_killed', 'false') <> 'true'
		  AND EXISTS (
		    SELECT 1 FROM agent_custody_events e
		    WHERE e.agent_id = f.leader_agent_id
		      AND e.network = ${network}
		      AND e.category = 'trade'
		      AND e.status = 'confirmed'
		      AND e.id > f.last_leader_event_id
		      AND e.created_at > now() - interval '20 minutes'
		  )
		ORDER BY f.updated_at ASC
		LIMIT ${MAX_FOLLOWS_PER_RUN}
	`;
	stats.edges = (stats.edges || 0) + follows.length;
	if (!follows.length) return;

	for (const f of follows) {
		try {
			const r = await syncFollow(f, { maxEvents: MAX_EVENTS_PER_FOLLOW });
			for (const res of r.results) {
				stats[res.status] = (stats[res.status] || 0) + 1;
			}
		} catch (err) {
			stats.error = (stats.error || 0) + 1;
			stats.last_error = (err?.message || 'error').slice(0, 160);
		}
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	// Seeded so an idle run answers {edges:0} rather than a bare {ok:true}: a
	// scan that found nothing has to be distinguishable from a scan that never
	// reached the query.
	const stats = { edges: 0 };
	for (const network of NETWORKS) {
		try { await fanout(network, stats); }
		catch (err) { stats[`error_${network}`] = (err?.message || 'error').slice(0, 160); }
	}
	return json(res, 200, { ok: true, ...stats });
});
