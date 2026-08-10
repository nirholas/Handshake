// GET    /api/agent/market-maker?agentId=<uuid>  — list MM configs + recent trades
// POST   /api/agent/market-maker                  — upsert MM config
// DELETE /api/agent/market-maker?id=<config_id>  — disable MM config (soft-delete)
//
// Auth: session cookie or bearer JWT.
// The calling user must own the target agent (verified via agent_identities).

import { cors, error, json, method, readJson, rateLimited, wrap } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import { sql } from '../_lib/db.js';

// ── auth ──────────────────────────────────────────────────────────────────────

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// ── ownership ─────────────────────────────────────────────────────────────────

// agent_identities.id and agent_market_maker_configs.id are uuid columns: an id
// that isn't a uuid makes Postgres raise 22P02, which reaches the caller as a
// 500 (and pages ops) instead of the 400 that names the real mistake. Every id
// that reaches a query below is shape-checked first.
async function assertOwnsAgent(userId, agentId) {
	if (!isUuid(agentId)) return false;
	const [row] = await sql`
		SELECT id FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
		LIMIT 1
	`;
	return !!row;
}

// ── validation ────────────────────────────────────────────────────────────────

const VALID_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VALID_TIP_MODES = new Set(['off', 'economy', 'turbo']);

function clampInt(val, min, max, fallback) {
	const n = Math.round(Number(val));
	return isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}
function clampFloat(val, min, max, fallback) {
	const n = Number(val);
	return isNaN(n) || n <= 0 ? fallback : Math.min(max, Math.max(min, n));
}

// ── handler ───────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'authentication required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many market-maker requests');

	// ── GET ───────────────────────────────────────────────────────────────────
	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://x');
		const agentId = url.searchParams.get('agentId');
		if (!agentId) return error(res, 400, 'validation_error', 'agentId query param required');
		if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');
		if (!(await assertOwnsAgent(auth.userId, agentId))) {
			return error(res, 403, 'forbidden', 'agent not owned by this user');
		}

		const [configs, recent_trades] = await Promise.all([
			sql`
				SELECT * FROM agent_market_maker_configs
				WHERE agent_id = ${agentId}
				ORDER BY created_at DESC
			`,
			sql`
				SELECT * FROM agent_market_maker_trades
				WHERE agent_id = ${agentId}
				ORDER BY created_at DESC
				LIMIT 100
			`,
		]);

		return json(res, 200, { configs, recent_trades });
	}

	// ── DELETE (disable) ──────────────────────────────────────────────────────
	if (req.method === 'DELETE') {
		const url = new URL(req.url, 'http://x');
		const configId = url.searchParams.get('id');
		if (!configId) return error(res, 400, 'validation_error', 'id query param required');
		if (!isUuid(configId)) return error(res, 400, 'validation_error', 'id must be a uuid');

		// Ownership check via join — one query.
		const [cfg] = await sql`
			SELECT c.id FROM agent_market_maker_configs c
			JOIN agent_identities a ON a.id = c.agent_id AND a.deleted_at IS NULL
			WHERE c.id = ${configId} AND a.user_id = ${auth.userId}
			LIMIT 1
		`;
		if (!cfg) return error(res, 404, 'not_found', 'config not found or not owned');

		// Disable rather than delete to preserve trade history.
		await sql`
			UPDATE agent_market_maker_configs
			SET enabled = false, updated_at = now()
			WHERE id = ${configId}
		`;
		return json(res, 200, { ok: true });
	}

	// ── POST ──────────────────────────────────────────────────────────────────
	if (!method(req, res, ['POST'])) return;

	const body = await readJson(req);
	const { agentId, mint } = body ?? {};

	if (!agentId) return error(res, 400, 'validation_error', 'agentId is required');
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');
	if (!mint || !VALID_BASE58.test(mint)) {
		return error(res, 400, 'validation_error', 'mint must be a valid base-58 Solana address (32 to 44 chars)');
	}
	if (!(await assertOwnsAgent(auth.userId, agentId))) {
		return error(res, 403, 'forbidden', 'agent not owned by this user');
	}

	// Coerce and clamp all optional fields against spec limits.
	const symbol              = body.symbol ? String(body.symbol).trim().slice(0, 16) || null : null;
	// The worker only runs the two Solana clusters; anything else would write a
	// config no runner ever picks up.
	const network             = body.network === 'devnet' ? 'devnet' : 'mainnet';
	const enabled             = body.enabled != null ? Boolean(body.enabled) : true;
	const spread_bps          = clampInt(body.spread_bps, 10, 2000, 200);
	const order_size_sol      = clampFloat(body.order_size_sol, 0, 100, 0.05);
	const max_inventory_sol   = clampFloat(body.max_inventory_sol, 0, 1000, 1.0);
	const min_profit_bps      = clampInt(body.min_profit_bps, 1, 1000, 50);
	const rebalance_interval_ms = clampInt(body.rebalance_interval_ms, 1, Number.MAX_SAFE_INTEGER, 10000);
	const mev_tip_mode        = VALID_TIP_MODES.has(body.mev_tip_mode) ? body.mev_tip_mode : 'off';

	const [config] = await sql`
		INSERT INTO agent_market_maker_configs
			(agent_id, enabled, mint, symbol, network,
			 spread_bps, order_size_sol, max_inventory_sol, min_profit_bps,
			 rebalance_interval_ms, mev_tip_mode, updated_at)
		VALUES
			(${agentId}, ${enabled}, ${mint}, ${symbol}, ${network},
			 ${spread_bps}, ${order_size_sol}, ${max_inventory_sol}, ${min_profit_bps},
			 ${rebalance_interval_ms}, ${mev_tip_mode}, now())
		ON CONFLICT (agent_id, mint)
		DO UPDATE SET
			enabled               = EXCLUDED.enabled,
			symbol                = EXCLUDED.symbol,
			network               = EXCLUDED.network,
			spread_bps            = EXCLUDED.spread_bps,
			order_size_sol        = EXCLUDED.order_size_sol,
			max_inventory_sol     = EXCLUDED.max_inventory_sol,
			min_profit_bps        = EXCLUDED.min_profit_bps,
			rebalance_interval_ms = EXCLUDED.rebalance_interval_ms,
			mev_tip_mode          = EXCLUDED.mev_tip_mode,
			updated_at            = now()
		RETURNING *
	`;

	return json(res, 200, { ok: true, config });
});
