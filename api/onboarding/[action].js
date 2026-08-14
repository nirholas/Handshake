// Consolidated onboarding endpoints (avaturn-session + link-avatar).

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { env } from '../_lib/env.js';

// ── avaturn-session ───────────────────────────────────────────────────────────

const dataUrl = z.string().max(2_500_000).regex(/^data:image\/(jpeg|png);base64,/i, 'must be a data:image/(jpeg|png);base64 url');
const avaturnSchema = z.object({
	photos: z.object({ frontal: dataUrl, left: dataUrl, right: dataUrl }),
	body_type: z.enum(['male', 'female']).default('male'),
	avatar_type: z.enum(['v1', 'v2']).default('v1'),
});

// Both onboarding actions write on the caller's behalf (one spends the avatar
// provider's quota, the other repoints which body an agent wears), so both take
// the same credential rules: a browser session, or a bearer credential carrying
// the avatars:write grant. Keeping that in one resolver is what stops the two
// from drifting apart: link-avatar previously accepted ANY bearer credential, so
// a read-only `avatars:read` API key could rewrite an agent's avatar link even
// though the handler directly above it had always demanded avatars:write.
//
// A bearer that authenticates but lacks the grant is a scope failure (403), not
// an identity failure (401): answering 401 sends a machine client back to a token
// exchange that would mint the exact same token again. Mirrors the 403
// `insufficient_scope` answer in api/erc8004/[action].js and api/agents.js.
//
// Both actions are cookie-session-reachable POSTs that change server state, so
// both also need the double-submit CSRF check every other session mutation in
// api/ carries (api/avatars/_actions.js, api/friends/index.js). Without it a
// cross-site form POST rode the victim's cookie: link-avatar would repoint their
// agent's body (force:true even overrides an existing link) and avaturn-session
// would burn their avatar-provider quota, both while the attacker page ignored
// the CORS-blocked response it never needed to read. requireCsrf() exempts
// bearer callers, so API-key clients are unaffected.
// Returns the user id, or null after having already written the error response.
async function resolveOnboardingUser(req, res, signInMessage) {
	const userId = await resolveIdentity(req, res, signInMessage);
	if (!userId) return null;
	if (!(await requireCsrf(req, res, userId))) return null;
	return userId;
}

async function resolveIdentity(req, res, signInMessage) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) {
		error(res, 401, 'unauthorized', signInMessage);
		return null;
	}
	if (!hasScope(bearer.scope, 'avatars:write')) {
		error(res, 403, 'insufficient_scope', 'avatars:write scope required');
		return null;
	}
	return bearer.userId;
}

async function handleAvaturnSession(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolveOnboardingUser(req, res, 'sign in to create an avatar');
	if (!userId) return;
	// The not-configured check precedes the limiters on purpose: where the key is
	// absent no request can ever succeed, so charging the caller's hourly upload
	// budget for a guaranteed 501 only locks them out of the flow for an hour
	// once the operator does set the key.
	if (!env.AVATURN_API_KEY) return error(res, 501, 'not_configured', 'Avatar editor is not available right now. Please try again later.');
	const rlUser = await limits.upload(userId);
	if (!rlUser.success) return rateLimited(res, rlUser, 'too many avatar attempts, try again later');
	const rlIp = await limits.authIp(clientIp(req));
	if (!rlIp.success) return rateLimited(res, rlIp, 'too many requests from this network');
	const body = parse(avaturnSchema, await readJson(req, 8_000_000));
	try {
		const session = await createProviderSession(userId, body);
		return json(res, 200, { session_url: session.sessionUrl, expires_at: session.expiresAt });
	} catch (err) {
		// A bare fetch rejection (DNS, TLS, socket timeout) carries no status; it is
		// still our side of the call failing, so it takes the 502 path below.
		const status = err.status || 502;
		if (status >= 500) console.error(`[avaturn-session] provider call failed: ${err.message}`);
		if (status === 429) {
			return json(
				res,
				429,
				{ error: 'upstream_busy', error_description: 'the avatar provider is busy, try again shortly' },
				{ 'cache-control': 'no-store', 'retry-after': err.retryAfter },
			);
		}
		// Never hand a provider-side fault down as the caller's own message: it is
		// ours to fix and its text can carry provider internals.
		if (status >= 500) return error(res, 502, 'upstream_error', 'the avatar provider is unavailable right now');
		return error(res, status, err.code || 'upstream_rejected', err.message);
	}
}

// Statuses that mean the CALLER's photos were the problem, so the provider's own
// wording is worth passing through. Everything else (401/403 from our
// AVATURN_API_KEY, 404 from our URL, any 5xx from their outage) is a server-side
// fault. The first version mirrored those statuses verbatim, which meant a
// rejected API key reached the browser as a 401 and src/avaturn-client.js mapped
// it to its 'auth' code, pushing a correctly signed-in user at a sign-in that
// could never fix anything. Worse, only >=500 was logged, so a revoked key failed
// silently and looked like a user problem in every report.
const CALLER_FIXABLE_UPSTREAM = new Set([400, 413, 415, 422]);

async function createProviderSession(userId, body) {
	const upstream = await fetch(`${env.AVATURN_API_URL}/api/v1/sessions`, {
		method: 'POST',
		headers: { authorization: `Bearer ${env.AVATURN_API_KEY}`, 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ external_user_id: userId, photos: body.photos, body_type: body.body_type, version: body.avatar_type }),
	});
	if (!upstream.ok) {
		const detail = (await upstream.text().catch(() => '')).slice(0, 200);
		if (CALLER_FIXABLE_UPSTREAM.has(upstream.status)) {
			throw Object.assign(new Error(detail || 'the avatar provider rejected these photos'), {
				status: 400,
				code: 'upstream_rejected',
			});
		}
		if (upstream.status === 429) {
			throw Object.assign(new Error(`avaturn upstream 429: ${detail}`), {
				status: 429,
				retryAfter: upstream.headers.get('retry-after') || '30',
			});
		}
		throw Object.assign(new Error(`avaturn upstream ${upstream.status}: ${detail}`), { status: 502 });
	}
	const data = await upstream.json().catch(() => null);
	const sessionUrl = data?.session_url || data?.url || data?.iframe_url;
	if (!sessionUrl) throw Object.assign(new Error('avaturn response carried no session url'), { status: 502 });
	return { sessionUrl, expiresAt: data.expires_at ?? null };
}

// ── link-avatar ───────────────────────────────────────────────────────────────

const linkAvatarSchema = z.object({ avatarId: z.string().uuid(), force: z.boolean().default(false) });

async function handleLinkAvatar(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolveOnboardingUser(req, res, 'sign in required');
	if (!userId) return;
	const rl = await limits.avatarLink(userId);
	if (!rl.success) return rateLimited(res, rl, 'too many avatar link attempts, try again later');
	const body = parse(linkAvatarSchema, await readJson(req));
	const [avatar] = await sql`select id from avatars where id = ${body.avatarId} and owner_id = ${userId} and deleted_at is null limit 1`;
	if (!avatar) return error(res, 404, 'not_found', 'avatar not found or not owned by you');
	const [agent] = await sql`select id, avatar_id from agent_identities where user_id = ${userId} and deleted_at is null order by created_at asc limit 1`;
	if (!agent) return error(res, 404, 'not_found', 'no agent identity found for user');
	if (agent.avatar_id && agent.avatar_id !== body.avatarId && !body.force) return error(res, 409, 'already_linked', 'agent already has an avatar; pass force: true to override', { current_avatar_id: agent.avatar_id });
	const [updated] = await sql`update agent_identities set avatar_id = ${body.avatarId}, updated_at = now() where id = ${agent.id} returning id, avatar_id, updated_at`;
	return json(res, 200, { agent: updated });
}

// ── dispatcher ────────────────────────────────────────────────────────────────

const DISPATCH = { 'avaturn-session': handleAvaturnSession, 'link-avatar': handleLinkAvatar };

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown onboarding action: ${action}`);
	return fn(req, res);
});
