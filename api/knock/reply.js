// GET /api/knock/reply?id=<knock id>&token=<receipt token>
//
// The other half of the door, for the sender. Whoever holds the receipt URL a
// knock returned can read what became of it: still pending, dismissed, or
// answered, and the answer itself when there is one. No session, no account,
// nothing about the recipient beyond what they chose to write back.
//
// The token is an HMAC over the knock id (api/_lib/knock/receipt.js), so a
// wrong or absent token is a 404 rather than a 403: an id alone should not
// confirm that a knock exists.

import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { receiptValid } from '../_lib/knock/receipt.js';
import { formatUsdc } from '../_lib/knock/policy.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.knockPublic(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const id = String(params.get('id') || '').trim();
	const token = String(params.get('token') || '').trim();
	const notFound = () => error(res, 404, 'not_found', 'no knock for that receipt');

	if (!/^[0-9a-f-]{36}$/i.test(id) || !token || !receiptValid(id, token)) return notFound();

	const [row] = await sql`
		select id, subject, status, reply_text, replied_at, read_at, created_at,
		       amount_atomics::text as amount_atomics
		from knock_messages where id = ${id}
	`;
	if (!row) return notFound();

	return json(res, 200, {
		knock: {
			id: row.id,
			subject: row.subject,
			status: row.status,
			// Only ever the reply the owner deliberately wrote. Never their
			// name, wallet, or anything else about the account behind the door.
			reply: row.status === 'replied' ? row.reply_text : null,
			replied_at: row.replied_at,
			seen: Boolean(row.read_at),
			amount: formatUsdc(row.amount_atomics),
			created_at: row.created_at,
		},
	}, { 'cache-control': 'no-store' });
});
