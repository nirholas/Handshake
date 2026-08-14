// POST /api/agents/:id/memory-seed
//
// The preset GitHub seed: with no body it uses the smallest meaningful
// selection, the developer's public profile plus the repos they pinned to it.
// A body may narrow or widen that within the same consent catalog, using the
// identical schema as POST /api/agents/:id/memory/seed/github, which is the
// granular surface where the user ticks items one by one.
//
// Both routes share api/_lib/github-seed.js, so they read the same public-only
// catalog, write the same memory shape, and are revoked by the same delete.
//
// Requires: session or bearer auth, agent ownership, a github social connection.
// Rate-limited to 1 seed per agent per 24 hours.

import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, readJson, error, rateLimited, serverError } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { llmComplete } from '../../_lib/llm.js';
import { limits } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { decryptGithubToken } from '../../_lib/github-token.js';
import { fetchProfile, fetchRepos, fetchPinnedRepos, fetchReadme } from '../../_lib/github-api.js';
import {
	buildCatalog,
	buildSeedDocument,
	defaultSelection,
	parseFacts,
	readmeExcerpt,
	resolveSelection,
	selectionManifest,
	selectionSchema,
	toMemoryRows,
	MAX_FACTS,
	SEED_SYSTEM_PROMPT,
} from '../../_lib/github-seed.js';

export default async function handleMemorySeed(req, res, agentId) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] = await sql`
		SELECT id FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt
	// inside requireCsrf. The sibling providers (memory-seed-x, -farcaster) gate
	// the same way; this preset route deletes and rewrites the agent's memories,
	// so a cross-site form post must not be able to drive it.
	if (!(await requireCsrf(req, res, userId))) return;

	const [conn] = await sql`
		SELECT access_token, username FROM social_connections
		WHERE user_id = ${userId} AND provider = 'github'
	`;
	if (!conn) {
		return error(
			res,
			412,
			'not_connected',
			'connect GitHub first at /settings?tab=connected-accounts',
		);
	}

	const rl = await limits.memorySeed(agentId);
	if (!rl.success) {
		return rateLimited(res, rl, 'memory seeding is limited to once per 24 hours');
	}

	const body = (await readJson(req)) ?? {};
	const requested = Object.keys(body).length ? parse(selectionSchema, body) : null;

	let accessToken;
	try {
		accessToken = await decryptGithubToken(conn.access_token);
	} catch (e) {
		console.error('[memory-seed] token decrypt failed', e);
		return error(res, 500, 'internal_error', 'could not decrypt stored token');
	}

	let catalog;
	try {
		const profile = await fetchProfile(accessToken);
		const [pinned, repos] = await Promise.all([
			fetchPinnedRepos(accessToken, profile.login),
			fetchRepos(accessToken),
		]);
		catalog = buildCatalog({ profile, pinned, repos });
	} catch (e) {
		console.error('[memory-seed] GitHub API fetch failed', e?.message);
		return serverError(res, 502, 'upstream_error', e);
	}

	const selection = requested ?? defaultSelection(catalog);
	const resolved = resolveSelection(catalog, selection);
	if (resolved.rejected.length) {
		return error(res, 400, 'invalid_selection', 'some selected items are not in your GitHub catalog', {
			rejected: resolved.rejected,
		});
	}
	if (resolved.isEmpty) {
		return error(
			res,
			400,
			'empty_selection',
			'no public profile or pinned repositories to seed from — pick repositories explicitly',
		);
	}

	const readmes = new Map();
	try {
		for (const key of resolved.readmeKeys) {
			const markdown = await fetchReadme(accessToken, key);
			if (markdown) readmes.set(key, readmeExcerpt(markdown));
		}
	} catch (e) {
		console.error('[memory-seed] README fetch failed', e?.message);
		return serverError(res, 502, 'upstream_error', e);
	}

	let facts;
	try {
		const { text: raw } = await llmComplete({
			maxTokens: 1500,
			system: SEED_SYSTEM_PROMPT,
			user: `Extract up to ${MAX_FACTS} memory facts from this GitHub material:\n\n${buildSeedDocument(resolved, readmes)}`,
		});
		facts = parseFacts(raw);
	} catch (e) {
		console.error('[memory-seed] distill failed', e);
		return error(res, 502, 'distill_error', 'could not distill facts from GitHub data');
	}

	const seededAt = new Date().toISOString();
	if (facts.length === 0) {
		return json(res, 200, {
			seeded: 0,
			facts: [],
			seeded_at: seededAt,
			selection: selectionManifest(resolved),
		});
	}

	const rows = toMemoryRows(agentId, facts, { login: conn.username, resolved, seededAt });

	// Replace the previous GitHub seed atomically, so a mid-loop failure can't
	// leave the agent with its old memories deleted and only a partial new set
	// (the 24h rate limit would then block a retry).
	await sql.transaction([
		sql`DELETE FROM agent_memories WHERE agent_id = ${agentId} AND context->>'source' = 'github_seed'`,
		...rows.map(
			(row) => sql`
			INSERT INTO agent_memories (agent_id, type, content, tags, context, salience, tier)
			VALUES (${row.agent_id}, ${row.type}, ${row.content}, ${row.tags}, ${JSON.stringify(row.context)}::jsonb, ${row.salience}, ${row.tier})
		`,
		),
	]);

	return json(res, 200, {
		seeded: facts.length,
		facts,
		seeded_at: seededAt,
		selection: selectionManifest(resolved),
	});
}
