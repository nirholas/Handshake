// POST /api/agent-task — user queues a task for their agent
// GET  /api/agent-task?agentId=X — worker polls for its next task (bearer auth)
//
// Redis key: agent:task:{agentId}  (LIST, LPUSH / RPOP)
// The worker drains one task per poll; tasks stay ordered FIFO.
//
// POST body: { agentId: string, task: string, type?: string }
// GET  resp: { task: { text, type, ts, userId } | null }

import { cors, error, json, method, rateLimited, readJson, wrap } from './_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getRedis } from './_lib/redis.js';
import { sql } from './_lib/db.js';

const TASK_KEY = (id) => `agent:task:${id}`;
const LOG_KEY = (id) => `agent:screen:${id}:log`;
const LOG_CAP = 50; // mirrors agent-screen-push.js
const MAX_QUEUE = 20;
const TASK_TTL = 60 * 60 * 6; // 6h — tasks expire if worker never shows up
const TASK_MAX_LEN = 1000;

// wrap() gives this route the same boundary every neighbouring handler has: a
// DB outage degrades to a throttled 503 instead of one logged stack trace and a
// generic 500 per poll, and a genuine fault gets a correlation ref.
export default wrap(async function handleAgentTask(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// ── Auth: bearer (worker) OR session (browser user) ─────────────────────
	let userId = null;
	const bearer = extractBearer(req);
	if (bearer) {
		const auth = await authenticateBearer(bearer).catch(() => null);
		if (auth?.userId) userId = auth.userId;
	}
	if (!userId) {
		const auth = await getSessionUser(req, res);
		if (auth?.id) userId = auth.id;
	}
	if (!userId) return error(res, 401, 'unauthorized', 'authentication required');

	const r = getRedis();
	if (!r) return error(res, 503, 'redis_unavailable', 'task store offline');

	// ── GET — worker polls for next task ─────────────────────────────────────
	if (req.method === 'GET') {
		const agentId = (new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams.get('agentId') || '').trim();
		if (!agentId) return error(res, 400, 'missing_agent_id', 'agentId required');

		// Verify the polling identity owns this agent. Agents live in
		// agent_identities, the same table agent-screen-push.js authorizes
		// against; there is no `agents` table.
		const [agentRow] = await sql`
			SELECT id FROM agent_identities
			WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
			LIMIT 1
		`;
		if (!agentRow) return error(res, 403, 'forbidden', 'agent not owned by this user');

		// RPOP = FIFO: oldest task first
		const raw = await r.rpop(TASK_KEY(agentId));
		if (!raw) return json(res, 200, { task: null });

		let task;
		try {
			task = JSON.parse(raw);
		} catch {
			task = { text: String(raw), type: 'general', ts: Date.now() };
		}

		return json(res, 200, { task });
	}

	// ── POST — user enqueues a task ───────────────────────────────────────────
	if (req.method === 'POST') {
		// Rate limit: 20 tasks/min per IP
		const rl = await limits.apiIp(clientIp(req), { limit: 20, window: '60s' });
		if (!rl.success) return error(res, 429, 'rate_limited', 'too many tasks — slow down');

		let body;
		try {
			body = await readJson(req, 64_000);
		} catch {
			return error(res, 400, 'invalid_body', 'request body must be valid JSON');
		}

		const { agentId, task, type = 'general' } = body || {};

		if (!agentId || typeof agentId !== 'string') {
			return error(res, 400, 'missing_agent_id', 'agentId is required');
		}
		if (!task || typeof task !== 'string' || !task.trim()) {
			return error(res, 400, 'missing_task', 'task text is required');
		}

		const text = task.trim().slice(0, TASK_MAX_LEN);
		const taskType = ['general', 'research', 'trade', 'browse', 'monitor'].includes(type)
			? type : 'general';

		// Verify ownership
		const [agentRow] = await sql`
			SELECT id, name FROM agent_identities
			WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
			LIMIT 1
		`;
		if (!agentRow) return error(res, 403, 'forbidden', 'agent not owned by this user');

		const now = Date.now();
		const record = JSON.stringify({ text, type: taskType, ts: now, userId });

		// Push task to queue; trim to MAX_QUEUE
		const len = await r.lpush(TASK_KEY(agentId), record);
		const logEntry = JSON.stringify({ ts: now, activity: `Task queued: ${text}`, type: 'analysis' });
		await Promise.all([
			r.expire(TASK_KEY(agentId), TASK_TTL),
			len > MAX_QUEUE ? r.ltrim(TASK_KEY(agentId), 0, MAX_QUEUE - 1) : Promise.resolve(),
			// Surface the task in the activity log WITHOUT clobbering the live frame:
			// append to the log list (which the stream backfills) rather than
			// overwriting the screenshot frame, which would blank the viewer's image.
			r.lpush(LOG_KEY(agentId), logEntry).then(() => r.ltrim(LOG_KEY(agentId), 0, LOG_CAP - 1)),
			r.expire(LOG_KEY(agentId), 60 * 8),
		]);

		return json(res, 200, { ok: true, queued: Math.min(len, MAX_QUEUE) });
	}
});
