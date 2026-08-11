// GET /api/agent/watch-wanted  ->  { agents: [{ agentId, name, homeUrl }], ts }
//
// Read side of the on-demand caster pool. The pool worker polls this to learn
// which agents viewers are currently watching, then maintains a bounded pool of
// real Playwright browsers casting exactly those agents (see
// workers/agent-screen-pool). Agents fall out of the window automatically once
// nobody is watching, so the worker can tear their browsers down.
//
// Auth: the shared first-party worker secret (SCREEN_WORKER_SECRET), the same
// secret the worker uses to push frames for any agent. Without it configured the
// endpoint reports the pool as disabled rather than leaking the watch set.

import { timingSafeEqual } from 'node:crypto';
import { cors, json, method, error, wrap } from '../_lib/http.js';
import { getRedis } from '../_lib/redis.js';
import { sql } from '../_lib/db.js';
import { extractBearer } from '../_lib/auth.js';
import { isUuid } from '../_lib/validate.js';

const WANTED_KEY = 'screen:wanted';
const WINDOW_MS = 90_000; // agents wanted within the last 90s are "live-watched"
const MAX_AGENTS = 48;    // hard cap returned to the worker

// Pool liveness. An authenticated poll is proof a caster pool is running right
// now, so every poll refreshes this key and /api/agent/watch-status reads it to
// decide whether a browser can actually be on its way. Without it the wall
// promised "warming up" forever whenever no pool was deployed. The TTL is many
// poll intervals wide (the worker's POLL_MS default is 3s) so a slow round or a
// rolling redeploy never reads as an outage.
export const POOL_ALIVE_KEY = 'screen:pool:alive';
export const POOL_ALIVE_TTL_S = 45;

// A secret shorter than this is treated as absent: a stray one-character value
// in the env would otherwise be a trivially guessable key to the whole watch set.
export const MIN_SECRET_LEN = 16;

// Pure auth seam (unit-tested): constant-time compare of the presented bearer
// against the configured worker secret. Takes the secret as an argument so the
// decision can be exercised without reaching into module-scope env state.
export function isPoolWorker(bearer, secret) {
	if (!bearer || !secret || secret.length < MIN_SECRET_LEN) return false;
	const a = Buffer.from(bearer);
	const b = Buffer.from(secret);
	return a.length === b.length && timingSafeEqual(a, b);
}

// Read at call time rather than at module load, so rotating the secret takes
// effect on the next request instead of on the next cold start.
function workerSecret() {
	return process.env.SCREEN_WORKER_SECRET || '';
}

// The watch set changes every few seconds and is worker-private: no cache layer
// between here and the pool should ever hold a copy of it.
const NO_STORE = { 'cache-control': 'no-store' };

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const secret = workerSecret();
	if (secret.length < MIN_SECRET_LEN) {
		return json(res, 200, { agents: [], disabled: true, reason: 'SCREEN_WORKER_SECRET not configured' }, NO_STORE);
	}
	if (!isPoolWorker(extractBearer(req), secret)) {
		return error(res, 401, 'unauthorized', 'pool worker secret required');
	}

	const r = getRedis();
	if (!r) return json(res, 200, { agents: [], ts: Date.now() }, NO_STORE);

	const now = Date.now();
	// Mark the pool alive before anything can fail below: the caller IS a caster,
	// and the wall's handoff should reflect that even on a degraded read.
	try {
		await r.set(POOL_ALIVE_KEY, now, { ex: POOL_ALIVE_TTL_S });
	} catch { /* a liveness blip degrades the wall to the activity view, never an error */ }
	let ids = [];
	try {
		// Most-recently-wanted first, capped.
		const raw = await r.zrange(WANTED_KEY, now, now - WINDOW_MS, {
			byScore: true,
			rev: true,
			offset: 0,
			count: MAX_AGENTS,
		});
		// agent_identities.id is a uuid column, and the set is keyed by whatever a
		// writer put there. One malformed member would make the batch lookup below
		// throw 22P02 and blind the pool to every other agent, so drop it here.
		ids = (Array.isArray(raw) ? raw : []).filter((id) => typeof id === 'string' && isUuid(id)).slice(0, MAX_AGENTS);
	} catch {
		return json(res, 200, { agents: [], ts: now }, NO_STORE);
	}

	if (!ids.length) return json(res, 200, { agents: [], ts: now }, NO_STORE);

	// Resolve names + a coin-agnostic home so the worker knows where to point the
	// browser for each agent (its profile by default).
	let rows = [];
	let resolved = true;
	try {
		rows = await sql`
			SELECT id, name, home_url
			FROM agent_identities
			WHERE id = ANY(${ids}) AND deleted_at IS NULL
		`;
	} catch {
		// A DB blip must not read as "every watched agent was deleted": that would
		// hand the pool an empty set and tear down every live browser. Remember the
		// lookup failed and fall back to id-only entries below.
		resolved = false;
	}

	const byId = new Map(rows.map((x) => [x.id, x]));
	const agents = ids
		// When the lookup succeeded, an id with no row is a deleted agent and is
		// correctly dropped. When it failed, nothing was resolved, so keep them all.
		.filter((id) => !resolved || byId.has(id))
		.map((id) => {
			const a = byId.get(id);
			return {
				agentId: id,
				name: a?.name || 'Agent',
				homeUrl: a?.home_url || `/agent/${id}`,
			};
		});

	return json(res, 200, { agents, ts: now }, NO_STORE);
});
