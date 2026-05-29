// POST /api/agents/:id/memory/seed/x  — fetch X tweets, distil to facts, seed agent memory.
// GET  /api/agents/:id/memory/seed/x  — return connection status and last seed info.
//
// Auth: session user must own the agent AND have an active 'x' social_connection.
// Rate limit: 1 seed per agent per 6 hours.

import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { llmComplete } from '../../_lib/llm.js';
import { decryptToken, encryptToken } from '../../auth/x/[action].js';

// ── Token refresh ─────────────────────────────────────────────────────────────

async function refreshXToken(conn) {
	if (!conn.refresh_token) throw Object.assign(new Error('no refresh token'), { status: 400 });
	const decRefresh = decryptToken(conn.refresh_token);
	const creds = Buffer.from(
		`${env.X_OAUTH_CLIENT_ID}:${env.X_OAUTH_CLIENT_SECRET}`,
	).toString('base64');
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
	const encRefresh = tokens.refresh_token ? encryptToken(tokens.refresh_token) : conn.refresh_token;
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

// ── Distil tweets → facts via Claude ─────────────────────────────────────────

async function distilFacts(profile, tweets) {
	const tweetLines = tweets.map((t) => t.text).join('\n');

	const { text: raw } = await llmComplete({
		maxTokens: 1024,
		system:
			'You distill tweets into concise memory facts for an AI agent. ' +
			'Focus on: recurring topics, strong opinions, projects, communication style, humor. ' +
			'Output ONLY a JSON array of up to 15 single-sentence strings, no other text.',
		user:
			`Profile: @${profile.username} | ${profile.description || ''} | ` +
			`${profile.public_metrics?.followers_count ?? 0} followers\n\n` +
			`Recent tweets (newest first):\n${tweetLines}`,
	});

	try {
		const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
		const facts = JSON.parse(stripped);
		return Array.isArray(facts) ? facts.filter((f) => typeof f === 'string').slice(0, 15) : [];
	} catch {
		return [];
	}
}

// ── GET — status ──────────────────────────────────────────────────────────────

async function handleGet(req, res, agentId) {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] = await sql`
		SELECT id, user_id, x_username, x_seeded_at FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== user.id) return error(res, 403, 'forbidden', 'not your agent');

	const [conn] = await sql`
		SELECT id, username FROM social_connections
		WHERE user_id = ${user.id} AND provider = 'x'
		  AND (disconnected_at IS NULL OR disconnected_at > now())
		LIMIT 1
	`;

	const [{ count }] = await sql`
		SELECT count(*)::int AS count FROM agent_memories
		WHERE agent_id = ${agentId} AND tags && ARRAY['x']::text[]
	`;

	return json(res, 200, {
		connected: !!conn,
		username: conn?.username ?? agent.x_username ?? null,
		seeded_at: agent.x_seeded_at ?? null,
		fact_count: count,
	});
}

// ── POST — seed ───────────────────────────────────────────────────────────────

async function handlePost(req, res, agentId) {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.xSeed(agentId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'agent can only be re-seeded every 6 hours');

	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== user.id) return error(res, 403, 'forbidden', 'not your agent');

	const [conn] = await sql`
		SELECT id, username, access_token, refresh_token, expires_at FROM social_connections
		WHERE user_id = ${user.id} AND provider = 'x'
		  AND (disconnected_at IS NULL OR disconnected_at > now())
		LIMIT 1
	`;
	if (!conn) return error(res, 400, 'not_connected', 'connect your X account first');

	const accessToken = await getAccessToken(conn);

	// Fetch profile
	const profileRes = await fetch(
		'https://api.twitter.com/2/users/me?user.fields=name,username,description,public_metrics',
		{ headers: { authorization: `Bearer ${accessToken}` } },
	);
	if (!profileRes.ok) {
		throw Object.assign(new Error('X profile fetch failed'), { status: 502 });
	}
	const { data: profile } = await profileRes.json();

	// Fetch up to 100 recent original tweets
	const tweetsRes = await fetch(
		`https://api.twitter.com/2/users/${profile.id}/tweets?max_results=100&exclude=retweets,replies&tweet.fields=text,created_at`,
		{ headers: { authorization: `Bearer ${accessToken}` } },
	);
	if (!tweetsRes.ok) {
		throw Object.assign(new Error('X tweets fetch failed'), { status: 502 });
	}
	const tweetsJson = await tweetsRes.json();
	const tweets = tweetsJson.data ?? [];

	const facts = await distilFacts(profile, tweets);

	// Delete old x-tagged memories for this agent, then insert fresh ones
	await sql`
		DELETE FROM agent_memories
		WHERE agent_id = ${agentId} AND tags && ARRAY['x']::text[]
	`;

	if (facts.length > 0) {
		const rows = facts.map((fact) => ({
			agent_id: agentId,
			type: 'reference',
			content: fact,
			tags: ['x', 'x_seed'],
			context: JSON.stringify({ source: 'x_seed', username: profile.username }),
			salience: 0.7,
		}));
		for (const row of rows) {
			await sql`
				INSERT INTO agent_memories (agent_id, type, content, tags, context, salience)
				VALUES (${row.agent_id}, ${row.type}, ${row.content}, ${row.tags}, ${row.context}::jsonb, ${row.salience})
			`;
		}
	}

	// Update agent_identities with x_username and x_seeded_at
	await sql`
		UPDATE agent_identities
		SET x_username = ${profile.username}, x_seeded_at = now()
		WHERE id = ${agentId}
	`;

	return json(res, 200, { username: profile.username, seeded: facts.length, facts });
}

// ── dispatch ──────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;

	const agentId = req.query?.id;
	if (!agentId) return error(res, 400, 'validation_error', 'agent id required');

	if (req.method === 'GET') return handleGet(req, res, agentId);
	if (req.method === 'POST') return handlePost(req, res, agentId);
	return method(req, res, ['GET', 'POST']);
});
