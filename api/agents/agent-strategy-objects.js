// /api/agents/:id/strategies — equip / unequip Strategy Objects on an agent and
// drive the leashed runtime. Owner-only to configure; every strategy-initiated
// trade executes through the task-05 engine inside the agent's spend policy
// (api/_lib/agent-strategy-runtime.js) — this surface manages the equip bindings
// and the per-owner kill switch; it never bypasses a guard.
//
//   GET    /api/agents/:id/strategies            equipped strategies + live positions + kill state (owner)
//   POST   /api/agents/:id/strategies            equip a strategy { strategy_id, network } (owner)
//   POST   /api/agents/:id/strategies/unequip    unequip { equip_id | strategy_id } (owner)
//   POST   /api/agents/:id/strategies/toggle     pause/resume one equip { equip_id, active } (owner)
//   POST   /api/agents/:id/strategies/kill       toggle the per-owner global kill switch (owner)
//   POST   /api/agents/:id/strategies/sweep      evaluate this agent's equips now (owner "Run now")
//   POST   /api/agents/:id/strategies/close      force-close ONE open position now { position_id } (owner "Sell now")

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { logAudit } from '../_lib/audit.js';
import { normalizeStrategyConfig } from '../_lib/strategy-schema.js';
import { evaluateEquip, recentPumpLaunchesSafe, closeStrategyPositionNow } from '../_lib/agent-strategy-runtime.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const netOf = (v) => (NETWORKS.has(v) ? v : 'mainnet');

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

async function loadOwned(req, res, id) {
	const auth = await resolveAuth(req);
	if (!auth) { error(res, 401, 'unauthorized', 'sign in to manage strategies'); return null; }
	const [row] = await sql`SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) { error(res, 404, 'not_found', 'agent not found'); return null; }
	if (row.user_id !== auth.userId) { error(res, 403, 'forbidden', 'only the owner can equip strategies on this agent'); return null; }
	return { auth, row };
}

async function killEngaged(ownerId) {
	const [r] = await sql`SELECT engaged FROM strategy_kill_switch WHERE owner_id = ${ownerId}`.catch(() => [null]);
	return !!r?.engaged;
}

function equipView(e, perf) {
	return {
		equip_id: e.id,
		strategy_id: e.strategy_id,
		strategy_name: e.strategy_name,
		slug: e.slug,
		owner_id: e.owner_id,
		author_id: e.author_id,
		network: e.network,
		active: e.active,
		strategy_version: e.strategy_version,
		config: e.config_snapshot,
		last_eval_at: e.last_eval_at || null,
		last_fired_at: e.last_fired_at || null,
		fires_count: Number(e.fires_count || 0),
		performance: perf || { proven: false, trades: 0, open: 0 },
	};
}

// GET — equipped strategies, their live positions, and the global kill state.
async function handleGet(req, res, id) {
	const owned = await loadOwned(req, res, id);
	if (!owned) return;
	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const equips = await sql`
		SELECT e.*, s.name AS strategy_name, s.slug, s.owner_id AS author_id
		FROM agent_strategy_equips e
		JOIN agent_strategies s ON s.id = e.strategy_id AND s.deleted_at IS NULL
		WHERE e.agent_id = ${id}
		ORDER BY e.created_at DESC
	`;
	const equipIds = equips.map((e) => e.id);

	// Live performance per equip from real closed positions, plus the open positions.
	let perfMap = new Map();
	let positions = [];
	if (equipIds.length) {
		const perfRows = await sql`
			SELECT equip_id,
			       count(*) FILTER (WHERE status = 'closed')::int AS closed,
			       count(*) FILTER (WHERE status IN ('open','closing'))::int AS open,
			       count(*) FILTER (WHERE status = 'closed' AND realized_pnl_lamports > 0)::int AS wins,
			       COALESCE(SUM(realized_pnl_lamports) FILTER (WHERE status = 'closed'), 0)::text AS pnl_lamports,
			       COALESCE(SUM(entry_lamports) FILTER (WHERE status = 'closed'), 0)::text AS entry_lamports
			FROM agent_strategy_positions WHERE equip_id = ANY(${equipIds}) GROUP BY equip_id
		`.catch(() => []);
		for (const r of perfRows) {
			const closed = Number(r.closed || 0);
			const pnl = Number(r.pnl_lamports || 0) / 1e9;
			const entry = Number(r.entry_lamports || 0) / 1e9;
			perfMap.set(r.equip_id, {
				proven: closed > 0, trades: closed, open: Number(r.open || 0),
				pnl_sol: Number(pnl.toFixed(4)),
				roi_pct: entry > 0 ? Number(((pnl / entry) * 100).toFixed(1)) : null,
				win_rate: closed > 0 ? Number(((Number(r.wins || 0) / closed) * 100).toFixed(0)) : null,
			});
		}
		positions = await sql`
			SELECT id, equip_id, strategy_id, mint, symbol, name, status, exit_reason,
			       entry_sig, entry_lamports, exit_sig, exit_lamports, realized_pnl_lamports, realized_pnl_pct,
			       last_value_lamports, peak_value_lamports, opened_at, closed_at
			FROM agent_strategy_positions
			WHERE equip_id = ANY(${equipIds})
			ORDER BY (status IN ('open','closing')) DESC, opened_at DESC
			LIMIT 60
		`.catch(() => []);
	}

	return json(res, 200, {
		data: {
			killed: await killEngaged(owned.auth.userId),
			equips: equips.map((e) => equipView(e, perfMap.get(e.id))),
			positions: positions.map((p) => ({
				id: p.id, equip_id: p.equip_id, strategy_id: p.strategy_id,
				mint: p.mint, symbol: p.symbol, name: p.name, status: p.status, exit_reason: p.exit_reason,
				entry_sig: p.entry_sig, exit_sig: p.exit_sig,
				entry_sol: p.entry_lamports != null ? Number(p.entry_lamports) / 1e9 : null,
				exit_sol: p.exit_lamports != null ? Number(p.exit_lamports) / 1e9 : null,
				value_sol: p.last_value_lamports != null ? Number(p.last_value_lamports) / 1e9 : null,
				pnl_sol: p.realized_pnl_lamports != null ? Number(p.realized_pnl_lamports) / 1e9 : null,
				pnl_pct: p.realized_pnl_pct != null ? Number(p.realized_pnl_pct) : null,
				opened_at: p.opened_at, closed_at: p.closed_at,
			})),
		},
	});
}

// POST — equip a strategy on this agent.
async function handleEquip(req, res, id) {
	const owned = await loadOwned(req, res, id);
	if (!owned) return;
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	if (!owned.row.meta?.solana_address) return error(res, 409, 'wallet_preparing', 'this agent’s wallet is still provisioning');

	const body = await readJson(req).catch(() => null);
	const strategyId = body?.strategy_id;
	if (!isUuid(strategyId)) return error(res, 400, 'validation_error', 'a valid strategy_id is required');
	const network = netOf(body?.network);

	// The strategy must be the caller's own OR a published one (forking is the path to
	// owning the rules; equipping a published strategy runs it under YOUR spend policy).
	const [strat] = await sql`SELECT id, owner_id, name, config, version, published FROM agent_strategies WHERE id = ${strategyId} AND deleted_at IS NULL`;
	if (!strat) return error(res, 404, 'not_found', 'strategy not found');
	if (strat.owner_id !== owned.auth.userId && !strat.published) return error(res, 403, 'forbidden', 'this strategy is not published');

	const snapshot = normalizeStrategyConfig(strat.config);
	const [equip] = await sql`
		INSERT INTO agent_strategy_equips (strategy_id, agent_id, owner_id, config_snapshot, strategy_version, network, active)
		VALUES (${strategyId}, ${id}, ${owned.auth.userId}, ${JSON.stringify(snapshot)}::jsonb, ${strat.version}, ${network}, true)
		ON CONFLICT (agent_id, strategy_id) DO UPDATE SET
			active = true, network = ${network},
			config_snapshot = ${JSON.stringify(snapshot)}::jsonb, strategy_version = ${strat.version},
			updated_at = now()
		RETURNING *
	`;
	await sql`UPDATE agent_strategies SET equips_count = (SELECT count(*) FROM agent_strategy_equips WHERE strategy_id = ${strategyId} AND active = true) WHERE id = ${strategyId}`.catch(() => {});
	logAudit({ userId: owned.auth.userId, action: 'strategy.equip', resourceId: id, meta: { strategy_id: strategyId, network } });
	return json(res, 200, { data: { equip: equipView({ ...equip, strategy_name: strat.name, slug: null, author_id: strat.owner_id }, { proven: false, trades: 0, open: 0 }) } });
}

async function handleUnequip(req, res, id) {
	const owned = await loadOwned(req, res, id);
	if (!owned) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	const body = await readJson(req).catch(() => ({}));
	const where = isUuid(body?.equip_id)
		? sql`id = ${body.equip_id} AND agent_id = ${id}`
		: isUuid(body?.strategy_id)
			? sql`strategy_id = ${body.strategy_id} AND agent_id = ${id}`
			: null;
	if (!where) return error(res, 400, 'validation_error', 'equip_id or strategy_id required');
	const [removed] = await sql`UPDATE agent_strategy_equips SET active = false, updated_at = now() WHERE ${where} RETURNING strategy_id`;
	if (removed) {
		await sql`UPDATE agent_strategies SET equips_count = (SELECT count(*) FROM agent_strategy_equips WHERE strategy_id = ${removed.strategy_id} AND active = true) WHERE id = ${removed.strategy_id}`.catch(() => {});
	}
	logAudit({ userId: owned.auth.userId, action: 'strategy.unequip', resourceId: id, meta: { strategy_id: removed?.strategy_id } });
	return json(res, 200, { data: { unequipped: !!removed } });
}

async function handleToggle(req, res, id) {
	const owned = await loadOwned(req, res, id);
	if (!owned) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	const body = await readJson(req).catch(() => ({}));
	if (!isUuid(body?.equip_id)) return error(res, 400, 'validation_error', 'equip_id required');
	const active = body.active !== false;
	const [row] = await sql`UPDATE agent_strategy_equips SET active = ${active}, updated_at = now() WHERE id = ${body.equip_id} AND agent_id = ${id} RETURNING strategy_id`;
	if (!row) return error(res, 404, 'not_found', 'equip not found');
	await sql`UPDATE agent_strategies SET equips_count = (SELECT count(*) FROM agent_strategy_equips WHERE strategy_id = ${row.strategy_id} AND active = true) WHERE id = ${row.strategy_id}`.catch(() => {});
	return json(res, 200, { data: { active } });
}

// POST kill — toggle the per-owner GLOBAL kill switch (halts ALL the owner's strategies).
async function handleKill(req, res, id) {
	const owned = await loadOwned(req, res, id);
	if (!owned) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	const body = await readJson(req).catch(() => ({}));
	const current = await killEngaged(owned.auth.userId);
	const next = body?.killed === undefined ? !current : !!body.killed;
	await sql`
		INSERT INTO strategy_kill_switch (owner_id, engaged, engaged_at, updated_at)
		VALUES (${owned.auth.userId}, ${next}, ${next ? sql`now()` : null}, now())
		ON CONFLICT (owner_id) DO UPDATE SET engaged = ${next}, engaged_at = ${next ? sql`now()` : null}, updated_at = now()
	`;
	logAudit({ userId: owned.auth.userId, action: 'strategy.kill', resourceId: id, meta: { engaged: next } });
	return json(res, 200, { data: { killed: next } });
}

// POST sweep — evaluate THIS agent's active equips now (owner "Run now"). Exits run
// even when killed (mark-to-market); entries only when not killed.
async function handleSweep(req, res, id) {
	const owned = await loadOwned(req, res, id);
	if (!owned) return;
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;

	const killed = await killEngaged(owned.auth.userId);
	const equips = await sql`
		SELECT e.*, s.name AS strategy_name, s.slug
		FROM agent_strategy_equips e
		JOIN agent_strategies s ON s.id = e.strategy_id AND s.deleted_at IS NULL
		WHERE e.agent_id = ${id} AND e.active = true
		ORDER BY e.last_eval_at ASC NULLS FIRST
	`;
	if (!equips.length) return json(res, 200, { data: { evaluated: 0, results: [] } });

	const byNet = new Set(equips.map((e) => netOf(e.network)));
	const launchesByNet = {};
	for (const net of byNet) launchesByNet[net] = await recentPumpLaunchesSafe(net);

	const nowMs = Date.now();
	const out = [];
	for (const e of equips) {
		try {
			const r = await evaluateEquip(e, { launches: launchesByNet[netOf(e.network)], nowMs, killed, maxEntries: 3 });
			out.push({ equip_id: e.id, strategy_name: e.strategy_name, results: r.results });
		} catch (err) {
			out.push({ equip_id: e.id, strategy_name: e.strategy_name, error: (err?.message || 'error').slice(0, 140) });
		}
	}
	return json(res, 200, { data: { evaluated: equips.length, killed, results: out } });
}

// POST close — owner force-closes ONE open strategy position now ("Sell now").
async function handleClose(req, res, id) {
	const owned = await loadOwned(req, res, id);
	if (!owned) return;
	const rl = await limits.tradePerUser(owned.auth.userId);
	if (!rl.success) return rateLimited(res, rl);
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	const body = await readJson(req).catch(() => ({}));
	if (!isUuid(body?.position_id)) return error(res, 400, 'validation_error', 'a valid position_id is required');

	let result;
	try {
		result = await closeStrategyPositionNow({ positionId: body.position_id, ownerId: owned.auth.userId, agentId: id });
	} catch (err) {
		return error(res, 500, 'internal_error', 'unexpected error closing the position');
	}
	if (!result.ok) return error(res, result.status || 500, result.code || 'error', result.message || 'could not close the position');
	logAudit({ userId: owned.auth.userId, action: 'strategy.position_close', resourceId: id, meta: { position_id: body.position_id, pnl_sol: result.data?.pnl_sol ?? null } });
	return json(res, 200, { data: result.data });
}

export default async function handler(req, res, id, action) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!isUuid(id)) return error(res, 404, 'not_found', 'agent not found');

	if (req.method === 'GET' && !action) return handleGet(req, res, id);
	if (req.method === 'POST' && !action) return handleEquip(req, res, id);
	if (req.method === 'POST' && action === 'unequip') return handleUnequip(req, res, id);
	if (req.method === 'POST' && action === 'toggle') return handleToggle(req, res, id);
	if (req.method === 'POST' && action === 'kill') return handleKill(req, res, id);
	if (req.method === 'POST' && action === 'sweep') return handleSweep(req, res, id);
	if (req.method === 'POST' && action === 'close') return handleClose(req, res, id);
	return error(res, 404, 'not_found', `unknown strategies route: ${action || req.method}`);
}
