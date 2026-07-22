// POST /api/agent-screen-control, take the wheel of an agent's live cast browser.
//
// The frame stream (/api/agent-screen-stream) lets anyone WATCH an agent work.
// This is the reverse channel: the agent's OWNER can drive its real cast browser
// with mouse, scroll, keyboard, and navigation. Input events queue in Redis; the
// caster pool (workers/agent-screen-pool) drains them and dispatches them into the
// live Chromium page, and pauses its own autonomous task while a human holds the
// wheel so the two never fight over the cursor.
//
// Security model:
//   • Owner-only. Watching is public; driving is not. Ownership is checked once,
//     at lease acquisition, against agent_identities.user_id.
//   • Capability lease. Acquiring returns a short-lived bearer LEASE TOKEN (not a
//     JWT) scoped to exactly one agent's control for LEASE_TTL seconds. Every
//     input POST authenticates with that token, so the high-frequency channel
//     needs no per-event CSRF round trip, and the capability expires on its own.
//   • The cast browser holds NO wallet or keys. Driving it cannot sign a
//     transaction or move funds, money stays behind the agent runtime and the
//     on-chain wall. This is the property that makes remote control safe to ship.
//   • Nav is host-guarded (no loopback / private / metadata) and every event is
//     sanitized + range-clamped on this boundary (see src/shared/agent-screen-control.js).
//
// Actions (JSON body { agentId, action, ... }):
//   acquire , session + CSRF + ownership → { leaseToken, viewport, holdMs }
//   input   , bearer lease token; { events: [...] } → queues sanitized events
//   renew   , bearer lease token; refreshes the lease TTL (idle hold)
//   release , bearer lease token; drops the lease immediately

import crypto from 'node:crypto';
import { cors, error, json, method, rateLimited, readJson } from './_lib/http.js';
import { getSessionUser, extractBearer } from './_lib/auth.js';
import { requireCsrf } from './_lib/csrf.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getRedis } from './_lib/redis.js';
import { sql } from './_lib/db.js';
import { sanitizeEvents } from '../src/shared/agent-screen-control.js';

const LEASE_TTL_S = 15;      // lease dies this long after the last input/renew
const QUEUE_TTL_S = 15;      // queued events self-expire if the caster is gone
const QUEUE_CAP = 200;       // most-recent events kept if a driver outruns the drain
// The streamed viewport the caster renders at (kept in sync with the pool's
// VIEWPORT_W/H). The client needs it to label the URL bar / status; coordinates
// travel normalized (0..1) so an exact match is not load-bearing.
const VIEWPORT = { width: 1280, height: 720 };

const leaseKey = (id) => `agent:screen:${id}:ctl:lease`;
const queueKey = (id) => `agent:screen:${id}:ctl:q`;

async function readLease(r, agentId) {
	try {
		const raw = await r.get(leaseKey(agentId));
		if (!raw) return null;
		return typeof raw === 'string' ? JSON.parse(raw) : raw;
	} catch {
		return null;
	}
}

function timingEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	try {
		return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
	} catch {
		return false;
	}
}

export default async function handleAgentScreenControl(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.apiIp(clientIp(req), { limit: 1200, window: '60s' });
	if (!rl.success) return rateLimited(res, rl, 'control rate limit exceeded');

	let body;
	try {
		body = await readJson(req, 64_000);
	} catch {
		return error(res, 400, 'invalid_body', 'request body must be valid JSON under 64 KB');
	}

	const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
	const action = body?.action;
	if (!agentId) return error(res, 400, 'missing_agent_id', 'agentId is required');
	if (!['acquire', 'input', 'renew', 'release'].includes(action)) {
		return error(res, 400, 'bad_action', 'action must be acquire | input | renew | release');
	}

	const r = getRedis();
	if (!r) return error(res, 503, 'redis_unavailable', 'control channel offline');

	// ── acquire: prove ownership (session + CSRF), mint a capability lease ───────
	if (action === 'acquire') {
		const auth = await getSessionUser(req, res);
		const userId = auth?.id;
		if (!userId) return error(res, 401, 'unauthorized', 'sign in to drive this agent');
		if (!(await requireCsrf(req, res, userId))) return; // sends 403 on failure

		const [own] = await sql`
			SELECT id FROM agent_identities
			WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
			LIMIT 1
		`.catch(() => []);
		if (!own) return error(res, 403, 'forbidden', 'you do not own this agent');

		// A different owner-session may already hold the wheel. Same user (another
		// tab) is allowed to take over their own lease.
		const existing = await readLease(r, agentId);
		if (existing && existing.userId && existing.userId !== userId) {
			return error(res, 409, 'in_use', 'another session is driving this agent');
		}

		const leaseToken = crypto.randomBytes(24).toString('base64url');
		const record = JSON.stringify({ userId, token: leaseToken, ts: Date.now() });
		await r.set(leaseKey(agentId), record, { ex: LEASE_TTL_S });
		return json(res, 200, {
			ok: true,
			leaseToken,
			viewport: VIEWPORT,
			holdMs: LEASE_TTL_S * 1000,
		});
	}

	// ── input / renew / release: authenticate with the lease token ──────────────
	const token = extractBearer(req);
	if (!token) return error(res, 401, 'no_lease', 'control lease token required');
	const lease = await readLease(r, agentId);
	if (!lease || !timingEqual(String(lease.token || ''), token)) {
		return error(res, 401, 'lease_invalid', 'control lease expired or invalid, re-acquire the wheel');
	}

	if (action === 'release') {
		await r.del(leaseKey(agentId)).catch(() => {});
		return json(res, 200, { ok: true, released: true });
	}

	// Refresh the lease TTL on any input/renew so an active driver keeps the wheel.
	const refreshed = JSON.stringify({ ...lease, ts: Date.now() });
	await r.set(leaseKey(agentId), refreshed, { ex: LEASE_TTL_S });

	if (action === 'renew') return json(res, 200, { ok: true, renewed: true });

	// action === 'input'
	const events = sanitizeEvents(body?.events);
	if (!events.length) return json(res, 200, { ok: true, accepted: 0 });

	// Per-agent input rate limit, bounds how fast one driver can drive one agent.
	const arl = await limits.apiIp(`ctl:${agentId}`, { limit: 900, window: '60s' });
	if (!arl.success) return rateLimited(res, arl, 'per-agent control rate limit exceeded');

	const payload = events.map((e) => JSON.stringify(e));
	await r.rpush(queueKey(agentId), ...payload);
	await r.ltrim(queueKey(agentId), -QUEUE_CAP, -1);
	await r.expire(queueKey(agentId), QUEUE_TTL_S);

	return json(res, 200, { ok: true, accepted: events.length });
}
