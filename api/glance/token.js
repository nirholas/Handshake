/**
 * /api/glance/token
 * -----------------
 * The owner's widget tokens: the credential a native home screen widget
 * carries instead of a session (see api/_lib/glance-tokens.js).
 *
 *   GET     list the caller's live tokens (prefix, label, platform, last seen)
 *   POST    mint one: { label?, platform?, agent? }. Answers the plaintext
 *           exactly once, plus the deep links that hand it to a native app
 *           (Android's intent: URL, and the threews:// URL both Apple apps
 *           claim).
 *   PATCH   { id, agent } repoint a token at another owned agent (null = first)
 *   DELETE  ?id=<uuid> revoke one. Idempotent; 404 for an id that is not
 *           the caller's live token.
 *
 * Session only, same-site only: a token is a long-lived credential, so the
 * page that mints it has to be ours. Bearer callers (OAuth, API keys) are not
 * accepted here on purpose; a programmatic client that wants the card reads
 * /api/glance/card with the agent id, which is public.
 */

import { getSessionUser, isSameSiteOrigin } from '../_lib/auth.js';
import {
	createGlanceToken,
	listGlanceTokens,
	revokeGlanceToken,
	pinGlanceToken,
	GLANCE_TOKEN_PLATFORMS,
} from '../_lib/glance-tokens.js';
import { sql } from '../_lib/db.js';
import { cors, json, wrap, method, error, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';

export const ANDROID_PACKAGE = 'ws.three.app';

/**
 * The intent: URL Chrome turns into a launch of the app's link activity. The
 * token rides in the query of a custom-scheme URI that only our package can
 * claim; the fallback sends a phone without the app to the install page.
 */
export function androidLinkUrl(token) {
	const fallback = encodeURIComponent('https://three.ws/seeker?utm_source=glance_link');
	return `intent://glance/link?token=${encodeURIComponent(token)}#Intent;scheme=threews;package=${ANDROID_PACKAGE};S.browser_fallback_url=${fallback};end`;
}

/**
 * The URL that hands the token to an Apple app: the three.ws iPhone app or the
 * three.ws Glance app on a Mac, both of which register the `threews` scheme.
 *
 * There is no intent-style fallback here because neither platform has one: a
 * Mac or an iPhone without the app installed simply does nothing with the URL,
 * which is why /glance also reveals the code for a person to paste. The link
 * activity is native on both platforms (SceneDelegate on iOS, the app delegate
 * on macOS), so the token never reaches the WebView.
 */
export function appleLinkUrl(token) {
	return `threews://glance/link?token=${encodeURIComponent(token)}`;
}

async function ownsAgent(userId, agentId) {
	const rows = await sql`
		SELECT 1 FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
		LIMIT 1
	`;
	return rows.length > 0;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;
	res.setHeader('cache-control', 'private, no-store');

	const session = await getSessionUser(req, res);
	if (!session) return error(res, 401, 'unauthorized', 'sign in to manage widget tokens');
	if (req.method !== 'GET' && !isSameSiteOrigin(req)) {
		return error(res, 403, 'forbidden', 'cross-site request blocked');
	}

	const rl = await limits.widgetWrite(session.id);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many widget token requests');

	if (req.method === 'GET') {
		return json(res, 200, { tokens: await listGlanceTokens(session.id) });
	}

	if (req.method === 'DELETE') {
		const url = new URL(req.url, 'http://x');
		const id = url.searchParams.get('id') || '';
		if (!isUuid(id)) return error(res, 400, 'bad_request', 'id must be a token id');
		const revoked = await revokeGlanceToken({ userId: session.id, tokenId: id });
		if (!revoked) return error(res, 404, 'not_found', 'no live token with that id');
		return json(res, 200, { revoked: true, id });
	}

	let body;
	try {
		body = await readJson(req, 4096);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	let agentId = null;
	if (body.agent !== undefined && body.agent !== null && body.agent !== '') {
		if (!isUuid(body.agent)) return error(res, 400, 'bad_request', 'agent must be an agent id');
		if (!(await ownsAgent(session.id, body.agent))) {
			return error(res, 404, 'not_found', 'that agent is not yours');
		}
		agentId = body.agent;
	}

	if (req.method === 'PATCH') {
		if (!isUuid(body.id)) return error(res, 400, 'bad_request', 'id must be a token id');
		const pinned = await pinGlanceToken({ userId: session.id, tokenId: body.id, agentId });
		if (!pinned) return error(res, 404, 'not_found', 'no live token with that id');
		return json(res, 200, { id: body.id, agentId });
	}

	const platform = GLANCE_TOKEN_PLATFORMS.has(body.platform) ? body.platform : 'other';
	try {
		const minted = await createGlanceToken({
			userId: session.id,
			label: typeof body.label === 'string' ? body.label : '',
			platform,
			agentId,
		});
		return json(res, 201, {
			...minted,
			links: { android: androidLinkUrl(minted.token), apple: appleLinkUrl(minted.token) },
		});
	} catch (e) {
		if (e.code === 'too_many_tokens') return error(res, 409, e.code, e.message);
		throw e;
	}
});
