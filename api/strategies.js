// /api/strategies — the Strategy Object library: an ownable, publishable,
// forkable, leaderboard-ranked trade strategy as a first-class object.
//
//   GET    /api/strategies                  list (scope=mine|published, sort, q)
//   POST   /api/strategies                  create a strategy (owner-authored)
//   GET    /api/strategies/leaderboard      published strategies ranked by REAL live perf
//   GET    /api/strategies/:id              fetch one (public if published; owner otherwise)
//   PATCH  /api/strategies/:id              edit config/name/description (owner, bumps version)
//   DELETE /api/strategies/:id              soft-delete (owner)
//   POST   /api/strategies/:id/fork         fork into the caller's library (lineage, no wallet access)
//   POST   /api/strategies/:id/publish      toggle published (owner)
//
// Strategies are NOT free text — every config passes validateStrategyConfig before
// it persists. Performance shown is REAL live performance aggregated from real
// on-chain fills (agent_strategy_positions); a strategy with no closed positions is
// honestly "unproven" — never a fabricated backtest curve. Forking copies the RULES
// only: fresh ownership, lineage credited to the author, and the forker runs them
// under THEIR OWN spend policy — no wallet access is ever transferred.

import { sql } from './_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { requireCsrf } from './_lib/csrf.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { isUuid } from './_lib/validate.js';
import { logAudit } from './_lib/audit.js';
import { validateStrategyConfig, slugifyStrategy } from './_lib/strategy-schema.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

const LIST_SORTS = new Set(['recent', 'forks', 'equips', 'performance']);

// Real live performance for a set of strategies, aggregated from real closed
// on-chain positions across every equip of each strategy. Returns a map id→stats.
// A strategy with 0 closed positions is "unproven" (proven:false) — never faked.
async function performanceByStrategy(ids) {
	if (!ids.length) return new Map();
	const rows = await sql`
		SELECT strategy_id,
		       count(*) FILTER (WHERE status = 'closed')::int AS closed,
		       count(*) FILTER (WHERE status IN ('open','closing'))::int AS open,
		       count(*) FILTER (WHERE status = 'closed' AND realized_pnl_lamports > 0)::int AS wins,
		       count(*) FILTER (WHERE status = 'closed' AND realized_pnl_lamports <= 0)::int AS losses,
		       COALESCE(SUM(realized_pnl_lamports) FILTER (WHERE status = 'closed'), 0)::text AS pnl_lamports,
		       COALESCE(SUM(entry_lamports) FILTER (WHERE status = 'closed'), 0)::text AS entry_lamports,
		       COALESCE(MIN(realized_pnl_lamports) FILTER (WHERE status = 'closed'), 0)::text AS worst_lamports,
		       MAX(closed_at) AS last_closed_at
		FROM agent_strategy_positions
		WHERE strategy_id = ANY(${ids})
		GROUP BY strategy_id
	`.catch(() => []);
	const map = new Map();
	for (const r of rows) {
		const closed = Number(r.closed || 0);
		const pnl = Number(r.pnl_lamports || 0) / 1e9;
		const entry = Number(r.entry_lamports || 0) / 1e9;
		map.set(r.strategy_id, {
			proven: closed > 0,
			trades: closed,
			open: Number(r.open || 0),
			wins: Number(r.wins || 0),
			losses: Number(r.losses || 0),
			pnl_sol: Number(pnl.toFixed(4)),
			roi_pct: entry > 0 ? Number(((pnl / entry) * 100).toFixed(1)) : null,
			win_rate: closed > 0 ? Number(((Number(r.wins || 0) / closed) * 100).toFixed(0)) : null,
			worst_sol: Number((Number(r.worst_lamports || 0) / 1e9).toFixed(4)),
			last_closed_at: r.last_closed_at || null,
		});
	}
	return map;
}

function publicStrategy(row, perf, ownerName) {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description || null,
		config: row.config,
		version: row.version,
		published: row.published,
		published_at: row.published_at || null,
		owner_id: row.owner_id,
		owner_name: ownerName || null,
		fork_of: row.fork_of || null,
		forked_from: row.forked_from || null,
		forks_count: Number(row.forks_count || 0),
		equips_count: Number(row.equips_count || 0),
		created_at: row.created_at,
		updated_at: row.updated_at,
		performance: perf || { proven: false, trades: 0, open: 0 },
	};
}

async function ownerNames(ids) {
	if (!ids.length) return new Map();
	const rows = await sql`SELECT id, COALESCE(display_name, username) AS name FROM users WHERE id = ANY(${ids})`.catch(() => []);
	return new Map(rows.map((u) => [u.id, u.name]));
}

// GET /api/strategies?scope=mine|published&sort=&q=&limit=
async function handleList(req, res, auth) {
	const p = new URL(req.url, 'http://x').searchParams;
	const scope = p.get('scope') === 'mine' ? 'mine' : 'published';
	const sort = LIST_SORTS.has(p.get('sort')) ? p.get('sort') : (scope === 'published' ? 'performance' : 'recent');
	const q = (p.get('q') || '').trim().slice(0, 80);
	const limit = Math.min(60, Math.max(1, parseInt(p.get('limit') || '30', 10) || 30));

	if (scope === 'mine') {
		if (!auth) return error(res, 401, 'unauthorized', 'sign in to view your strategies');
		const rl = await limits.authedReadIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
		const rows = await sql`
			SELECT * FROM agent_strategies
			WHERE owner_id = ${auth.userId} AND deleted_at IS NULL
			${q ? sql`AND name ILIKE ${'%' + q + '%'}` : sql``}
			ORDER BY updated_at DESC
			LIMIT ${limit}
		`;
		const perf = await performanceByStrategy(rows.map((r) => r.id));
		const names = await ownerNames([auth.userId]);
		return json(res, 200, { data: { scope, strategies: rows.map((r) => publicStrategy(r, perf.get(r.id), names.get(r.owner_id))) } });
	}

	// Published marketplace (public). Optional filters: `author` (a user id) or
	// `agent` (resolve that agent's creator server-side, so the agent-profile panel
	// can show "strategies this creator publishes" without exposing the owner id).
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	let author = isUuid(p.get('author')) ? p.get('author') : null;
	const agentParam = p.get('agent');
	if (!author && isUuid(agentParam)) {
		const [a] = await sql`SELECT user_id FROM agent_identities WHERE id = ${agentParam} AND deleted_at IS NULL`.catch(() => [null]);
		author = a?.user_id || null;
		if (!author) return json(res, 200, { data: { scope, sort, strategies: [] } });
	}
	const rows = await sql`
		SELECT * FROM agent_strategies
		WHERE published = true AND deleted_at IS NULL
		${author ? sql`AND owner_id = ${author}` : sql``}
		${q ? sql`AND (name ILIKE ${'%' + q + '%'} OR description ILIKE ${'%' + q + '%'})` : sql``}
		ORDER BY ${sort === 'forks' ? sql`forks_count DESC` : sort === 'equips' ? sql`equips_count DESC` : sql`published_at DESC`}
		LIMIT ${limit}
	`;
	const perf = await performanceByStrategy(rows.map((r) => r.id));
	const names = await ownerNames([...new Set(rows.map((r) => r.owner_id))]);
	let strategies = rows.map((r) => publicStrategy(r, perf.get(r.id), names.get(r.owner_id)));
	// "performance" sort ranks proven strategies by ROI, then unproven by recency —
	// a real, honest order (no synthetic curve can climb it).
	if (sort === 'performance') {
		strategies = strategies.sort((a, b) => {
			const ap = a.performance.proven ? 1 : 0, bp = b.performance.proven ? 1 : 0;
			if (ap !== bp) return bp - ap;
			if (ap && bp) return (b.performance.roi_pct ?? -1e9) - (a.performance.roi_pct ?? -1e9);
			return new Date(b.published_at || 0) - new Date(a.published_at || 0);
		});
	}
	return json(res, 200, { data: { scope, sort, strategies } });
}

// GET /api/strategies/leaderboard — proven published strategies, ranked by real ROI.
async function handleLeaderboard(req, res) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const limit = Math.min(50, Math.max(1, parseInt(new URL(req.url, 'http://x').searchParams.get('limit') || '20', 10) || 20));
	const rows = await sql`SELECT * FROM agent_strategies WHERE published = true AND deleted_at IS NULL LIMIT 200`;
	const perf = await performanceByStrategy(rows.map((r) => r.id));
	const names = await ownerNames([...new Set(rows.map((r) => r.owner_id))]);
	const ranked = rows
		.map((r) => publicStrategy(r, perf.get(r.id), names.get(r.owner_id)))
		.filter((s) => s.performance.proven)
		.sort((a, b) => (b.performance.roi_pct ?? -1e9) - (a.performance.roi_pct ?? -1e9))
		.slice(0, limit)
		.map((s, i) => ({ ...s, rank: i + 1 }));
	return json(res, 200, { data: { leaders: ranked, count: ranked.length } });
}

// POST /api/strategies — create.
async function handleCreate(req, res, auth) {
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	if (!(await requireCsrf(req, res, auth.userId))) return;
	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'invalid JSON body');

	const name = String(body.name || '').trim().slice(0, 80);
	if (!name) return error(res, 400, 'validation_error', 'a strategy needs a name');
	const description = body.description == null ? null : String(body.description).slice(0, 2000);

	const { valid, errors, config } = validateStrategyConfig(body.config);
	if (!valid) return error(res, 400, 'validation_error', 'strategy rules are invalid', { errors });

	const slug = await uniqueSlug(auth.userId, name);
	const [row] = await sql`
		INSERT INTO agent_strategies (owner_id, name, slug, description, config, version)
		VALUES (${auth.userId}, ${name}, ${slug}, ${description}, ${JSON.stringify(config)}::jsonb, 1)
		RETURNING *
	`;
	logAudit({ userId: auth.userId, action: 'strategy.create', resourceId: row.id, meta: { name } });
	const names = await ownerNames([auth.userId]);
	return json(res, 201, { data: publicStrategy(row, { proven: false, trades: 0, open: 0 }, names.get(auth.userId)) });
}

// A per-owner unique slug — append -2, -3… on collision (matches the partial unique index).
async function uniqueSlug(ownerId, name) {
	const base = slugifyStrategy(name);
	const taken = await sql`SELECT slug FROM agent_strategies WHERE owner_id = ${ownerId} AND deleted_at IS NULL AND (slug = ${base} OR slug LIKE ${base + '-%'})`.catch(() => []);
	const set = new Set(taken.map((r) => r.slug));
	if (!set.has(base)) return base;
	for (let i = 2; i < 1000; i++) { const c = `${base}-${i}`; if (!set.has(c)) return c; }
	return `${base}-${Date.now()}`;
}

async function loadStrategy(id) {
	const [row] = await sql`SELECT * FROM agent_strategies WHERE id = ${id} AND deleted_at IS NULL`;
	return row || null;
}

// GET /api/strategies/:id
async function handleGetOne(req, res, auth, id) {
	const row = await loadStrategy(id);
	if (!row) return error(res, 404, 'not_found', 'strategy not found');
	const isOwner = auth && row.owner_id === auth.userId;
	if (!row.published && !isOwner) return error(res, 404, 'not_found', 'strategy not found');
	const perf = await performanceByStrategy([id]);
	const names = await ownerNames([row.owner_id]);
	// Where it's equipped — owner sees the live equip surface; everyone sees the count.
	const [eq] = await sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE active) AS active FROM agent_strategy_equips WHERE strategy_id = ${id}`.catch(() => [{ n: 0, active: 0 }]);
	return json(res, 200, {
		data: {
			...publicStrategy(row, perf.get(id), names.get(row.owner_id)),
			is_owner: !!isOwner,
			equipped: { total: Number(eq?.n || 0), active: Number(eq?.active || 0) },
		},
	});
}

// PATCH /api/strategies/:id — edit (owner). Bumps version; re-snapshots into no equip
// (existing equips keep their pinned config_snapshot until re-equipped).
async function handleUpdate(req, res, auth, id) {
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const row = await loadStrategy(id);
	if (!row) return error(res, 404, 'not_found', 'strategy not found');
	if (row.owner_id !== auth.userId) return error(res, 403, 'forbidden', 'not your strategy');
	if (!(await requireCsrf(req, res, auth.userId))) return;
	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'invalid JSON body');

	let { name, slug, description, config, version } = row;
	let bump = false;
	if (typeof body.name === 'string' && body.name.trim()) {
		const next = body.name.trim().slice(0, 80);
		if (next !== name) { name = next; slug = await uniqueSlug(auth.userId, next); }
	}
	if (body.description !== undefined) description = body.description == null ? null : String(body.description).slice(0, 2000);
	if (body.config !== undefined) {
		const r = validateStrategyConfig(body.config);
		if (!r.valid) return error(res, 400, 'validation_error', 'strategy rules are invalid', { errors: r.errors });
		if (JSON.stringify(r.config) !== JSON.stringify(row.config)) { config = r.config; bump = true; }
	}
	const nextVersion = bump ? version + 1 : version;
	const [updated] = await sql`
		UPDATE agent_strategies
		SET name = ${name}, slug = ${slug}, description = ${description},
		    config = ${JSON.stringify(config)}::jsonb, version = ${nextVersion}, updated_at = now()
		WHERE id = ${id}
		RETURNING *
	`;
	logAudit({ userId: auth.userId, action: 'strategy.update', resourceId: id, meta: { version: nextVersion } });
	const perf = await performanceByStrategy([id]);
	const names = await ownerNames([auth.userId]);
	return json(res, 200, { data: publicStrategy(updated, perf.get(id), names.get(auth.userId)) });
}

// DELETE /api/strategies/:id — soft-delete (owner). Deactivates equips so the
// runtime stops evaluating it; open positions remain owner-managed.
async function handleDelete(req, res, auth, id) {
	const row = await loadStrategy(id);
	if (!row) return error(res, 404, 'not_found', 'strategy not found');
	if (row.owner_id !== auth.userId) return error(res, 403, 'forbidden', 'not your strategy');
	if (!(await requireCsrf(req, res, auth.userId))) return;
	await sql`UPDATE agent_strategies SET deleted_at = now(), published = false WHERE id = ${id}`;
	await sql`UPDATE agent_strategy_equips SET active = false, updated_at = now() WHERE strategy_id = ${id}`.catch(() => {});
	logAudit({ userId: auth.userId, action: 'strategy.delete', resourceId: id });
	return json(res, 200, { data: { deleted: true } });
}

// POST /api/strategies/:id/fork — clone the RULES into the caller's library.
// Fresh ownership, lineage credited to the author. No wallet access transferred:
// the forker runs the rules under THEIR OWN spend policy. Mirrors api/agents/fork.js.
async function handleFork(req, res, auth, id) {
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const src = await loadStrategy(id);
	if (!src) return error(res, 404, 'not_found', 'strategy not found');
	if (!src.published && src.owner_id !== auth.userId) return error(res, 403, 'forbidden', 'this strategy is not published');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const [srcOwner] = await sql`SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ${src.owner_id}`.catch(() => [{}]);
	const forked_from = {
		strategy_id: src.id,
		owner_id: src.owner_id,
		owner_name: srcOwner?.name || null,
		name: src.name,
		version: src.version,
		forked_at: new Date().toISOString(),
	};
	const slug = await uniqueSlug(auth.userId, src.name);
	const [row] = await sql`
		INSERT INTO agent_strategies (owner_id, name, slug, description, config, version, fork_of, forked_from)
		VALUES (${auth.userId}, ${src.name}, ${slug}, ${src.description}, ${JSON.stringify(src.config)}::jsonb, 1, ${src.id}, ${JSON.stringify(forked_from)}::jsonb)
		RETURNING *
	`;
	await sql`UPDATE agent_strategies SET forks_count = forks_count + 1 WHERE id = ${src.id}`.catch(() => {});
	logAudit({ userId: auth.userId, action: 'strategy.fork', resourceId: row.id, meta: { fork_of: src.id, author: src.owner_id } });
	const names = await ownerNames([auth.userId]);
	return json(res, 201, { data: publicStrategy(row, { proven: false, trades: 0, open: 0 }, names.get(auth.userId)) });
}

// POST /api/strategies/:id/publish — toggle published (owner).
async function handlePublish(req, res, auth, id) {
	const row = await loadStrategy(id);
	if (!row) return error(res, 404, 'not_found', 'strategy not found');
	if (row.owner_id !== auth.userId) return error(res, 403, 'forbidden', 'not your strategy');
	if (!(await requireCsrf(req, res, auth.userId))) return;
	const body = await readJson(req).catch(() => ({}));
	const next = body?.published === undefined ? !row.published : !!body.published;
	const [updated] = await sql`
		UPDATE agent_strategies
		SET published = ${next}, published_at = ${next ? sql`COALESCE(published_at, now())` : sql`published_at`}, updated_at = now()
		WHERE id = ${id}
		RETURNING *
	`;
	logAudit({ userId: auth.userId, action: 'strategy.publish', resourceId: id, meta: { published: next } });
	const perf = await performanceByStrategy([id]);
	const names = await ownerNames([auth.userId]);
	return json(res, 200, { data: publicStrategy(updated, perf.get(id), names.get(auth.userId)) });
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;

	const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean); // ['api','strategies', maybe id, maybe action]
	const seg = parts[2] || null;
	const action = parts[3] || null;
	const auth = await resolveAuth(req);

	// Collection + special collection routes.
	if (!seg) {
		if (req.method === 'GET') return handleList(req, res, auth);
		if (req.method === 'POST') {
			if (!auth) return error(res, 401, 'unauthorized', 'sign in to create a strategy');
			return handleCreate(req, res, auth);
		}
		return error(res, 405, 'method_not_allowed', 'unsupported method');
	}
	if (seg === 'leaderboard') return handleLeaderboard(req, res);

	if (!isUuid(seg)) return error(res, 404, 'not_found', 'strategy not found');
	const id = seg;

	if (req.method === 'GET' && !action) return handleGetOne(req, res, auth, id);

	// Everything below mutates → requires auth.
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (req.method === 'POST' && action === 'fork') return handleFork(req, res, auth, id);
	if (req.method === 'POST' && action === 'publish') return handlePublish(req, res, auth, id);
	if (req.method === 'PATCH' && !action) return handleUpdate(req, res, auth, id);
	if (req.method === 'DELETE' && !action) return handleDelete(req, res, auth, id);
	return error(res, 404, 'not_found', `unknown strategy route: ${action || req.method}`);
});
