// GET    /api/x/triggers:              list triggers for current user
// POST   /api/x/triggers:               create  { kind, config, agent_id?, enabled? }
// PATCH  /api/x/triggers?id=<uuid>:     update  { config?, enabled? }
// DELETE /api/x/triggers?id=<uuid>:     delete

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, method, wrap, error, readJson, json } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';

const VALID_KINDS = new Set(['daily_persona', 'weekly_digest', 'price_milestone', 'payment_received']);
// Ceiling per account. The run-x-triggers cron evaluates every enabled row on
// every tick, so an unbounded list is a self-inflicted load problem; 50 is far
// more rules than any real posting schedule needs.
const MAX_TRIGGERS_PER_USER = 50;

function validateConfig(kind, config) {
	if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('config must be an object');
	if (kind === 'daily_persona') {
		const h = Number(config.hour_utc);
		if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error('hour_utc must be an integer from 0 to 23');
		if (config.topic && typeof config.topic !== 'string') throw new Error('topic must be a string');
	}
	if (kind === 'weekly_digest') {
		const d = Number(config.day_of_week);
		const h = Number(config.hour_utc);
		if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error('day_of_week must be an integer from 0 (Sun) to 6 (Sat)');
		if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error('hour_utc must be an integer from 0 to 23');
	}
	if (kind === 'price_milestone') {
		if (!Array.isArray(config.thresholds_usd) || !config.thresholds_usd.length) throw new Error('thresholds_usd must be non-empty array of numbers');
		if (config.thresholds_usd.some((t) => typeof t !== 'number' || t <= 0)) throw new Error('thresholds_usd entries must be positive numbers');
	}
	if (kind === 'payment_received') {
		const min = Number(config.min_amount_usd ?? 0);
		if (!Number.isFinite(min) || min < 0) throw new Error('min_amount_usd must be a non-negative number');
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const url = new URL(req.url, 'http://x');
	const id = url.searchParams.get('id');
	// `id` addresses a uuid primary key, so a junk value would reach Postgres as a
	// cast error and turn a caller mistake into a 500.
	if (id !== null && !isUuid(id)) return error(res, 400, 'validation_error', 'id must be a uuid');

	if (req.method === 'GET') {
		const rows = await sql`
			select id, agent_id, kind, config, enabled, auto_publish, last_fired_at, created_at, updated_at
			from x_triggers
			where user_id = ${user.id}
			order by created_at desc
		`;
		return json(res, 200, { triggers: rows });
	}

	if (req.method === 'POST') {
		if (!(await requireCsrf(req, res, user.id))) return;
		const body = await readJson(req);
		const kind = body?.kind;
		if (!VALID_KINDS.has(kind)) return error(res, 400, 'validation_error', `kind must be one of: ${[...VALID_KINDS].join(', ')}`);
		const config = body?.config ?? {};
		try { validateConfig(kind, config); } catch (err) { return error(res, 400, 'validation_error', err.message); }
		const agentId = typeof body?.agent_id === 'string' ? body.agent_id : null;
		if (agentId && !isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id must be a uuid');
		const enabled = body?.enabled !== false;
		const autoPublish = body?.auto_publish !== false;

		const [{ count }] = await sql`select count(*)::int as count from x_triggers where user_id = ${user.id}`;
		if (count >= MAX_TRIGGERS_PER_USER) {
			return error(res, 409, 'limit_reached', `you already have ${MAX_TRIGGERS_PER_USER} triggers, delete one first`);
		}

		const rows = await sql`
			insert into x_triggers (user_id, agent_id, kind, config, enabled, auto_publish)
			values (${user.id}, ${agentId}, ${kind}, ${JSON.stringify(config)}::jsonb, ${enabled}, ${autoPublish})
			returning id, agent_id, kind, config, enabled, auto_publish, last_fired_at, created_at, updated_at
		`;
		return json(res, 201, { trigger: rows[0] });
	}

	if (!id) return error(res, 400, 'validation_error', 'id required');

	if (req.method === 'PATCH') {
		if (!(await requireCsrf(req, res, user.id))) return;
		const body = await readJson(req);
		const existing = (await sql`select kind, config from x_triggers where id = ${id} and user_id = ${user.id} limit 1`)[0];
		if (!existing) return error(res, 404, 'not_found', 'trigger not found');

		const nextConfig = body?.config !== undefined ? body.config : existing.config;
		if (body?.config !== undefined) {
			try { validateConfig(existing.kind, nextConfig); } catch (err) { return error(res, 400, 'validation_error', err.message); }
		}
		const nextEnabled = typeof body?.enabled === 'boolean' ? body.enabled : null;
		const nextAuto = typeof body?.auto_publish === 'boolean' ? body.auto_publish : null;

		const rows = await sql`
			update x_triggers
			set config = ${JSON.stringify(nextConfig)}::jsonb,
			    enabled = coalesce(${nextEnabled}, enabled),
			    auto_publish = coalesce(${nextAuto}, auto_publish),
			    updated_at = now()
			where id = ${id} and user_id = ${user.id}
			returning id, agent_id, kind, config, enabled, auto_publish, last_fired_at, created_at, updated_at
		`;
		// The row can be deleted between the ownership read and the update; report
		// that honestly instead of returning a trigger-shaped hole.
		if (!rows.length) return error(res, 404, 'not_found', 'trigger not found');
		return json(res, 200, { trigger: rows[0] });
	}

	// DELETE
	if (!(await requireCsrf(req, res, user.id))) return;
	const result = await sql`delete from x_triggers where id = ${id} and user_id = ${user.id} returning id`;
	if (!result.length) return error(res, 404, 'not_found', 'trigger not found');
	return json(res, 200, { deleted: id });
});
