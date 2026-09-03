/**
 * GET /api/glance/mine
 * --------------------
 * The card for the signed-in owner's agent, plus the list of agents they could
 * point a widget at instead. This is what the widget hosts call: a home
 * screen slot has no UI to pick an agent in, so the platform answers "your
 * agent" and lets the owner change it from the page.
 *
 * Who is asking, in order:
 *   1. a widget token (`Authorization: Bearer glw_…` or `?token=glw_…`), the
 *      credential a native widget carries because it has no session;
 *   2. the session cookie, which is what the Windows widget worker sends.
 *
 *   ?agent=<uuid>          pin a specific agent (must be one the caller owns)
 *   ?format=json | png     default json
 *   &size=small|medium|large   png only, default medium
 *   &theme=dark|light          png only, default dark
 *   &scale=1|2|3               png only, default 2 (pixel density)
 *
 * Every state is a designed answer, never a 401: signed out, an unlinked or
 * revoked token, and an account with no agent yet all get a card that says
 * what to do next, because a widget that renders an error is a widget people
 * remove. JSON carries `state` so a caller can branch; PNG carries the same
 * in `x-glance-state` plus the tap target in `x-glance-url`, so a native
 * widget learns everything it needs from the one request that fetched the
 * bitmap.
 */

import { loadGlanceCard, noticeCard } from '../_lib/glance-card.js';
import { glancePng, pngOptions } from '../_lib/glance-png.js';
import { resolveGlanceToken, looksLikeGlanceToken } from '../_lib/glance-tokens.js';
import { getSessionUser, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, wrap, method, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';

const SITE = 'https://three.ws';
const SIGN_IN_URL = `${SITE}/login?next=%2Fglance`;
const CREATE_URL = `${SITE}/create`;

// Where a widget with no working credential sends the person who taps it. The
// page can start the hand-off on its own if it knows which shell is asking, so
// the widget says: `?platform=ios` and `macos` open the Apple flow, anything
// else opens the Android one, which is what the shipped 1.1 APK gets by sending
// nothing at all.
const LINK_FLOWS = { android: 'android', ios: 'apple', macos: 'apple' };
export function linkUrl(platform) {
	return `${SITE}/glance?link=${LINK_FLOWS[platform] || 'android'}`;
}

export const GLANCE_STATES = {
	signedOut: 'signed-out',
	unlinked: 'unlinked',
	noAgent: 'no-agent',
	agent: 'agent',
};

/** The notice card for each non-agent state. Exported for the tests. */
export function stateCard(state, platform) {
	if (state === GLANCE_STATES.unlinked) {
		return noticeCard({
			name: 'Widget unlinked',
			headline: 'Tap to link this widget to your account again.',
			description: 'This widget no longer has access to your agent.',
			url: linkUrl(platform),
		});
	}
	if (state === GLANCE_STATES.noAgent) {
		return noticeCard({
			name: 'No agent yet',
			headline: 'Tap to create your first agent.',
			description: 'Your agent will live here, with its moves for the day.',
			url: CREATE_URL,
		});
	}
	return noticeCard({
		name: 'three.ws',
		headline: 'Sign in to see your agent here.',
		description: 'Your agent, one live number, one tap back in.',
		url: SIGN_IN_URL,
	});
}

/**
 * Resolve the caller. A token that is presented but not live answers the
 * unlinked state even when a session cookie is also present: the widget that
 * sent it needs to learn that its credential is gone.
 */
async function resolveCaller(req, res, url) {
	// Only a bearer shaped like a widget token is one; any other bearer (an
	// OAuth access token, an API key) is ignored here and the session decides.
	// An explicit ?token= is always a widget's claim, so a malformed one is
	// answered as unlinked rather than as a stranger's signed-out card.
	const bearer = extractBearer(req);
	const query = url.searchParams.get('token') || '';
	const presented = looksLikeGlanceToken(bearer) ? bearer : query;
	if (presented) {
		const token = looksLikeGlanceToken(presented) ? await resolveGlanceToken(presented) : null;
		if (!token) return { state: GLANCE_STATES.unlinked };
		return { userId: token.userId, pinnedAgentId: token.agentId, via: 'token' };
	}
	const session = await getSessionUser(req, res);
	if (!session) return { state: GLANCE_STATES.signedOut };
	return { userId: session.id, pinnedAgentId: null, via: 'session' };
}

export default wrap(async (req, res) => {
	// credentials: the Windows widget worker sends the session cookie, and a
	// native widget sends its token, so the response is per-caller and must
	// never be shared by a cache.
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	res.setHeader('cache-control', 'private, no-store');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many card reads');

	const url = new URL(req.url, 'http://x');
	const format = url.searchParams.get('format') === 'png' ? 'png' : 'json';

	// Only ever narrows the tap target of a notice card; a card with an agent on
	// it already points at that agent on every platform.
	const platform = url.searchParams.get('platform') || '';

	const caller = await resolveCaller(req, res, url);
	if (caller.state) {
		return respond(res, format, url, { state: caller.state, card: stateCard(caller.state, platform), agents: [], platform });
	}

	const owned = await sql`
		SELECT id, name
		FROM agent_identities
		WHERE user_id = ${caller.userId} AND deleted_at IS NULL
		ORDER BY created_at ASC
		LIMIT 25
	`;

	// A pinned agent the caller does not own falls back to their own first
	// agent rather than erroring: the widget keeps working after an agent is
	// deleted or a different account signs in on the same device. The query
	// string wins over the token's pin so the page can preview any owned agent.
	const requested = url.searchParams.get('agent') || caller.pinnedAgentId || '';
	const pinned = isUuid(requested) && owned.some((a) => a.id === requested) ? requested : null;
	const target = pinned || owned[0]?.id || null;

	if (!target) {
		return respond(res, format, url, { state: GLANCE_STATES.noAgent, card: stateCard(GLANCE_STATES.noAgent, platform), agents: [], platform });
	}

	const card = await loadGlanceCard(target);
	if (!card) {
		return respond(res, format, url, { state: GLANCE_STATES.noAgent, card: stateCard(GLANCE_STATES.noAgent, platform), agents: owned, platform });
	}
	return respond(res, format, url, { state: GLANCE_STATES.agent, card, agents: owned, via: caller.via, platform });
});

async function respond(res, format, url, { state, card, agents, via = null, platform = '' }) {
	if (format === 'png') {
		const opts = pngOptions(url.searchParams);
		const { png, width, height, etag, cache } = await glancePng(card, opts);
		res.statusCode = 200;
		res.setHeader('content-type', 'image/png');
		res.setHeader('content-length', String(png.length));
		res.setHeader('etag', etag);
		res.setHeader('x-glance-state', state);
		res.setHeader('x-glance-url', card.url);
		res.setHeader('x-glance-name', headerSafe(card.name));
		res.setHeader('x-glance-metric', `${card.metric.value} ${headerSafe(card.metric.label)}`);
		res.setHeader('x-glance-agent', state === GLANCE_STATES.agent ? card.id : '');
		res.setHeader('x-glance-updated', card.updatedAt);
		res.setHeader('x-glance-width', String(width));
		res.setHeader('x-glance-height', String(height));
		res.setHeader('x-glance-cache', cache);
		return res.end(png);
	}

	const signedIn = state !== GLANCE_STATES.signedOut && state !== GLANCE_STATES.unlinked;
	return json(res, 200, {
		signedIn,
		state,
		via,
		card: state === GLANCE_STATES.agent ? card : null,
		notice: state === GLANCE_STATES.agent ? null : card,
		agents: agents.map((a) => ({ id: a.id, name: a.name })),
		signInUrl: SIGN_IN_URL,
		createUrl: CREATE_URL,
		linkUrl: linkUrl(platform),
	});
}

// Header values are ASCII: agent names are anything, so the header carries a
// readable approximation and the bitmap carries the real name.
function headerSafe(value) {
	return String(value ?? '')
		.replace(/[^\x20-\x7e]/g, '')
		.slice(0, 120);
}
