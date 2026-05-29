// POST /api/agents/:id/memory/seed/x
//
// Seeds agent memories from the user's X (Twitter) profile and recent tweets
// using Claude Haiku to distill personality, interests, and communication style.
// Requires: session auth, agent ownership, X social connection via OAuth 2.0.
// Rate-limited to once per 24 hours per agent.
//
// Route wired in vercel.json: /api/agents/:id/memory/seed/x → this file.

import { webcrypto } from 'node:crypto';
import { TwitterApi } from 'twitter-api-v2';
import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, error } from '../../_lib/http.js';
import { env } from '../../_lib/env.js';
import { llmComplete } from '../../_lib/llm.js';
import { limits } from '../../_lib/rate-limit.js';

const subtle = globalThis.crypto?.subtle || webcrypto.subtle;

// ── Token decryption (mirrors the HKDF derivation in auth/x/[action].js) ─────

async function decryptToken(ciphertext) {
	const raw = new TextEncoder().encode(env.JWT_SECRET);
	const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
	const key = await subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new TextEncoder().encode('oauth-token'),
			info: new Uint8Array(0),
		},
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['decrypt'],
	);
	const buf = Buffer.from(ciphertext, 'base64');
	const iv = buf.subarray(0, 12);
	const ct = buf.subarray(12);
	const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
	return new TextDecoder().decode(plain);
}

// ── X data fetch ──────────────────────────────────────────────────────────────

async function fetchXData(accessToken, userId) {
	const client = new TwitterApi(accessToken).readOnly;

	const [userResp, tweetsResp] = await Promise.allSettled([
		client.v2.user(userId, {
			'user.fields': [
				'name', 'username', 'description', 'public_metrics',
				'location', 'url', 'entities',
			],
		}),
		client.v2.userTimeline(userId, {
			max_results: 100,
			exclude: ['retweets', 'replies'],
			'tweet.fields': ['text', 'public_metrics', 'created_at'],
		}),
	]);

	const profile =
		userResp.status === 'fulfilled'
			? {
					name: userResp.value.data?.name,
					username: userResp.value.data?.username,
					bio: userResp.value.data?.description,
					location: userResp.value.data?.location,
					followers: userResp.value.data?.public_metrics?.followers_count,
					following: userResp.value.data?.public_metrics?.following_count,
					tweet_count: userResp.value.data?.public_metrics?.tweet_count,
				}
			: {};

	const tweets =
		tweetsResp.status === 'fulfilled'
			? (tweetsResp.value.data?.data || [])
					.slice(0, 80)
					.map((t) => ({
						text: t.text,
						likes: t.public_metrics?.like_count ?? 0,
						retweets: t.public_metrics?.retweet_count ?? 0,
						created_at: t.created_at,
					}))
					// Prefer higher-engagement tweets as they represent stronger signals
					.sort((a, b) => b.likes + b.retweets - (a.likes + a.retweets))
					.slice(0, 40)
					.map((t) => t.text)
			: [];

	return { profile, tweets };
}

// ── Claude Haiku distillation ─────────────────────────────────────────────────

async function distillFacts(xData) {
	const tweetBlock =
		xData.tweets.length
			? `\n\nRecent original tweets (highest-engagement first):\n${xData.tweets.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
			: '';

	const { text: raw } = await llmComplete({
		maxTokens: 1024,
		system:
			'You distill a person\'s X (Twitter) profile and posts into concise memory facts ' +
			'for an AI agent that will represent this person. Each fact is a single ' +
			'self-contained sentence about the person — their interests, expertise, communication ' +
			'style, values, typical topics, or notable beliefs. Infer voice/tone from the tweet ' +
			'style. Skip promotional content. Focus on authentic personality signals. ' +
			'Output ONLY a JSON array of strings, no other text.',
		user:
			`Extract up to 15 memory facts from this X profile:\n` +
			JSON.stringify(xData.profile, null, 2) +
			tweetBlock,
	});
	try {
		const facts = JSON.parse(raw);
		return Array.isArray(facts) ? facts.filter((f) => typeof f === 'string').slice(0, 15) : [];
	} catch {
		return [];
	}
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handleMemorySeedX(req, res, agentId) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	// Verify agent ownership
	const [agent] = await sql`
		SELECT id FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	// Verify X connection
	const [conn] = await sql`
		SELECT access_token, provider_uid, username FROM social_connections
		WHERE user_id = ${userId} AND provider = 'x'
	`;
	if (!conn) {
		return error(
			res,
			412,
			'not_connected',
			'connect your X account first at /settings?tab=connected-accounts',
		);
	}

	// Rate limit: 1 seed per agent per 24 hours
	const rl = await limits.memorySeed(agentId);
	if (!rl.success) {
		return error(res, 429, 'rate_limited', 'memory seeding is limited to once per 24 hours');
	}

	let accessToken;
	try {
		accessToken = await decryptToken(conn.access_token);
	} catch (e) {
		console.error('[memory-seed-x] token decrypt failed', e);
		return error(res, 500, 'internal_error', 'could not decrypt stored token');
	}

	let xData;
	try {
		xData = await fetchXData(accessToken, conn.provider_uid);
	} catch (e) {
		console.error('[memory-seed-x] X API fetch failed', e);
		return error(res, 502, 'upstream_error', e.message || 'X API fetch failed');
	}

	let facts;
	try {
		facts = await distillFacts(xData);
	} catch (e) {
		console.error('[memory-seed-x] distill failed', e);
		return error(res, 502, 'distill_error', 'could not distill facts from X data');
	}

	if (facts.length === 0) {
		return json(res, 200, { seeded: 0, facts: [], seeded_at: new Date().toISOString() });
	}

	// Replace previous X memories with the fresh distillation
	await sql`DELETE FROM agent_memories WHERE agent_id = ${agentId} AND 'x' = ANY(tags)`;

	const seededAt = new Date().toISOString();
	const ctx = JSON.stringify({
		source: 'x_seed',
		x_username: conn.username,
		seeded_at: seededAt,
	});
	for (const fact of facts) {
		await sql`
			INSERT INTO agent_memories (agent_id, type, content, tags, context, salience)
			VALUES (
				${agentId},
				'user',
				${fact.slice(0, 10000)},
				${['x', 'persona']},
				${ctx}::jsonb,
				0.8
			)
		`;
	}

	return json(res, 200, {
		seeded: facts.length,
		facts,
		x_username: conn.username,
		seeded_at: seededAt,
	});
}
