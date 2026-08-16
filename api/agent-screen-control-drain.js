// POST /api/agent-screen-control-drain, the caster pool's read side of the control
// channel. The pool worker (workers/agent-screen-pool) calls this on a fast tick
// for the agents it is currently casting; for each one it learns whether a human
// holds the wheel (an active lease) and pops that agent's queued input events to
// dispatch into the live Chromium page.
//
// Auth: the shared SCREEN_WORKER_SECRET (same bearer the pool uses to push frames).
// This endpoint never touches user sessions, it is machine-to-machine only.
//
// Body: { agentIds: string[] }  (bounded)
// Reply: { agents: { [agentId]: { manual: boolean, events: object[] } } }
//   manual, a live control lease exists (pause the autonomous task)
//   events, sanitized input events in dispatch order (oldest first), drained

import { timingSafeEqual } from 'node:crypto';
import { cors, error, json, method, readJson, wrap } from './_lib/http.js';
import { extractBearer } from './_lib/auth.js';
import { getRedis } from './_lib/redis.js';

const WORKER_SECRET = process.env.SCREEN_WORKER_SECRET || '';
const MAX_AGENTS = 32;   // the pool caps concurrent casters well below this
const DRAIN_CAP = 200;   // matches the producer's QUEUE_CAP

function isPoolWorker(bearer) {
	if (!bearer || !WORKER_SECRET || WORKER_SECRET.length < 16) return false;
	const a = Buffer.from(bearer);
	const b = Buffer.from(WORKER_SECRET);
	return a.length === b.length && timingSafeEqual(a, b);
}

const leaseKey = (id) => `agent:screen:${id}:ctl:lease`;
const queueKey = (id) => `agent:screen:${id}:ctl:q`;

// wrap(): an unhandled fault here must land the platform's sanitized envelope
// with a correlation ref, a Sentry capture and an ops alert, not the container's
// bare "The request failed unexpectedly" catch-all that tells nobody anything.
export default wrap(async function handleAgentScreenControlDrain(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	if (!isPoolWorker(extractBearer(req))) {
		return error(res, 401, 'unauthorized', 'pool worker secret required');
	}

	let body;
	try {
		body = await readJson(req, 8_000);
	} catch {
		return error(res, 400, 'invalid_body', 'request body must be valid JSON');
	}

	const ids = Array.isArray(body?.agentIds)
		? [...new Set(body.agentIds.filter((s) => typeof s === 'string' && s))].slice(0, MAX_AGENTS)
		: [];
	if (!ids.length) return json(res, 200, { agents: {} });

	const r = getRedis();
	if (!r) return error(res, 503, 'redis_unavailable', 'control channel offline');

	const agents = {};
	await Promise.all(ids.map(async (id) => {
		let manual = false;
		let events = [];
		try {
			const lease = await r.get(leaseKey(id));
			manual = !!lease;
			if (manual) {
				// Drain oldest-first (producer rpush → head is oldest). lpop with a
				// count removes and returns them atomically.
				const popped = await r.lpop(queueKey(id), DRAIN_CAP).catch(() => null);
				const list = Array.isArray(popped) ? popped : popped != null ? [popped] : [];
				events = list
					.map((s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } })
					.filter(Boolean);
			}
		} catch {
			/* a Redis blip for one agent must not fail the whole batch */
		}
		agents[id] = { manual, events };
	}));

	return json(res, 200, { agents });
});
