// GET    /api/developer/webhooks/:id — webhook details + recent deliveries
// PATCH  /api/developer/webhooks/:id — update webhook (url, events, active, description)
// DELETE /api/developer/webhooks/:id — delete webhook

import { cors, error, json, method, readJson, wrap } from '../../_lib/http.js';
import { getSessionUser } from '../../_lib/auth.js';
import { sql } from '../../_lib/db.js';
import { EVENT_TYPES } from '../../_lib/webhook-dispatch.js';

const URL_MAX_LENGTH = 2048;

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,PATCH,DELETE,OPTIONS', credentials: true })) return;

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'Sign in required');

	const url = new URL(req.url, 'http://x');
	const id = url.searchParams.get('id') || extractId(url.pathname);
	if (!id) return error(res, 400, 'bad_request', 'Webhook ID required');

	const [webhook] = await sql`
		select id, url, events, active, description, created_at, updated_at
		from developer_webhooks
		where id = ${id} and user_id = ${user.id}
	`;
	if (!webhook) return error(res, 404, 'not_found', 'Webhook not found');

	if (req.method === 'GET') {
		const deliveries = await sql`
			select id, event_type, event_id, status_code, error, attempt, created_at
			from webhook_deliveries
			where webhook_id = ${id}
			order by created_at desc
			limit 50
		`;
		return json(res, 200, { webhook, deliveries });
	}

	if (req.method === 'PATCH') {
		let body;
		try {
			body = await readJson(req, 5000);
		} catch (e) {
			return error(res, e.status || 400, 'bad_request', e.message);
		}

		const updates = {};
		if (typeof body.url === 'string') {
			const trimmed = body.url.trim();
			if (trimmed.length > URL_MAX_LENGTH) return error(res, 400, 'bad_request', 'URL too long');
			try {
				const parsed = new URL(trimmed);
				if (parsed.protocol !== 'https:') return error(res, 400, 'bad_request', 'Must use HTTPS');
			} catch {
				return error(res, 400, 'bad_request', 'Invalid URL');
			}
			updates.url = trimmed;
		}
		if (Array.isArray(body.events)) {
			updates.events = body.events.filter((e) => EVENT_TYPES.includes(e));
		}
		if (typeof body.active === 'boolean') {
			updates.active = body.active;
		}
		if (typeof body.description === 'string') {
			updates.description = body.description.trim().slice(0, 200);
		}

		if (!Object.keys(updates).length) {
			return json(res, 200, { webhook });
		}

		const [updated] = await sql`
			update developer_webhooks set
				url = ${updates.url ?? webhook.url},
				events = ${updates.events ?? webhook.events},
				active = ${updates.active ?? webhook.active},
				description = ${updates.description !== undefined ? updates.description : webhook.description},
				updated_at = now()
			where id = ${id} and user_id = ${user.id}
			returning id, url, events, active, description, created_at, updated_at
		`;
		return json(res, 200, { webhook: updated });
	}

	if (req.method === 'DELETE') {
		await sql`delete from developer_webhooks where id = ${id} and user_id = ${user.id}`;
		return json(res, 200, { deleted: true });
	}

	return method(req, res, ['GET', 'PATCH', 'DELETE']);
});

function extractId(pathname) {
	const m = pathname.match(/\/webhooks\/([^/]+)/);
	return m ? m[1] : null;
}
