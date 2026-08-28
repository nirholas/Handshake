/**
 * GET /api/glance/mine
 * --------------------
 * The card for the signed-in owner's agent, plus the list of agents they could
 * point a widget at instead. This is what the widget service worker calls: a
 * home screen slot has no UI to pick an agent in, so the platform answers
 * "your agent" and lets the owner change it from the page.
 *
 *   ?agent=<uuid>   pin a specific agent (must be one the caller owns)
 *
 * Signed out is a designed answer, not a 401: the widget shows a card that
 * says sign in, because a widget that renders an error is a widget people
 * remove. The response carries `signedIn` so the caller can branch.
 */

import { loadGlanceCard } from '../_lib/glance-card.js';
import { getSessionUser } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, wrap, method, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	// credentials: the widget SW sends the session cookie, so the response is
	// per-user and must never be shared by a cache.
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	res.setHeader('cache-control', 'private, no-store');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many card reads');

	const session = await getSessionUser(req, res);
	if (!session) {
		return json(res, 200, {
			signedIn: false,
			card: null,
			agents: [],
			signInUrl: 'https://three.ws/login',
			createUrl: 'https://three.ws/create',
		});
	}

	const owned = await sql`
		SELECT id, name
		FROM agent_identities
		WHERE user_id = ${session.id} AND deleted_at IS NULL
		ORDER BY created_at ASC
		LIMIT 25
	`;

	const url = new URL(req.url, 'http://x');
	const requested = url.searchParams.get('agent') || '';
	// A pinned agent the caller does not own falls back to their own first
	// agent rather than erroring: the widget keeps working after an agent is
	// deleted or a different account signs in on the same device.
	const pinned = isUuid(requested) && owned.some((a) => a.id === requested) ? requested : null;
	const target = pinned || owned[0]?.id || null;

	return json(res, 200, {
		signedIn: true,
		card: target ? await loadGlanceCard(target) : null,
		agents: owned.map((a) => ({ id: a.id, name: a.name })),
		signInUrl: 'https://three.ws/login',
		createUrl: 'https://three.ws/create',
	});
});
