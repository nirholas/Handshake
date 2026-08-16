// GET    /api/agents/:id/memory/seed/github — connection status + the catalog the user picks from
// POST   /api/agents/:id/memory/seed/github — seed memory from the selection the user ticked
// DELETE /api/agents/:id/memory/seed/github — delete every GitHub-seeded memory on this agent
//
// Consent-first: the GET reads GitHub and stores nothing. The POST reads only
// the profile, repos, and READMEs named in the body, and refuses the whole run
// if any of them is outside the catalog the user was shown.
//
// Auth: session (or bearer) user must own the agent AND hold a live 'github'
// social_connection. Rate limit: 1 seed per agent per 6 hours.

import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { llmComplete } from '../../_lib/llm.js';
import { isUuid, parse } from '../../_lib/validate.js';
import { decryptGithubToken } from '../../_lib/github-token.js';
import { fetchProfile, fetchRepos, fetchPinnedRepos, fetchReadme } from '../../_lib/github-api.js';
import {
	buildCatalog,
	buildSeedDocument,
	parseFacts,
	readmeExcerpt,
	resolveSelection,
	selectionManifest,
	selectionSchema,
	toMemoryRows,
	MAX_FACTS,
	SEED_SYSTEM_PROMPT,
} from '../../_lib/github-seed.js';

// ── Shared preconditions ──────────────────────────────────────────────────────

async function requireOwnedAgent(req, agentId) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;
	if (!userId) throw Object.assign(new Error('sign in required'), { status: 401, code: 'unauthorized' });

	const [agent] = await sql`
		SELECT id FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
	`;
	if (!agent) throw Object.assign(new Error('agent not found'), { status: 404, code: 'not_found' });
	return userId;
}

async function githubConnection(userId) {
	const [conn] = await sql`
		SELECT id, username, access_token, connected_at FROM social_connections
		WHERE user_id = ${userId} AND provider = 'github'
		LIMIT 1
	`;
	return conn ?? null;
}

async function seedStats(agentId) {
	const [row] = await sql`
		SELECT
			count(*)::int AS fact_count,
			max(created_at) AS seeded_at,
			(array_agg(context ORDER BY created_at DESC))[1] AS latest_context
		FROM agent_memories
		WHERE agent_id = ${agentId} AND context->>'source' = 'github_seed'
	`;
	const ctx = row?.latest_context ?? null;
	const parsed = typeof ctx === 'string' ? JSON.parse(ctx) : ctx;
	return {
		fact_count: row?.fact_count ?? 0,
		seeded_at: row?.seeded_at ?? null,
		selection: parsed?.selection ?? null,
	};
}

async function loadCatalog(token) {
	const profile = await fetchProfile(token);
	const [pinned, repos] = await Promise.all([
		fetchPinnedRepos(token, profile.login),
		fetchRepos(token),
	]);
	return buildCatalog({ profile, pinned, repos });
}

// ── GET — status and consent catalog ─────────────────────────────────────────

async function handleGet(req, res, agentId) {
	const userId = await requireOwnedAgent(req, agentId);
	const conn = await githubConnection(userId);
	const stats = await seedStats(agentId);

	if (!conn) {
		return json(res, 200, {
			connected: false,
			username: null,
			connect_url: `/api/auth/github/connect?agent_id=${encodeURIComponent(agentId)}`,
			catalog: null,
			...stats,
		});
	}

	const token = await decryptGithubToken(conn.access_token);
	const catalog = await loadCatalog(token);

	return json(res, 200, {
		connected: true,
		username: conn.username,
		connected_at: conn.connected_at,
		catalog,
		...stats,
	});
}

// ── POST — seed from the user's selection ────────────────────────────────────

async function handlePost(req, res, agentId) {
	const userId = await requireOwnedAgent(req, agentId);
	// Session-cookie POSTs rewrite this agent's seeded memories, so a cross-site
	// form post must not be able to drive one. Bearer callers are exempt inside
	// requireCsrf. Every sibling memory mutator (memory-seed-x, -farcaster, the
	// preset memory-seed, agent-memory) gates the same way; this route was the
	// one that did not.
	if (!(await requireCsrf(req, res, userId))) return;

	const conn = await githubConnection(userId);
	if (!conn) {
		return error(res, 412, 'not_connected', 'connect GitHub first', {
			connect_url: `/api/auth/github/connect?agent_id=${encodeURIComponent(agentId)}`,
		});
	}

	const selection = parse(selectionSchema, (await readJson(req)) ?? {});
	const token = await decryptGithubToken(conn.access_token);
	const catalog = await loadCatalog(token);
	const resolved = resolveSelection(catalog, selection);

	if (resolved.rejected.length) {
		return error(
			res,
			400,
			'invalid_selection',
			'some selected items are not in your GitHub catalog',
			{ rejected: resolved.rejected },
		);
	}
	if (resolved.isEmpty) {
		return error(
			res,
			400,
			'empty_selection',
			'pick your profile or at least one repository to seed from',
		);
	}

	// The budget is consumed here, once the selection is known good and just
	// before the parts that actually cost something: the README reads, the LLM
	// pass, and the rewrite of this agent's memories. Charging it earlier meant a
	// user who ticked nothing, or whose catalog had gone stale since it loaded,
	// spent their whole 6-hour window on a 400 and could not correct the mistake
	// until it expired. Ownership is already proven above, so a signed-in
	// stranger still cannot burn another agent's window by guessing its id, and
	// the reads that precede this point are the same ones GET already serves
	// unbudgeted. Farcaster keeps its signing challenge outside the budget for
	// the same reason.
	const rl = await limits.githubSeed(agentId);
	if (!rl.success) return rateLimited(res, rl, 'this agent can only be re-seeded every 6 hours');

	const readmes = new Map();
	for (const key of resolved.readmeKeys) {
		const markdown = await fetchReadme(token, key);
		if (markdown) readmes.set(key, readmeExcerpt(markdown));
	}

	const document = buildSeedDocument(resolved, readmes);
	// llmComplete walks the whole provider chain before it gives up, so a throw
	// here means every lane was busy or down at once, not a bug in this route.
	// Left uncaught it reached the client as a bare "internal error, quote ref …"
	// and paged ops as an unhandled 5xx on what is a routine upstream throttle.
	// The budget above is already spent by this point, and the outage is ours,
	// not the owner's mistake: hand the window back so they can retry as soon as
	// a provider frees up instead of waiting out six hours for a run that read
	// nothing and wrote nothing.
	let raw;
	try {
		({ text: raw } = await llmComplete({
			maxTokens: 1500,
			system: SEED_SYSTEM_PROMPT,
			user: `Extract up to ${MAX_FACTS} memory facts from this GitHub material:\n\n${document}`,
		}));
	} catch (err) {
		const refunded = await limits.githubSeedRefund(agentId).catch(() => false);
		const retryAt = refunded || !rl.reset ? null : new Date(rl.reset).toISOString();
		const minutes = retryAt ? Math.max(1, Math.ceil((rl.reset - Date.now()) / 60_000)) : null;
		return error(
			res,
			503,
			'distill_unavailable',
			`every model provider is busy right now, so nothing was seeded and your memories are unchanged${
				refunded
					? '. This attempt did not use up your six-hour window, so you can try again in a few minutes'
					: minutes
						? `. This agent can be seeded again in about ${minutes} minute${minutes === 1 ? '' : 's'}`
						: '. Try this agent again later'
			}`,
			{
				retry_at: retryAt,
				window_refunded: refunded,
				providers_tried: err?.attempts?.map((a) => a.provider) ?? [],
			},
		);
	}
	const facts = parseFacts(raw);
	const seededAt = new Date().toISOString();
	const manifest = selectionManifest(resolved);

	// Same reasoning as the provider outage above: the agent's memories are
	// untouched, and the advice to pick more material is worthless if acting on
	// it means waiting out a six-hour window.
	if (facts.length === 0) {
		const refunded = await limits.githubSeedRefund(agentId).catch(() => false);
		return error(
			res,
			502,
			'distill_error',
			'the selected material did not yield any usable facts, so nothing was stored. Add a README or another repository and seed again',
			{ window_refunded: refunded },
		);
	}

	const rows = toMemoryRows(agentId, facts, {
		login: conn.username,
		resolved,
		seededAt,
	});

	// Replace the previous GitHub seed atomically. A mid-loop failure must not
	// leave the agent with its old memories deleted and only part of the new set,
	// because the 6-hour limiter would then block the repair.
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
		username: conn.username,
		seeded: facts.length,
		facts,
		seeded_at: seededAt,
		selection: manifest,
		readmes_read: [...readmes.keys()],
	});
}

// ── DELETE — revoke this agent's seeded memories ─────────────────────────────

async function handleDelete(req, res, agentId) {
	const userId = await requireOwnedAgent(req, agentId);
	if (!(await requireCsrf(req, res, userId))) return;
	const deleted = await sql`
		DELETE FROM agent_memories
		WHERE agent_id = ${agentId} AND context->>'source' = 'github_seed'
		RETURNING id
	`;
	return json(res, 200, { deleted: deleted.length });
}

// ── dispatch ──────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;

	const agentId = req.query?.id;
	if (!agentId) return error(res, 400, 'validation_error', 'agent id required');
	// This route has its own rewrite, so the uuid gate in api/agents/[id].js never
	// runs for it. A malformed id would otherwise reach a uuid column and turn a
	// Postgres 22P02 into a 500.
	if (!isUuid(agentId)) return error(res, 404, 'not_found', 'agent not found');

	if (req.method === 'GET') return handleGet(req, res, agentId);
	if (req.method === 'POST') return handlePost(req, res, agentId);
	if (req.method === 'DELETE') return handleDelete(req, res, agentId);
	return method(req, res, ['GET', 'POST', 'DELETE']);
});
