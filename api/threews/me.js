// GET /api/threews/me
//
// Returns the authenticated caller's `*.threews.sol` subdomain claim, if any.
// Powers the /threews/claim page's "your subdomain" state without making the
// caller pass their own label as a query parameter.
//
// `status` is the field to branch on:
//   claimed        → `claim` holds the minted name, showcase URL and tx link.
//   available      → no claim yet and the account has a username; `claim_url`
//                    points at the page that mints it.
//   needs_username → the account has no username, so a mint would 409;
//                    `blocked_reason` says so in words a UI can render.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
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

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

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

	// Three terminal states, all of them named. A widget that only got
	// `claim: null` could not tell "go claim one" apart from "you can't yet",
	// and a user with no username would silently see a dead button that 409s.
	const status = claim ? 'claimed' : user.username ? 'available' : 'needs_username';

	return json(res, 200, {
		data: {
			user: { id: user.id, username: user.username, display_name: user.display_name },
			parent: PARENT_LABEL,
			status,
			has_claim: !!claim,
			claim: claim
				? {
						...claim,
						full: fullDomain(claim.label),
						// A username can be changed after the mint, so fall back to the
						// URL record actually written on-chain rather than /u/null.
						showcase_url: user.username ? `${env.APP_ORIGIN}/u/${user.username}` : claim.url_record,
						explorer: claim.signature ? `https://solscan.io/tx/${claim.signature}` : null,
					}
				: null,
			claim_url: status === 'available' ? `${env.APP_ORIGIN}/threews/claim` : null,
			// Rendered verbatim by the claim page, so this one reads as a sentence
			// rather than following the lowercase house style of `error_description`.
			blocked_reason:
				status === 'needs_username' ? 'Set a username on your account before claiming a subdomain.' : null,
		},
	});
});
