// PATCH  /api/alerts/rules/:id — update a rule.
// DELETE /api/alerts/rules/:id — delete a rule (cascades fires + delivery log).
//
// Part of the server-side multi-rule alert model (Task 04). Ownership is
// enforced on every operation: a user can only touch their own rules.

import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits } from '../../_lib/rate-limit.js';
import { parse, isUuid } from '../../_lib/validate.js';
import { randomToken } from '../../_lib/crypto.js';
import { updateRuleSchema, validateUpdate, serializeRule } from '../_rules.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['PATCH', 'DELETE'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const id = req.query?.id;
	if (!id || !isUuid(id)) return error(res, 400, 'validation_error', 'valid rule id required');

	const rl = await limits.prefsWrite(user.id);
	if (!rl.success) return rateLimited(res, rl);
	if (!(await requireCsrf(req, res, user.id))) return;

	if (req.method === 'DELETE') {
		const [row] = await sql`
			DELETE FROM pump_alert_rules WHERE id = ${id} AND user_id = ${user.id} RETURNING id
		`;
		if (!row) return error(res, 404, 'not_found', 'rule not found');
		return json(res, 200, { ok: true, id: row.id });
	}

	// PATCH
	const [current] = await sql`
		SELECT id, kind, target_mint, target_agent, threshold, deliver_in_app,
		       webhook_url, webhook_secret, telegram_chat, cooldown_seconds, enabled, label
		FROM pump_alert_rules
		WHERE id = ${id} AND user_id = ${user.id}
	`;
	if (!current) return error(res, 404, 'not_found', 'rule not found');

	const patch = parse(updateRuleSchema, await readJson(req));
	const result = validateUpdate(current, patch);
	if (!result.ok) {
		return error(res, 400, 'validation_error', result.message, { issues: result.issues });
	}
	const next = result.value;

	if (next.target_agent && next.target_agent !== current.target_agent) {
		const [agent] = await sql`SELECT 1 AS ok FROM agent_identities WHERE id = ${next.target_agent}`;
		if (!agent) return error(res, 400, 'validation_error', 'target_agent does not exist');
	}

	// Webhook secret lifecycle: mint one when a webhook is newly configured,
	// drop it when the webhook is removed, otherwise keep the existing secret.
	let webhookSecret = current.webhook_secret;
	if (!next.webhook_url) webhookSecret = null;
	else if (!current.webhook_url || !current.webhook_secret) webhookSecret = `whsec_${randomToken(24)}`;

	await sql`
		UPDATE pump_alert_rules SET
			kind             = ${next.kind},
			target_mint      = ${next.target_mint || null},
			target_agent     = ${next.target_agent || null},
			threshold        = ${next.threshold ?? null},
			deliver_in_app   = ${next.deliver_in_app},
			webhook_url      = ${next.webhook_url || null},
			webhook_secret   = ${webhookSecret},
			telegram_chat    = ${next.telegram_chat || null},
			cooldown_seconds = ${next.cooldown_seconds},
			enabled          = ${next.enabled},
			label            = ${next.label || null},
			updated_at       = now()
		WHERE id = ${id} AND user_id = ${user.id}
	`;

	const [row] = await sql`
		SELECT r.id, r.kind, r.target_mint, r.target_agent, r.threshold,
		       r.deliver_in_app, r.webhook_url, r.webhook_secret, r.telegram_chat,
		       r.cooldown_seconds, r.enabled, r.label, r.created_at, r.updated_at,
		       f.last_fired_at,
		       coalesce(fail.cnt, 0) AS recent_failures,
		       coalesce(rd.deliveries, '[]'::json) AS recent_deliveries
		FROM pump_alert_rules r
		LEFT JOIN pump_alert_rule_fires f ON f.rule_id = r.id
		LEFT JOIN LATERAL (
			SELECT count(*)::int AS cnt FROM pump_alert_deliveries d
			WHERE d.rule_id = r.id AND d.ok = false AND d.created_at > now() - interval '24 hours'
		) fail ON true
		LEFT JOIN LATERAL (
			SELECT json_agg(json_build_object('channel', s.channel, 'ok', s.ok, 'detail', s.detail, 'at', s.created_at) ORDER BY s.created_at DESC) AS deliveries
			FROM (
				SELECT channel, ok, detail, created_at FROM pump_alert_deliveries d2
				WHERE d2.rule_id = r.id ORDER BY created_at DESC LIMIT 5
			) s
		) rd ON true
		WHERE r.id = ${id} AND r.user_id = ${user.id}
	`;
	// The row can be gone by now if a concurrent DELETE landed between the UPDATE
	// and this read. Serializing `undefined` would throw and surface as a 500 on
	// what is really a plain "it's not there anymore".
	if (!row) return error(res, 404, 'not_found', 'rule not found');

	return json(res, 200, { rule: serializeRule(row) });
});
