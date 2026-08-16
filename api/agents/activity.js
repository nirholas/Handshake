// GET|POST /api/agents/activity?ids=a,b,c
//
// One request that returns the recent real activity for a LIST of agents, plus
// which of them currently have a live screen caster pushing frames.
//
// Why this exists
// ---------------
// /api/agent-screen-stream is a per-agent SSE stream, and for an agent with no
// caster its entire job is to re-read that agent's `agent_actions` rows every few
// seconds and push them down as a `log` event. A wall of agents (/agents-live)
// therefore opened one long-lived SSE connection PER CARD purely to poll the
// database. A browser allows 6 concurrent connections per origin over HTTP/1.1
// and a fixed stream budget over HTTP/2, and an SSE stream never releases its
// slot, so the first handful of cards connected and every card after them sat on
// "Connecting" forever while the page's own fetches queued behind them.
//
// A poll does not need a stream. This endpoint answers the same question for the
// whole visible wall in a single round-trip: one SQL query (LATERAL over the id
// list, so it stays one index scan per agent rather than N queries) and one Redis
// MGET for the caster check. The wall keeps SSE for the agents that genuinely
// have live pixels to push, which is a small set.
//
// Response:
//   {
//     activity: { "<agentId>": [{ ts, activity, type, mm? }, ...oldest-first] },
//     casting:  ["<agentId>", ...]   // has a non-expired agent:screen:*:frame
//   }
//
// Public read: agent activity is already public on every agent profile, so no
// auth is required. Unknown ids are simply absent from `activity`.

import { cors, json, error, method, wrap, rateLimited, readBody } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getRedis } from '../_lib/redis.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';
import { rowToEntry } from '../_lib/agent-activity.js';

const MAX_IDS = 60;
// Per-agent depth. A wall card's terminal shows ~11 lines at 640x360 and
// coalesces repeats, so 24 rows is comfortably more than it can draw while
// keeping the batch payload small enough for a 60-agent page.
const PER_AGENT = 24;

// Read the caller's id list from either shape. GET keeps the endpoint trivially
// cacheable/debuggable from a browser; POST keeps a 60-id list off the URL.
async function readIds(req, res) {
	if (req.method === 'POST') {
		const body = await readBody(req, 8192).catch(() => null);
		let parsed = null;
		try {
			parsed = body ? JSON.parse(body) : null;
		} catch {
			error(res, 400, 'validation_error', 'invalid JSON body');
			return null;
		}
		const raw = Array.isArray(parsed?.ids) ? parsed.ids : Array.isArray(parsed?.agentIds) ? parsed.agentIds : [];
		return raw;
	}
	const url = new URL(req.url, 'http://x');
	return (url.searchParams.get('ids') || url.searchParams.get('agentIds') || '').split(',');
}

// Which of these agents has a live caster right now? The frame key carries a TTL,
// so its mere presence IS the liveness signal (same test /api/agent-screen-active
// makes). One MGET covers the whole page.
async function castingIds(ids) {
	const r = getRedis();
	if (!r) return [];
	try {
		const raw = await r.mget(...ids.map((id) => `agent:screen:${id}:frame`));
		const values = Array.isArray(raw) ? raw : [];
		return ids.filter((_, i) => values[i] != null && values[i] !== '');
	} catch {
		// Redis blip: report nobody as casting. The wall still renders every card's
		// activity from the rows below, which is the always-available baseline.
		return [];
	}
}

export default wrap(async function handleAgentsActivity(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// Same bucket as the sibling batch read (/api/agents/reputation-batch): this is
	// an agent-discovery read, and it must not draw down the shared `apiIp` budget
	// that the wall's own watch-intent and watch-status polls live on. One batch
	// here stands in for a page of streams, so starving it starves every card.
	const rl = await limits.agentProfileIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const raw = await readIds(req, res);
	if (raw === null) return; // readIds already answered with the validation error

	const ids = [...new Set(raw.map((s) => String(s || '').trim()).filter(isUuid))].slice(0, MAX_IDS);
	if (!ids.length) return json(res, 200, { activity: {}, casting: [] }, { 'cache-control': 'no-store' });

	// One LATERAL join over the id array: Postgres runs the per-agent index scan
	// once per id and stops at PER_AGENT rows, instead of the N separate queries a
	// per-card stream would have issued.
	const rows = await sql`
		SELECT a.agent_id, a.type, a.payload, a.created_at
		FROM unnest(${ids}::uuid[]) AS t(id)
		JOIN LATERAL (
			SELECT agent_id, type, payload, created_at
			FROM agent_actions
			WHERE agent_id = t.id
			ORDER BY id DESC
			LIMIT ${PER_AGENT}
		) a ON true
	`.catch(() => []);

	const activity = {};
	for (const row of rows) {
		const key = String(row.agent_id);
		(activity[key] ||= []).push(rowToEntry(row));
	}
	// The LATERAL yields newest-first; the card terminal reads oldest-first.
	for (const key of Object.keys(activity)) activity[key].reverse();

	const casting = await castingIds(ids);

	return json(res, 200, { activity, casting }, { 'cache-control': 'no-store' });
});
