// GET /api/alerts/config — the signed-in user's pump alert rules.
// PUT /api/alerts/config — upsert those rules.
//
// Server-persisted so alerts survive across devices and so the pumpfun-monitor
// cron can evaluate them when no dashboard tab is open. The frontend treats
// localStorage as a render cache only; this endpoint is the source of truth.

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { z } from 'zod';

const DEFAULTS = {
	graduation: true,
	whale: false,
	fees: false,
	launch: false,
	whaleThreshold: 10,
	claimThreshold: 0.5,
	cooldown: 30,
	webhookUrl: null,
};

const putSchema = z.object({
	graduation: z.boolean(),
	whale: z.boolean(),
	fees: z.boolean(),
	launch: z.boolean(),
	whaleThreshold: z.coerce.number().min(0).max(1_000_000),
	claimThreshold: z.coerce.number().min(0).max(1_000_000),
	cooldown: z.coerce.number().int().min(5).max(86_400),
	webhookUrl: z
		.string()
		.trim()
		.max(2048)
		.url()
		.refine((u) => /^https:\/\//i.test(u), 'webhook must be https')
		.optional()
		.nullable()
		.or(z.literal('').transform(() => null)),
});

function rowToConfig(row) {
	if (!row) return { ...DEFAULTS };
	return {
		graduation: row.graduation,
		whale: row.whale,
		fees: row.fees,
		launch: row.launch,
		whaleThreshold: Number(row.whale_threshold),
		claimThreshold: Number(row.claim_threshold),
		cooldown: row.cooldown_seconds,
		webhookUrl: row.webhook_url || null,
		updated_at: row.updated_at || null,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PUT,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.prefsWrite(user.id);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (req.method === 'GET') {
		const [row] = await sql`
			SELECT graduation, whale, fees, launch, whale_threshold, claim_threshold,
			       cooldown_seconds, webhook_url, updated_at
			FROM user_alert_configs
			WHERE user_id = ${user.id}
		`;
		return json(res, 200, { data: rowToConfig(row) });
	}

	// PUT — upsert
	if (!(await requireCsrf(req, res, user.id))) return;

	const body = parse(putSchema, await readJson(req));
	const webhook = body.webhookUrl ?? null;

	const [row] = await sql`
		INSERT INTO user_alert_configs
			(user_id, graduation, whale, fees, launch, whale_threshold, claim_threshold, cooldown_seconds, webhook_url, updated_at)
		VALUES
			(${user.id}, ${body.graduation}, ${body.whale}, ${body.fees}, ${body.launch},
			 ${body.whaleThreshold}, ${body.claimThreshold}, ${body.cooldown}, ${webhook}, now())
		ON CONFLICT (user_id) DO UPDATE SET
			graduation       = excluded.graduation,
			whale            = excluded.whale,
			fees             = excluded.fees,
			launch           = excluded.launch,
			whale_threshold  = excluded.whale_threshold,
			claim_threshold  = excluded.claim_threshold,
			cooldown_seconds = excluded.cooldown_seconds,
			webhook_url      = excluded.webhook_url,
			updated_at       = now()
		RETURNING graduation, whale, fees, launch, whale_threshold, claim_threshold,
		          cooldown_seconds, webhook_url, updated_at
	`;

	return json(res, 200, { data: rowToConfig(row) });
});
