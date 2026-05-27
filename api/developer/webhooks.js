// GET  /api/developer/webhooks — list user's registered webhooks
// POST /api/developer/webhooks — create a new webhook

import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { getSessionUser } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { randomToken } from '../_lib/crypto.js';
import { EVENT_TYPES } from '../_lib/webhook-dispatch.js';

const MAX_WEBHOOKS_PER_USER = 10;
const URL_MAX_LENGTH = 2048;

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'Sign in required');

	if (req.method === 'GET') {
		const webhooks = await sql`
			select id, url, events, active, description, created_at, updated_at
			from developer_webhooks
			where user_id = ${user.id}
			order by created_at desc
		`;

		const withStats = await Promise.all(webhooks.map(async (wh) => {
			const [stats] = await sql`
				select
					count(*)::int as total,
					count(*) filter (where status_code between 200 and 299)::int as succeeded,
					count(*) filter (where status_code is null or status_code >= 400)::int as failed,
					max(created_at) as last_delivery_at
				from webhook_deliveries
				where webhook_id = ${wh.id} and created_at > now() - interval '7 days'
			`;
			return { ...wh, stats_7d: stats };
		}));

		return json(res, 200, { webhooks: withStats, event_types: EVENT_TYPES });
	}

	if (!method(req, res, ['POST'])) return;

	let body;
	try {
		body = await readJson(req, 5000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const url = typeof body.url === 'string' ? body.url.trim() : '';
	if (!url) return error(res, 400, 'bad_request', 'url is required');
	if (url.length > URL_MAX_LENGTH) return error(res, 400, 'bad_request', `url exceeds ${URL_MAX_LENGTH} characters`);

	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:') {
			return error(res, 400, 'bad_request', 'Webhook URL must use HTTPS');
		}
	} catch {
		return error(res, 400, 'bad_request', 'Invalid URL');
	}

	const events = Array.isArray(body.events) ? body.events.filter((e) => EVENT_TYPES.includes(e)) : [];
	const description = typeof body.description === 'string' ? body.description.trim().slice(0, 200) : null;

	const [{ count: existing }] = await sql`
		select count(*)::int as count from developer_webhooks where user_id = ${user.id}
	`;
	if (existing >= MAX_WEBHOOKS_PER_USER) {
		return error(res, 409, 'limit_reached', `Maximum ${MAX_WEBHOOKS_PER_USER} webhooks per account`);
	}

	const secret = `whsec_${randomToken(24)}`;

	const [webhook] = await sql`
		insert into developer_webhooks (user_id, url, secret, events, description)
		values (${user.id}, ${url}, ${secret}, ${events}, ${description})
		returning id, url, events, active, description, created_at
	`;

	return json(res, 201, { webhook: { ...webhook, secret } });
});
