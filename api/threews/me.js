// GET /api/threews/me
//
// Returns the authenticated caller's `*.threews.sol` subdomain claim, if any.
// Powers the dashboard widget that shows "your subdomain" without making the
// caller pass their own label as a query parameter.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { PARENT_LABEL, fullDomain } from '../_lib/threews-sns.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const [user] = await sql`
		SELECT id, username, display_name FROM users
		WHERE id = ${auth.userId} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!user) return error(res, 404, 'not_found', 'user not found');

	const [claim] = await sql`
		SELECT label, parent, owner_wallet, url_record, signature, created_at
		FROM user_subdomains
		WHERE user_id = ${auth.userId} AND parent = ${PARENT_LABEL}
		ORDER BY created_at ASC
		LIMIT 1
	`;

	return json(res, 200, {
		data: {
			user: { id: user.id, username: user.username, display_name: user.display_name },
			parent: PARENT_LABEL,
			has_claim: !!claim,
			claim: claim
				? {
						...claim,
						full: fullDomain(claim.label),
						showcase_url: `${env.APP_ORIGIN}/u/${user.username}`,
						explorer: `https://solscan.io/tx/${claim.signature}`,
					}
				: null,
			claim_url: !claim && user.username ? `${env.APP_ORIGIN}/threews/claim` : null,
		},
	});
});
