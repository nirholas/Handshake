// /api/agent/anchor-script — the Newsroom Anchor's spoken script store.
//
//   GET  ?agentId=<uuid>   → { ok, script: { ts, headline, body, offline } | null }
//   POST { agentId, headline, body, offline? }  → { ok, ts }
//
// The anchor worker (workers/agent-anchor) scripts each bulletin and POSTs the
// spoken body here; viewers' browsers GET it (after a type:'analysis' screen
// frame arrives) to synthesize speech + lip-sync. The headline rides in the
// frame's `activity`; the (longer) spoken body lives here so it isn't bound by
// the frame's 320-char activity cap.
//
// Storage: Redis key agent:anchor:{agentId}:script (TTL 180s — a little over two
// 90s cadence ticks, so a freshly-arrived frame always has a script to fetch,
// and a stopped anchor's script expires on its own).
//
// Auth: GET is public (the stream it pairs with is public). POST requires the
// agent's bearer JWT / owner session, or the first-party screen-pool secret —
// the same authorization model as /api/agent-screen-push.

import { timingSafeEqual } from 'node:crypto';
import { cors, json, method, error, readJson, wrap, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getRedis } from '../_lib/redis.js';
import { isUuid } from '../_lib/validate.js';
import { sql } from '../_lib/db.js';

const SCRIPT_TTL = 180; // seconds
const HEADLINE_MAX = 320;
const BODY_MAX = 4096;

const WORKER_SECRET = process.env.SCREEN_WORKER_SECRET || '';
function isPoolWorker(bearer) {
	if (!bearer || !WORKER_SECRET || WORKER_SECRET.length < 16) return false;
	const a = Buffer.from(bearer);
	const b = Buffer.from(WORKER_SECRET);
	return a.length === b.length && timingSafeEqual(a, b);
}

const scriptKey = (agentId) => `agent:anchor:${agentId}:script`;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const r = getRedis();

	// ── GET: read the current script ─────────────────────────────────────────
	if (req.method === 'GET') {
		const rl = await limits.apiIp(clientIp(req), { limit: 240, window: '60s' });
		if (!rl.success) return rateLimited(res, rl);

		const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
		const agentId = (url.searchParams.get('agentId') || '').trim();
		if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'valid agentId required');
		if (!r) return json(res, 200, { ok: true, script: null });

		let script = null;
		try {
			const raw = await r.get(scriptKey(agentId));
			if (raw) script = typeof raw === 'string' ? JSON.parse(raw) : raw;
		} catch { /* treat a Redis blip as "no script yet" */ }
		return json(res, 200, { ok: true, script }, { 'cache-control': 'no-store' });
	}

	// ── POST: store the latest script ────────────────────────────────────────
	const rl = await limits.apiIp(clientIp(req), { limit: 120, window: '60s' });
	if (!rl.success) return rateLimited(res, rl);

	let userId = null;
	let isWorker = false;
	const bearer = extractBearer(req);
	if (isPoolWorker(bearer)) {
		isWorker = true;
	} else {
		if (bearer) {
			const auth = await authenticateBearer(bearer).catch(() => null);
			if (auth?.userId) userId = auth.userId;
		}
		if (!userId) {
			const auth = await getSessionUser(req, res);
			if (auth?.id) userId = auth.id;
		}
		if (!userId) return error(res, 401, 'unauthorized', 'authentication required');
	}

	const body = await readJson(req, 12_000).catch(() => null);
	if (!body || typeof body !== 'object') return error(res, 400, 'invalid_body', 'JSON body required');

	const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'valid agentId required');

	const headline = String(body.headline || '').slice(0, HEADLINE_MAX).trim();
	const speakBody = String(body.body || '').slice(0, BODY_MAX).trim();
	if (!headline && !speakBody) return error(res, 400, 'validation_error', 'headline or body required');
	const offline = Array.isArray(body.offline)
		? body.offline.filter((x) => typeof x === 'string').slice(0, 8)
		: [];

	// Ownership: workers (shared secret) may write any agent; owners only their own.
	const [agentRow] = isWorker
		? await sql`SELECT id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL LIMIT 1`
		: await sql`SELECT id FROM agent_identities WHERE id = ${agentId} AND user_id = ${userId} LIMIT 1`;
	if (!agentRow) {
		return error(res, isWorker ? 404 : 403, isWorker ? 'not_found' : 'forbidden',
			isWorker ? 'agent not found' : 'agent not owned by this user');
	}

	if (!r) return error(res, 503, 'redis_unavailable', 'script store offline');

	const now = Date.now();
	const record = JSON.stringify({ ts: now, headline, body: speakBody, offline, agentId });
	try {
		await r.set(scriptKey(agentId), record, { ex: SCRIPT_TTL });
	} catch {
		return error(res, 503, 'redis_unavailable', 'could not store script');
	}
	return json(res, 200, { ok: true, ts: now });
});
