// GET  /api/agents/:id/memory/seed/farcaster — current link status
// POST /api/agents/:id/memory/seed/farcaster — link Farcaster account & seed memories

import { z } from 'zod';
import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { env } from '../../_lib/env.js';
import { llmComplete } from '../../_lib/llm.js';

const bodySchema = z
	.object({
		fid: z.number().int().positive().optional(),
		fname: z.string().trim().min(1).max(64).optional(),
	})
	.refine((d) => d.fid != null || d.fname != null, { message: 'fid or fname required' });

const NEYNAR_BASE = 'https://api.neynar.com/v2/farcaster';
const SEED_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const NEYNAR_TIMEOUT_MS = 15_000;

async function neynarGet(path, apiKey) {
	const resp = await fetch(`${NEYNAR_BASE}${path}`, {
		headers: { api_key: apiKey },
		signal: AbortSignal.timeout(NEYNAR_TIMEOUT_MS),
	});
	if (!resp.ok) {
		const err = new Error(`Neynar ${resp.status}`);
		err.httpStatus = resp.status;
		throw err;
	}
	return resp.json();
}

async function distillFacts(profile, casts) {
	const castTexts = casts
		.slice(0, 50)
		.map((c) => c.text || '')
		.filter(Boolean)
		.join('\n');

	const displayName = profile.display_name || profile.username || '';
	const bio = profile.profile?.bio?.text || '';
	const followers = profile.follower_count ?? 0;
	const userLine = `Display name: ${displayName}, Bio: ${bio || '(none)'}, Followers: ${followers}`;

	const { text: raw } = await llmComplete({
		maxTokens: 1024,
		system:
			'You distill Farcaster casts into concise memory facts for an AI agent. ' +
			'Focus on: recurring topics, opinions, projects, communication style, community ties. ' +
			'Output ONLY a JSON array of up to 15 single-sentence strings, no other text.',
		user: `Profile: ${userLine}\n\nRecent casts (newest first):\n${castTexts}`,
	});

	try {
		const stripped = raw
			.replace(/^```(?:json)?\s*/i, '')
			.replace(/\s*```$/i, '')
			.trim();
		const facts = JSON.parse(stripped);
		return Array.isArray(facts) ? facts.filter((f) => typeof f === 'string').slice(0, 15) : [];
	} catch {
		return [];
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (!env.NEYNAR_API_KEY)
		return error(res, 501, 'not_configured', 'Farcaster integration not configured');

	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean);
	const agentId = parts[2];

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] = await sql`
		SELECT id, farcaster_fid, farcaster_fname, farcaster_seeded_at
		FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	if (req.method === 'GET') {
		const [countRow] = await sql`
			SELECT COUNT(*)::int AS fact_count
			FROM agent_memories
			WHERE agent_id = ${agentId}
				AND context->>'source' = 'farcaster_seed'
				AND (expires_at IS NULL OR expires_at > now())
		`;
		return json(res, 200, {
			fid: agent.farcaster_fid ?? null,
			fname: agent.farcaster_fname ?? null,
			seeded_at: agent.farcaster_seeded_at ?? null,
			fact_count: countRow?.fact_count ?? 0,
		});
	}

	// POST
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (agent.farcaster_seeded_at) {
		const elapsed = Date.now() - new Date(agent.farcaster_seeded_at).getTime();
		if (elapsed < SEED_COOLDOWN_MS) {
			// Plain 429: this is a per-agent cooldown, not the IP limiter above —
			// reusing rateLimited(res, rl) here would emit RateLimit-* headers from
			// a limiter result that actually succeeded, misleading clients.
			const retryAfter = Math.max(1, Math.ceil((SEED_COOLDOWN_MS - elapsed) / 1000));
			res.setHeader('retry-after', String(retryAfter));
			return error(
				res,
				429,
				'cooldown_active',
				'farcaster seed cooldown: try again in 6 hours',
				{
					retry_after: retryAfter,
				},
			);
		}
	}

	const body = parse(bodySchema, await readJson(req));

	let fid = body.fid ?? null;
	let fname = body.fname ?? null;

	// Resolve fname → fid
	if (!fid && fname) {
		let userData;
		try {
			userData = await neynarGet(
				`/user/by_username?username=${encodeURIComponent(fname)}`,
				env.NEYNAR_API_KEY,
			);
		} catch (e) {
			if (e.httpStatus === 404)
				return error(res, 404, 'farcaster_user_not_found', 'Farcaster user not found');
			throw e;
		}
		fid = userData?.user?.fid;
		if (!fid) return error(res, 404, 'farcaster_user_not_found', 'Farcaster user not found');
	}

	// Fetch casts and profile in parallel. A Neynar outage is an upstream failure,
	// not an internal one: neynarGet tags its error with `httpStatus`, which wrap()
	// does not read (it reads `status`), so an uncaught throw here surfaced as a
	// bare 500 plus an ops alert for somebody else's downtime.
	let castsData;
	let profileData;
	try {
		[castsData, profileData] = await Promise.all([
			neynarGet(`/feed/user/casts?fid=${fid}&limit=50&include_replies=false`, env.NEYNAR_API_KEY),
			neynarGet(`/user?fid=${fid}`, env.NEYNAR_API_KEY),
		]);
	} catch (e) {
		if (e.httpStatus === 404)
			return error(res, 404, 'farcaster_user_not_found', 'Farcaster user not found');
		console.error('[memory-seed-farcaster] Neynar fetch failed', e?.message);
		return error(res, 502, 'upstream_error', 'Farcaster data is unavailable right now');
	}

	const casts = castsData?.casts ?? [];
	const profile = profileData?.users?.[0] ?? profileData?.user ?? {};

	if (!fname && profile.username) fname = profile.username;

	const facts = casts.length > 0 ? await distillFacts(profile, casts) : [];

	// Delete existing farcaster_seed memories (idempotent re-seed)
	await sql`
		DELETE FROM agent_memories
		WHERE agent_id = ${agentId} AND context->>'source' = 'farcaster_seed'
	`;

	// Insert new memories
	for (const fact of facts) {
		await sql`
			INSERT INTO agent_memories (id, agent_id, type, content, tags, context, salience)
			VALUES (
				gen_random_uuid(),
				${agentId},
				'user',
				${fact},
				ARRAY['farcaster'],
				${JSON.stringify({ source: 'farcaster_seed', fid })}::jsonb,
				0.7
			)
		`;
	}

	// Update agent with validated farcaster identity
	await sql`
		UPDATE agent_identities
		SET farcaster_fid = ${fid}, farcaster_fname = ${fname}, farcaster_seeded_at = now()
		WHERE id = ${agentId}
	`;

	return json(res, 200, { fid, fname, seeded: facts.length, facts });
});
