// GET  /api/alerts/rules — list the signed-in user's pump alert rules.
// POST /api/alerts/rules — create a new rule.
//
// Server-persisted, multi-rule alert model (Task 04). Rules are evaluated by the
// pumpfun-monitor cron against the live pump.fun event stream, so they fire
// across devices even with no dashboard tab open. The frontend treats
// localStorage as a render cache only; these endpoints are the source of truth.

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { randomToken } from '../_lib/crypto.js';
import { createRuleSchema, normalizeForKind, rulesMissingWebhookSecret, serializeRule } from './_rules.js';

const MAX_RULES_PER_USER = 50;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const rl = await limits.notificationsRead(user.id);
		if (!rl.success) return rateLimited(res, rl);
		const rows = await listRules(user.id);
		await healWebhookSecrets(rows);
		return json(res, 200, { rules: rows.map(serializeRule) });
	}

	// POST — create
	const rl = await limits.prefsWrite(user.id);
	if (!rl.success) return rateLimited(res, rl);
	if (!(await requireCsrf(req, res, user.id))) return;

	const body = normalizeForKind(parse(createRuleSchema, await readJson(req)));

	if (body.target_agent) {
		const [agent] = await sql`SELECT 1 AS ok FROM agent_identities WHERE id = ${body.target_agent}`;
		if (!agent) return error(res, 400, 'validation_error', 'target_agent does not exist');
	}

	const [{ count }] = await sql`SELECT count(*)::int AS count FROM pump_alert_rules WHERE user_id = ${user.id}`;
	if (count >= MAX_RULES_PER_USER) {
		return error(res, 409, 'limit_reached', `you can have at most ${MAX_RULES_PER_USER} alert rules`);
	}

	// Generate a per-rule signing secret when a webhook is configured so the
	// receiver can verify the webhook-signature header.
	const webhookSecret = body.webhook_url ? `whsec_${randomToken(24)}` : null;

	const [row] = await sql`
		INSERT INTO pump_alert_rules
			(user_id, kind, target_mint, target_agent, threshold, deliver_in_app,
			 webhook_url, webhook_secret, telegram_chat, cooldown_seconds, enabled, label)
		VALUES
			(${user.id}, ${body.kind}, ${body.target_mint || null}, ${body.target_agent || null},
			 ${body.threshold ?? null}, ${body.deliver_in_app}, ${body.webhook_url || null},
			 ${webhookSecret}, ${body.telegram_chat || null}, ${body.cooldown_seconds},
			 ${body.enabled}, ${body.label || null})
		RETURNING id, kind, target_mint, target_agent, threshold, deliver_in_app,
		          webhook_url, webhook_secret, telegram_chat, cooldown_seconds, enabled,
		          label, created_at, updated_at
	`;

	return json(res, 201, { rule: serializeRule({ ...row, last_fired_at: null, recent_failures: 0, recent_deliveries: [] }) });
});

/**
 * Back-fill a signing secret for any listed rule that has a webhook but none,
 * mutating the rows in place so the caller serializes the healed value. Those
 * rules deliver unsigned webhooks until this runs, and this list response is
 * where the user reads the secret to configure verification on their receiver.
 * Costs nothing in the normal case: the scan is in-memory and issues no query
 * unless a rule is actually missing its secret.
 */
async function healWebhookSecrets(rows) {
	for (const row of rulesMissingWebhookSecret(rows)) {
		const secret = `whsec_${randomToken(24)}`;
		const [updated] = await sql`
			UPDATE pump_alert_rules SET webhook_secret = ${secret}, updated_at = now()
			WHERE id = ${row.id} AND webhook_secret IS NULL
			RETURNING webhook_secret, updated_at
		`;
		if (updated) {
			row.webhook_secret = updated.webhook_secret;
			row.updated_at = updated.updated_at;
		}
	}
}

async function listRules(userId) {
	return sql`
		SELECT r.id, r.kind, r.target_mint, r.target_agent, r.threshold,
		       r.deliver_in_app, r.webhook_url, r.webhook_secret, r.telegram_chat,
		       r.cooldown_seconds, r.enabled, r.label, r.created_at, r.updated_at,
		       f.last_fired_at,
		       coalesce(fail.cnt, 0) AS recent_failures,
		       coalesce(rd.deliveries, '[]'::json) AS recent_deliveries
		FROM pump_alert_rules r
		LEFT JOIN pump_alert_rule_fires f ON f.rule_id = r.id
		LEFT JOIN LATERAL (
			SELECT count(*)::int AS cnt
			FROM pump_alert_deliveries d
			WHERE d.rule_id = r.id AND d.ok = false AND d.created_at > now() - interval '24 hours'
		) fail ON true
		LEFT JOIN LATERAL (
			SELECT json_agg(json_build_object('channel', s.channel, 'ok', s.ok, 'detail', s.detail, 'at', s.created_at) ORDER BY s.created_at DESC) AS deliveries
			FROM (
				SELECT channel, ok, detail, created_at
				FROM pump_alert_deliveries d2
				WHERE d2.rule_id = r.id
				ORDER BY created_at DESC
				LIMIT 5
			) s
		) rd ON true
		WHERE r.user_id = ${userId}
		ORDER BY r.created_at DESC
	`;
}
