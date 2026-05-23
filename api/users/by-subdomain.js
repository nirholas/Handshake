// GET /api/users/by-subdomain?label=<label>[&parent=threews]
//
// Reverse-lookup: given a `<label>.<parent>.sol` claim, return the user_id +
// username that owns it (public fields only). Powers the /u/:label showcase
// when accessed via a SNS-resolved Brave URL.

import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { PARENT_LABEL, normalizeLabel } from '../_lib/threews-sns.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.snsResolve(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const label = normalizeLabel(url.searchParams.get('label'));
	const parent = (url.searchParams.get('parent') || PARENT_LABEL).toLowerCase();
	if (!label) return error(res, 400, 'validation_error', 'label required');

	const [row] = await sql`
		SELECT s.label, s.parent, s.owner_wallet, s.url_record, s.created_at,
		       u.id AS user_id, u.username, u.display_name
		FROM user_subdomains s
		JOIN users u ON u.id = s.user_id
		WHERE s.label = ${label} AND s.parent = ${parent}
		LIMIT 1
	`;
	if (!row) return error(res, 404, 'not_found', `${label}.${parent}.sol is not claimed`);

	return json(res, 200, {
		data: {
			label: row.label,
			parent: row.parent,
			full: `${row.label}.${row.parent}.sol`,
			user: {
				id: row.user_id,
				username: row.username,
				display_name: row.display_name,
			},
			owner_wallet: row.owner_wallet,
			url_record: row.url_record,
			created_at: row.created_at,
		},
	}, { 'cache-control': 'public, max-age=120' });
});
