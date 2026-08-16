// GET /api/agent-screen-active — list agents that currently have a live screen stream.
//
// Returns agents whose agent:screen:{id}:frame key still exists in Redis (non-expired).
// Used by the walk scene to decide which agents to spawn desks for.
// Response: { desks: [{ agentId, agentName, avatarUrl, position, rotationY }] }
//
// Positions are pre-determined per agent using a deterministic layout (agents
// are assigned desk slots from a fixed grid so desks never overlap). The walk
// scene passes ?env=<envName> to bias placement within that environment's
// coordinate space.

import { cors, json, method, rateLimited, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getRedis } from './_lib/redis.js';
import { sql } from './_lib/db.js';

// Desk slot grid — up to 4 desks arranged in a row, offset from the scene centre.
// Walk environments use a ~12m radius ground, so we keep desks within ±8m.
const DESK_SLOTS = [
	{ position: [-3,  0, -6], rotationY: 0.08 },
	{ position: [ 3,  0, -6], rotationY: -0.08 },
	{ position: [-6,  0, -3], rotationY: Math.PI * 0.45 },
	{ position: [ 6,  0, -3], rotationY: -Math.PI * 0.45 },
];
const MAX_DESKS = 4;

// wrap(): an unhandled fault here must land the platform's sanitized envelope
// with a correlation ref, a Sentry capture and an ops alert, not the container's
// bare "The request failed unexpectedly" catch-all that tells nobody anything.
export default wrap(async function handleAgentScreenActive(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.apiIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const r = getRedis();
	if (!r) {
		// Redis offline — no active desks
		return json(res, 200, { desks: [] }, { 'cache-control': 'no-store' });
	}

	// Find agents with active frame keys. We scan a bounded set: agents recently
	// active are tracked in the sorted set agent:screen:active (ZADD with score=ts
	// on each push, pruned lazily). Fall back to an empty result if the set is
	// absent so cold starts don't error.
	let agentIds = [];
	try {
		// ZRANGE … BYSCORE on the active set — agents that pushed a frame in the
		// last 120s. (@upstash/redis exposes range-by-score as zrange with the
		// byScore option, not a zrangebyscore method.)
		const now = Date.now();
		const minScore = now - 120_000;
		const raw = await r.zrange('agent:screen:active', minScore, now, {
			byScore: true,
			offset: 0,
			count: MAX_DESKS,
		});
		agentIds = Array.isArray(raw) ? raw.slice(0, MAX_DESKS) : [];
	} catch {
		return json(res, 200, { desks: [] }, { 'cache-control': 'no-store' });
	}

	if (!agentIds.length) {
		return json(res, 200, { desks: [] }, { 'cache-control': 'no-store' });
	}

	// Resolve agent metadata from DB
	let agents = [];
	try {
		agents = await sql`
			SELECT a.id, a.name, a.avatar_url
			FROM agent_identities a
			WHERE a.id = ANY(${agentIds})
			LIMIT ${MAX_DESKS}
		`;
	} catch {
		return json(res, 200, { desks: [] }, { 'cache-control': 'no-store' });
	}

	const desks = agents.map((agent, i) => {
		const slot = DESK_SLOTS[i % DESK_SLOTS.length];
		return {
			agentId: agent.id,
			agentName: agent.name,
			avatarUrl: agent.avatar_url || null,
			position: slot.position,
			rotationY: slot.rotationY,
		};
	});

	return json(res, 200, { desks }, { 'cache-control': 'no-store' });
});
