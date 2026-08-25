/**
 * Agent Launcher — config CRUD and launched coin history.
 *
 *   GET    /api/agent/launcher?agentId=<uuid>
 *     Returns { configs: [...], coins: [...] }
 *     configs = agent_launcher_configs rows for the owned agent
 *     coins   = last 50 agent_launched_coins for the agent, newest first
 *
 *   GET    /api/agent/launcher?all=1
 *     Account-wide view: every launcher config and launched coin across all
 *     agents the caller owns, in two queries. Rows carry agent_name and
 *     agent_image. Returns { configs, coins, scope: 'all' }.
 *
 *   POST   /api/agent/launcher
 *     UPSERT a launcher config (one row per agent per network).
 *     Returns { ok: true, config: {...} }
 *
 *   DELETE /api/agent/launcher?id=<config_id>
 *     Delete a launcher config (caller must own the agent).
 *     Returns { ok: true }
 *
 * Auth: session cookie OR bearer JWT, scoped to agents the caller owns
 * (agent_identities.user_id). Rate-limited via the standard authIp bucket.
 */

import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import { sql } from '../_lib/db.js';

// ── Auth helper ──────────────────────────────────────────────────────────────

async function resolveUserId(req) {
	const session = await getSessionUser(req);
	if (session?.id) return session.id;
	const bearer = extractBearer(req);
	if (bearer) {
		const auth = await authenticateBearer(bearer).catch(() => null);
		if (auth?.userId) return auth.userId;
	}
	return null;
}

// ── Ownership check ───────────────────────────────────────────────────────────

// agent_identities.id and agent_launcher_configs.id are uuid columns: an id that
// isn't a uuid makes Postgres raise 22P02, which surfaces to the caller as a 500
// (and pages ops) instead of the 400 that actually describes the mistake. Every
// id reaching a query below is shape-checked first.
async function assertOwnsAgent(userId, agentId) {
	if (!isUuid(agentId)) return false;
	const [row] = await sql`
		SELECT id FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
		LIMIT 1
	`;
	return !!row;
}

// ── Route dispatch ───────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const userId = await resolveUserId(req);
	if (!userId) return error(res, 401, 'unauthorized', 'authentication required');

	// Reads fire on every dashboard load and on each Capabilities poll tick, so
	// they use the generous authed-read bucket. Routing them through the strict
	// credential bucket (50/10m, shared with login and register) is what made a
	// single Capabilities load 429 itself; see the authedReadIp note in
	// api/_lib/rate-limit.js. Writes keep the credential bucket.
	const rl = req.method === 'GET'
		? await limits.authedReadIp(clientIp(req))
		: await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'GET') return getConfigs(req, res, userId);
	if (req.method === 'DELETE') return deleteConfig(req, res, userId);
	// POST with action=trigger fires an immediate launch by advancing next_launch_at
	const body0 = await readJson(req).catch(() => ({}));
	if (body0?.action === 'trigger') return triggerNow(req, res, userId, body0);
	return upsertConfig(req, res, userId, body0);
});

// ── GET ──────────────────────────────────────────────────────────────────────

const truthyParam = (v) => v === '1' || v === 'true';

async function getConfigs(req, res, userId) {
	const { searchParams } = new URL(req.url, 'http://localhost');
	const agentId = searchParams.get('agentId');

	// all=1 answers for every agent the caller owns in two queries. The
	// Capabilities command center needs a whole-account view; without this it
	// had to fan out one request per agent (2N per refresh, every 30s), which
	// scaled linearly with the roster and drowned the per-IP budget.
	if (!agentId && truthyParam(searchParams.get('all'))) return getAllConfigs(res, userId);

	if (!agentId) return error(res, 400, 'missing_agent_id', 'agentId is required');
	if (!isUuid(agentId)) return error(res, 400, 'invalid_agent_id', 'agentId must be a uuid');
	if (!(await assertOwnsAgent(userId, agentId))) {
		return error(res, 404, 'not_found', 'agent not found or not owned by you');
	}

	const [configs, coins] = await Promise.all([
		sql`
			SELECT * FROM agent_launcher_configs
			WHERE agent_id = ${agentId}
			ORDER BY created_at ASC
		`,
		sql`
			SELECT *
			FROM agent_launched_coins
			WHERE agent_id = ${agentId}
			ORDER BY created_at DESC
			LIMIT 50
		`,
	]);

	return json(res, 200, { configs, coins });
}

// Account-wide variant of getConfigs. Rows carry the owning agent's display
// fields so a caller rendering a cross-agent table needs no second lookup.
async function getAllConfigs(res, userId) {
	const [configs, coins] = await Promise.all([
		sql`
			SELECT c.*, a.name AS agent_name,
			       COALESCE(a.profile_image_url, a.avatar_url) AS agent_image
			FROM agent_launcher_configs c
			JOIN agent_identities a ON a.id = c.agent_id AND a.deleted_at IS NULL
			WHERE a.user_id = ${userId}
			ORDER BY c.created_at ASC
			LIMIT 200
		`,
		sql`
			SELECT k.*, a.name AS agent_name,
			       COALESCE(a.profile_image_url, a.avatar_url) AS agent_image
			FROM agent_launched_coins k
			JOIN agent_identities a ON a.id = k.agent_id AND a.deleted_at IS NULL
			WHERE a.user_id = ${userId}
			ORDER BY k.created_at DESC
			LIMIT 200
		`,
	]);
	return json(res, 200, { configs, coins, scope: 'all' });
}

// ── POST action=trigger — fire now ───────────────────────────────────────────

async function triggerNow(req, res, userId, body) {
	const { agentId, configId, network } = body || {};
	if (!agentId) return error(res, 400, 'missing_agent_id', 'agentId is required');
	if (!isUuid(agentId)) return error(res, 400, 'invalid_agent_id', 'agentId must be a uuid');
	if (configId != null && !isUuid(configId)) {
		return error(res, 400, 'invalid_config_id', 'configId must be a uuid');
	}
	if (!(await assertOwnsAgent(userId, agentId))) {
		return error(res, 404, 'not_found', 'agent not found or not owned by you');
	}
	const net = network === 'devnet' ? 'devnet' : 'mainnet';

	// Advance next_launch_at to now — worker will fire on its next poll cycle
	let query;
	if (configId) {
		query = sql`
			UPDATE agent_launcher_configs
			SET next_launch_at = now(), updated_at = now()
			WHERE id = ${configId} AND agent_id = ${agentId}
			RETURNING *
		`;
	} else {
		query = sql`
			UPDATE agent_launcher_configs
			SET next_launch_at = now(), updated_at = now()
			WHERE agent_id = ${agentId} AND network = ${net}
			RETURNING *
		`;
	}
	const [config] = await query;
	if (!config) return error(res, 404, 'not_found', 'launcher config not found');
	return json(res, 200, { ok: true, config, message: 'Launch scheduled. The worker fires within 60s.' });
}

// ── POST — upsert ────────────────────────────────────────────────────────────

async function upsertConfig(req, res, userId, body) {
	// The body was already read by the dispatcher (a request stream can only be
	// consumed once), so it arrives here parsed, or `{}` when it wasn't JSON.
	const { agentId } = body || {};
	if (!agentId || typeof agentId !== 'string') {
		return error(res, 400, 'missing_agent_id', 'agentId is required');
	}
	if (!isUuid(agentId)) return error(res, 400, 'invalid_agent_id', 'agentId must be a uuid');
	if (!(await assertOwnsAgent(userId, agentId))) {
		return error(res, 404, 'not_found', 'agent not found or not owned by you');
	}

	// Validate fields before touching the DB
	if (body.symbol != null) {
		const sym = String(body.symbol).trim();
		if (!/^[A-Z0-9]{1,10}$/.test(sym)) {
			return error(res, 400, 'invalid_symbol', 'symbol must be uppercase alphanumeric and at most 10 characters');
		}
	}

	if (body.name_template != null && String(body.name_template).length > 32) {
		return error(res, 400, 'invalid_name_template', 'name_template must be at most 32 characters');
	}

	if (body.network != null && !['mainnet', 'devnet'].includes(body.network)) {
		return error(res, 400, 'invalid_network', 'network must be "mainnet" or "devnet"');
	}

	if (body.interval_hours != null && body.interval_hours !== '') {
		const ih = Number(body.interval_hours);
		if (!Number.isFinite(ih) || ih < 0.5) {
			return error(res, 400, 'invalid_interval_hours', 'interval_hours must be >= 0.5');
		}
	}

	if (body.initial_buy_sol != null && body.initial_buy_sol !== '') {
		const s = Number(body.initial_buy_sol);
		if (!Number.isFinite(s) || s < 0) {
			return error(res, 400, 'invalid_initial_buy_sol', 'initial_buy_sol must be >= 0');
		}
	}

	if (body.auto_claim_reinvest_pct != null && body.auto_claim_reinvest_pct !== '') {
		const p = Number(body.auto_claim_reinvest_pct);
		if (!Number.isFinite(p) || p < 0 || p > 100) {
			return error(res, 400, 'invalid_auto_claim_reinvest_pct', 'auto_claim_reinvest_pct must be between 0 and 100');
		}
	}

	// Coerce + merge against existing row defaults
	const network      = body.network === 'devnet' ? 'devnet' : 'mainnet';
	const enabled      = body.enabled != null ? Boolean(body.enabled) : false;
	const symbol       = body.symbol != null ? String(body.symbol).trim().toUpperCase() : null;
	const nameTemplate = body.name_template != null ? String(body.name_template).slice(0, 32) : null;

	const intervalHours = body.interval_hours != null && body.interval_hours !== ''
		? Math.max(0.5, Number(body.interval_hours))
		: null;
	const maxLaunches = body.max_launches != null && body.max_launches !== ''
		? Math.max(1, Math.round(Number(body.max_launches)))
		: null;

	const initialBuySol         = body.initial_buy_sol != null ? Math.max(0, Number(body.initial_buy_sol)) : null;
	const initialBuySlippageBps = body.initial_buy_slippage_bps != null
		? Math.min(10000, Math.max(0, Math.round(Number(body.initial_buy_slippage_bps))))
		: null;

	const autoClaimEnabled      = body.auto_claim_enabled != null ? Boolean(body.auto_claim_enabled) : null;
	const autoClaimThresholdSol = body.auto_claim_threshold_sol != null ? Math.max(0, Number(body.auto_claim_threshold_sol)) : null;
	const autoClaimReinvestPct  = body.auto_claim_reinvest_pct != null
		? Math.min(100, Math.max(0, Number(body.auto_claim_reinvest_pct)))
		: null;

	// Fetch existing row so the UPSERT can propagate defaults for omitted fields
	const [existing] = await sql`
		SELECT * FROM agent_launcher_configs
		WHERE agent_id = ${agentId} AND network = ${network}
		LIMIT 1
	`;
	const cur = existing || {
		enabled: false,
		interval_hours: null,
		max_launches: null,
		name_template: '',
		symbol: '',
		description: null,
		image_url: null,
		twitter: null,
		telegram: null,
		website: null,
		initial_buy_sol: 0,
		initial_buy_slippage_bps: 500,
		auto_claim_enabled: false,
		auto_claim_threshold_sol: 0,
		auto_claim_reinvest_pct: 0,
	};

	const next = {
		enabled:                  enabled,
		interval_hours:           intervalHours           !== null ? intervalHours           : (cur.interval_hours != null ? Number(cur.interval_hours) : null),
		max_launches:             maxLaunches             !== null ? maxLaunches             : cur.max_launches,
		name_template:            nameTemplate            !== null ? nameTemplate            : (cur.name_template ?? ''),
		symbol:                   symbol                  !== null ? symbol                  : (cur.symbol ?? ''),
		description:              'description'           in body  ? (body.description || null) : (cur.description || null),
		image_url:                'image_url'             in body  ? (body.image_url || null)   : (cur.image_url || null),
		twitter:                  'twitter'               in body  ? (body.twitter || null)     : (cur.twitter || null),
		telegram:                 'telegram'              in body  ? (body.telegram || null)    : (cur.telegram || null),
		website:                  'website'               in body  ? (body.website || null)     : (cur.website || null),
		initial_buy_sol:          initialBuySol           !== null ? initialBuySol           : Number(cur.initial_buy_sol ?? 0),
		initial_buy_slippage_bps: initialBuySlippageBps   !== null ? initialBuySlippageBps   : Number(cur.initial_buy_slippage_bps ?? 500),
		auto_claim_enabled:       autoClaimEnabled        !== null ? autoClaimEnabled        : Boolean(cur.auto_claim_enabled),
		auto_claim_threshold_sol: autoClaimThresholdSol   !== null ? autoClaimThresholdSol   : Number(cur.auto_claim_threshold_sol ?? 0),
		auto_claim_reinvest_pct:  autoClaimReinvestPct    !== null ? autoClaimReinvestPct    : Number(cur.auto_claim_reinvest_pct ?? 0),
	};

	// next_launch_at: reset when enabled transitions true or interval changes
	const resetNextLaunch = next.enabled && (
		!cur.enabled ||
		next.interval_hours !== (cur.interval_hours != null ? Number(cur.interval_hours) : null)
	);

	const [config] = await sql`
		INSERT INTO agent_launcher_configs
			(agent_id, user_id, enabled, network,
			 interval_hours, max_launches,
			 name_template, symbol, description, image_url,
			 twitter, telegram, website,
			 initial_buy_sol, initial_buy_slippage_bps,
			 auto_claim_enabled, auto_claim_threshold_sol, auto_claim_reinvest_pct,
			 updated_at)
		VALUES
			(${agentId}, ${userId}, ${next.enabled}, ${network},
			 ${next.interval_hours}, ${next.max_launches},
			 ${next.name_template}, ${next.symbol},
			 ${next.description}, ${next.image_url},
			 ${next.twitter}, ${next.telegram}, ${next.website},
			 ${next.initial_buy_sol}, ${next.initial_buy_slippage_bps},
			 ${next.auto_claim_enabled}, ${next.auto_claim_threshold_sol}, ${next.auto_claim_reinvest_pct},
			 now())
		ON CONFLICT (agent_id, network)
		  DO UPDATE SET
			enabled                  = EXCLUDED.enabled,
			interval_hours           = EXCLUDED.interval_hours,
			max_launches             = EXCLUDED.max_launches,
			name_template            = EXCLUDED.name_template,
			symbol                   = EXCLUDED.symbol,
			description              = EXCLUDED.description,
			image_url                = EXCLUDED.image_url,
			twitter                  = EXCLUDED.twitter,
			telegram                 = EXCLUDED.telegram,
			website                  = EXCLUDED.website,
			initial_buy_sol          = EXCLUDED.initial_buy_sol,
			initial_buy_slippage_bps = EXCLUDED.initial_buy_slippage_bps,
			auto_claim_enabled       = EXCLUDED.auto_claim_enabled,
			auto_claim_threshold_sol = EXCLUDED.auto_claim_threshold_sol,
			auto_claim_reinvest_pct  = EXCLUDED.auto_claim_reinvest_pct,
			next_launch_at           = CASE
				WHEN ${resetNextLaunch} AND EXCLUDED.interval_hours IS NOT NULL
				THEN now() + EXCLUDED.interval_hours * interval '1 hour'
				WHEN ${resetNextLaunch}
				THEN NULL
				ELSE agent_launcher_configs.next_launch_at
			END,
			updated_at               = now()
		RETURNING *
	`;

	return json(res, 200, { ok: true, config });
}

// ── DELETE ───────────────────────────────────────────────────────────────────

async function deleteConfig(req, res, userId) {
	const { searchParams } = new URL(req.url, 'http://localhost');
	const configId = searchParams.get('id');

	if (!configId) return error(res, 400, 'missing_id', 'id is required');
	if (!isUuid(configId)) return error(res, 400, 'invalid_id', 'id must be a uuid');

	// Verify ownership transitively via agent_id
	const [cfg] = await sql`
		SELECT alc.id
		FROM agent_launcher_configs alc
		JOIN agent_identities ai ON ai.id = alc.agent_id
		WHERE alc.id = ${configId}
		  AND ai.user_id = ${userId}
		  AND ai.deleted_at IS NULL
		LIMIT 1
	`;
	if (!cfg) return error(res, 404, 'not_found', 'launcher config not found or not owned by you');

	await sql`DELETE FROM agent_launcher_configs WHERE id = ${configId}`;

	return json(res, 200, { ok: true });
}
