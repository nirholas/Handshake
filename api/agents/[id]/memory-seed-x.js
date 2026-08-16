// Consent-gated X memory seeding.
//
// GET    /api/agents/:id/memory/seed/x  — connection state, the consent grant,
//                                          and the disclosure the owner must
//                                          agree to before anything is read.
// POST   /api/agents/:id/memory/seed/x  — grant consent (first call) and seed.
// DELETE /api/agents/:id/memory/seed/x  — revoke consent and delete every
//                                          memory the grant produced.
//
// Auth: session user must own the agent AND have a live 'x' social_connection.
// A connection is permission to read X on the user's behalf; it is NOT
// permission to write their posts into an agent's long-term memory. That second
// decision is this endpoint's consent grant: explicit, versioned against the
// disclosure text (api/_lib/x-memory-seed.js), and revocable with deletion.
//
// Rate limit: 1 seed per agent per 6 hours, consumed only once the request is
// authorized and consented, so a rejected call never burns the owner's window.

import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { llmComplete } from '../../_lib/llm.js';
import { isUuid } from '../../_lib/validate.js';
import {
	X_SEED_DISCLOSURE,
	X_SEED_LIMITS,
	X_SEED_SCOPE_VERSION,
	seedFromX,
} from '../../_lib/x-memory-seed.js';
import { revokeAgentSeedConsent } from '../../_lib/x-seed-consent.js';
import { X_SEED_REQUIRED_SCOPES, missingScopes } from '../../_lib/x-scopes.js';
import { decryptToken, encryptToken } from '../../auth/x/[action].js';

// ── Token refresh ─────────────────────────────────────────────────────────────

async function refreshXToken(conn) {
	if (!conn.refresh_token) throw Object.assign(new Error('no refresh token'), { status: 400 });
	const decRefresh = decryptToken(conn.refresh_token);
	const creds = Buffer.from(`${env.X_OAUTH_CLIENT_ID}:${env.X_OAUTH_CLIENT_SECRET}`).toString(
		'base64',
	);
	const res = await fetch('https://api.twitter.com/2/oauth2/token', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			authorization: `Basic ${creds}`,
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: decRefresh,
			client_id: env.X_OAUTH_CLIENT_ID,
		}).toString(),
	});
	if (!res.ok) {
		const txt = await res.text();
		throw Object.assign(new Error('token refresh failed: ' + txt), { status: 502 });
	}
	const tokens = await res.json();
	const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 7200) * 1000).toISOString();
	const encAccess = encryptToken(tokens.access_token);
	const encRefresh = tokens.refresh_token
		? encryptToken(tokens.refresh_token)
		: conn.refresh_token;
	await sql`
		UPDATE social_connections
		SET access_token = ${encAccess},
		    refresh_token = ${encRefresh},
		    expires_at = ${expiresAt},
		    updated_at = now()
		WHERE id = ${conn.id}
	`;
	return tokens.access_token;
}

async function getAccessToken(conn) {
	if (!conn.expires_at || new Date(conn.expires_at) <= new Date(Date.now() + 60_000)) {
		return refreshXToken(conn);
	}
	return decryptToken(conn.access_token);
}

// ── Distillation ─────────────────────────────────────────────────────────────

// Only the fields selectSeedProfile / selectSeedPosts kept ever reach the model.
async function distilFacts(profile, posts, userId) {
	const { text } = await llmComplete({
		maxTokens: 1024,
		track: { userId, feature: 'x_memory_seed' },
		system:
			'You distill an author\'s public posts into concise memory facts for an AI agent that ' +
			'speaks on their behalf. Focus on recurring topics, strong opinions, ongoing projects, ' +
			'and communication style. Write statements ABOUT the author, never quote or paraphrase a ' +
			'single post. ' +
			`Output ONLY a JSON array of up to ${X_SEED_LIMITS.maxFacts} single-sentence strings.`,
		user:
			`Profile: @${profile.username} | ${profile.name} | ${profile.description} | ` +
			`${profile.followers} followers\n\n` +
			`Recent original posts (newest first):\n${posts.map((p) => p.text).join('\n')}`,
	});
	return text;
}

// ── Shared lookups ───────────────────────────────────────────────────────────

async function loadAgent(agentId, userId) {
	const [agent] = await sql`
		SELECT id, user_id, x_username, x_seeded_at FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return { error: ['not_found', 404, 'agent not found'] };
	if (agent.user_id !== userId) return { error: ['forbidden', 403, 'not your agent'] };
	return { agent };
}

async function loadConnection(userId) {
	const [conn] = await sql`
		SELECT id, provider_uid, username, scopes, access_token, refresh_token, expires_at
		FROM social_connections
		WHERE user_id = ${userId} AND provider = 'x'
		  AND (disconnected_at IS NULL OR disconnected_at > now())
		LIMIT 1
	`;
	return conn ?? null;
}

async function loadConsent(agentId) {
	const [consent] = await sql`
		SELECT id, x_user_id, username, scope_version, granted_scopes, granted_at,
		       last_seeded_at, memories_seeded, posts_read
		FROM x_memory_consents
		WHERE agent_id = ${agentId} AND revoked_at IS NULL
		LIMIT 1
	`;
	return consent ?? null;
}

// A grant stops authorizing new seeds when the disclosure text has moved on, or
// when the live connection now points at a different X account than the one the
// owner consented to. Both cases send the owner back to the consent screen.
function consentState(consent, conn) {
	if (!consent) return { granted: false, reason: 'none' };
	if (consent.scope_version !== X_SEED_SCOPE_VERSION) {
		return { granted: false, reason: 'scope_version_changed', consent };
	}
	if (conn && conn.provider_uid && consent.x_user_id !== conn.provider_uid) {
		return { granted: false, reason: 'account_changed', consent };
	}
	return { granted: true, reason: 'active', consent };
}

function consentPayload(state) {
	const c = state.consent;
	return {
		granted: state.granted,
		reason: state.reason,
		scope_version: c?.scope_version ?? null,
		granted_at: c?.granted_at ?? null,
		granted_scopes: c?.granted_scopes ?? null,
		username: c?.username ?? null,
		last_seeded_at: c?.last_seeded_at ?? null,
		memories_seeded: c?.memories_seeded ?? 0,
		posts_read: c?.posts_read ?? 0,
	};
}

async function countSeededMemories(agentId) {
	const [{ count }] = await sql`
		SELECT count(*)::int AS count FROM agent_memories
		WHERE agent_id = ${agentId} AND tags && ARRAY['x_seed']::text[]
	`;
	return count;
}

// ── GET — status + disclosure ────────────────────────────────────────────────

async function handleGet(req, res, agentId) {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const { agent, error: agentErr } = await loadAgent(agentId, user.id);
	if (agentErr) return error(res, agentErr[1], agentErr[0], agentErr[2]);

	const conn = await loadConnection(user.id);
	const state = consentState(await loadConsent(agentId), conn);
	const missing = conn ? missingScopes(conn.scopes, X_SEED_REQUIRED_SCOPES) : [];

	return json(res, 200, {
		connected: !!conn,
		configured: !!(env.X_OAUTH_CLIENT_ID && env.X_OAUTH_CLIENT_SECRET),
		username: conn?.username ?? agent.x_username ?? null,
		connection_scopes: conn?.scopes ?? null,
		// What seeding needs from the connection, and what this one is short of,
		// so the card can offer a reconnect instead of letting the owner consent
		// to a seed that would fail at the X API.
		required_scopes: X_SEED_REQUIRED_SCOPES,
		missing_scopes: missing,
		scopes_ok: missing.length === 0,
		seeded_at: agent.x_seeded_at ?? null,
		fact_count: await countSeededMemories(agentId),
		scope_version: X_SEED_SCOPE_VERSION,
		disclosure: X_SEED_DISCLOSURE,
		consent: consentPayload(state),
	});
}

// ── POST — grant consent, then seed ──────────────────────────────────────────

async function handlePost(req, res, agentId) {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, user.id))) return;

	const { error: agentErr } = await loadAgent(agentId, user.id);
	if (agentErr) return error(res, agentErr[1], agentErr[0], agentErr[2]);

	const conn = await loadConnection(user.id);
	if (!conn) return error(res, 400, 'not_connected', 'connect your X account first');

	// A connection narrower than the read the disclosure describes cannot be
	// seeded from. Refuse here, with the missing scopes named, rather than
	// recording consent and then failing at the X API with an opaque 502.
	const missing = missingScopes(conn.scopes, X_SEED_REQUIRED_SCOPES);
	if (missing.length) {
		return error(
			res,
			400,
			'insufficient_scope',
			'this X connection cannot read your profile and posts; reconnect X to seed',
			{ required_scopes: X_SEED_REQUIRED_SCOPES, missing_scopes: missing },
		);
	}

	const body = await readJson(req).catch(() => ({}));
	const existing = await loadConsent(agentId);
	let state = consentState(existing, conn);

	// No live grant: this request must carry the owner's acceptance of the
	// current disclosure. Nothing is read from X before that check passes.
	if (!state.granted) {
		const accepted = body?.consent?.accepted === true;
		const version = body?.consent?.scope_version;
		if (!accepted || version !== X_SEED_SCOPE_VERSION) {
			return error(res, 403, 'consent_required', 'explicit consent is required before seeding', {
				scope_version: X_SEED_SCOPE_VERSION,
				disclosure: X_SEED_DISCLOSURE,
				consent: consentPayload(state),
			});
		}
		// A stale grant (disclosure moved, or the connection now points at a
		// different X account) is retired, deleting its memories, before the new
		// one is recorded. Two live grants for one agent can never coexist.
		if (existing) await revokeAgentSeedConsent(agentId, 're_consented');
		const [row] = await sql`
			INSERT INTO x_memory_consents
				(user_id, agent_id, x_user_id, username, scope_version, disclosure, granted_scopes)
			VALUES (
				${user.id}, ${agentId}, ${conn.provider_uid}, ${conn.username},
				${X_SEED_SCOPE_VERSION}, ${JSON.stringify(X_SEED_DISCLOSURE)}::jsonb, ${conn.scopes ?? null}
			)
			RETURNING id, x_user_id, username, scope_version, granted_scopes, granted_at,
			          last_seeded_at, memories_seeded, posts_read
		`;
		state = consentState(row, conn);
	}

	const consent = state.consent;

	// Budget is consumed only now: authorized, connected, and consented.
	const rl = await limits.xSeed(agentId);
	if (!rl.success) return rateLimited(res, rl, 'agent can only be re-seeded every 6 hours');

	const accessToken = await getAccessToken(conn);

	const profileRes = await fetch(
		'https://api.twitter.com/2/users/me?user.fields=name,username,description,public_metrics',
		{ headers: { authorization: `Bearer ${accessToken}` } },
	);
	if (!profileRes.ok) throw Object.assign(new Error('X profile fetch failed'), { status: 502 });
	const { data: rawProfile } = await profileRes.json();
	if (!rawProfile?.id) throw Object.assign(new Error('X profile unreadable'), { status: 502 });

	// The account that consented must be the account being read.
	if (rawProfile.id !== consent.x_user_id) {
		return error(res, 409, 'account_mismatch', 'consent was granted for a different X account', {
			consent: consentPayload(consentState(consent, conn)),
		});
	}

	const postsRes = await fetch(
		`https://api.twitter.com/2/users/${rawProfile.id}/tweets?max_results=${X_SEED_LIMITS.maxPosts}` +
			'&exclude=retweets,replies&tweet.fields=text,created_at',
		{ headers: { authorization: `Bearer ${accessToken}` } },
	);
	if (!postsRes.ok) throw Object.assign(new Error('X posts fetch failed'), { status: 502 });
	const postsJson = await postsRes.json();

	const seededAt = new Date().toISOString();
	const result = await seedFromX({
		rawProfile,
		rawPosts: postsJson.data ?? [],
		distil: (profile, posts) => distilFacts(profile, posts, user.id),
		seededAt,
	});

	// Re-seeding replaces: the previous batch goes before the new one lands, so
	// the agent never carries two generations of facts about the same account.
	await sql`
		DELETE FROM agent_memories
		WHERE agent_id = ${agentId} AND tags && ARRAY['x_seed']::text[]
	`;

	for (const mem of result.memories) {
		await sql`
			INSERT INTO agent_memories (agent_id, type, content, tags, context, salience, tier)
			VALUES (
				${agentId}, ${mem.type}, ${mem.content}, ${mem.tags},
				${JSON.stringify({ ...mem.context, consent_id: consent.id })}::jsonb,
				${mem.salience}, ${mem.tier}
			)
		`;
	}

	await sql`
		UPDATE agent_identities
		SET x_username = ${result.profile.username}, x_seeded_at = ${seededAt}
		WHERE id = ${agentId}
	`;
	await sql`
		UPDATE x_memory_consents
		SET last_seeded_at = ${seededAt},
		    memories_seeded = ${result.memories.length},
		    posts_read = ${result.postsRead}
		WHERE id = ${consent.id}
	`;

	return json(res, 200, {
		username: result.profile.username,
		seeded: result.memories.length,
		posts_read: result.postsRead,
		distilled_by: result.source,
		topics: result.topics.map((t) => t.topic),
		facts: result.memories.map((m) => m.content),
		in_context: result.memories.filter((m) => m.tier === 'working').length,
		consent: consentPayload(consentState({ ...consent, last_seeded_at: seededAt }, conn)),
	});
}

// ── DELETE — revoke consent and delete what it produced ──────────────────────

async function handleDelete(req, res, agentId) {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, user.id))) return;

	const { error: agentErr } = await loadAgent(agentId, user.id);
	if (agentErr) return error(res, agentErr[1], agentErr[0], agentErr[2]);

	// Idempotent, and it purges seeded rows even when no grant row survives:
	// memories written before consents were recorded still have to go.
	const { deleted, consents } = await revokeAgentSeedConsent(agentId, 'owner_revoked');

	return json(res, 200, {
		revoked: true,
		deleted,
		consents_revoked: consents,
		remaining: await countSeededMemories(agentId),
		consent: consentPayload({ granted: false, reason: 'revoked' }),
	});
}

// ── dispatch ──────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;

	const agentId = req.query?.id;
	if (!agentId) return error(res, 400, 'validation_error', 'agent id required');
	// /api/agents/:id/memory/seed/x has its own vercel.json rewrite, so the uuid
	// gate in api/agents/[id].js never runs for it. A malformed id would reach a
	// uuid column and turn Postgres 22P02 into a 500.
	if (!isUuid(agentId)) return error(res, 404, 'not_found', 'agent not found');

	if (req.method === 'GET') return handleGet(req, res, agentId);
	if (req.method === 'POST') return handlePost(req, res, agentId);
	if (req.method === 'DELETE') return handleDelete(req, res, agentId);
	return method(req, res, ['GET', 'POST', 'DELETE']);
});
