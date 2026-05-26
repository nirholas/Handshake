// POST /api/aws-marketplace/link
//
// Called by the /aws-marketplace/welcome page after the user authenticates.
// Links an existing aws_marketplace_customers row to the signed-in user account.
//
// Body (JSON): { customer: "<customerIdentifier>" }
// Requires an active session cookie (set by /api/auth/login or /api/auth/register).

import { cors, json, readJson, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;

	if (req.method !== 'POST') {
		res.statusCode = 405;
		res.setHeader('allow', 'POST');
		res.end();
		return;
	}

	let user;
	try {
		user = await getSessionUser(req);
	} catch {
		return json(res, 401, { error: 'unauthenticated' });
	}

	let body;
	try {
		body = await readJson(req);
	} catch {
		return json(res, 400, { error: 'invalid_json' });
	}

	const { customer: customerId } = body;
	if (!customerId || typeof customerId !== 'string') {
		return json(res, 400, { error: 'missing_customer' });
	}

	const [row] = await sql`
		SELECT customer_identifier, subscription_status
		FROM aws_marketplace_customers
		WHERE customer_identifier = ${customerId}
	`;

	if (!row) {
		return json(res, 404, { error: 'customer_not_found' });
	}

	if (row.subscription_status === 'cancelled' || row.subscription_status === 'expired') {
		return json(res, 409, { error: 'subscription_inactive', status: row.subscription_status });
	}

	await sql`
		UPDATE aws_marketplace_customers
		SET user_id    = ${user.id},
		    updated_at = now()
		WHERE customer_identifier = ${customerId}
		  AND (user_id IS NULL OR user_id = ${user.id})
	`;

	return json(res, 200, { ok: true });
});
