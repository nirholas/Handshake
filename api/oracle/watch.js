/**
 * Oracle — agent action loop config ("arm my agent").
 *
 *   GET  /api/oracle/watch?agent_id=<uuid>&network=mainnet   → current config + recent actions
 *   POST /api/oracle/watch  { agent_id, armed, mode, min_score, ... }  → arm/update
 *
 * Arming an agent to act on conviction is an explicit, owner-only opt-in. The
 * agent watches the live conviction stream; when a coin crosses `min_score` (and
 * its narrative is in `categories`, and — if required — at least one proven
 * wallet is in), the loop executes a small buy from the agent's own custodial
 * Solana wallet. `mode` defaults to 'simulate'; real spend is opt-in and capped.
 *
 * Auth: session cookie OR bearer token, scoped to agents the caller owns
 * (agent_identities.user_id).
 */

import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';
import { z } from 'zod';
import { getWatch, upsertWatch, recentActions, actionsSummary } from '../_lib/oracle/store.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const TIERS = new Set(['prime', 'strong', 'lean', 'watch']);
// Smallest per-trade size the loop will ever place. Also the floor the clamp
// below applies, which is why a live arm has to be checked against the raw
// request instead of the clamped result (see the live-arm guard).
const MIN_TRADE_SOL = 0.001;
const CATEGORIES = new Set(['meme', 'tech', 'ai', 'culture', 'community', 'political', 'news', 'animal', 'celebrity', 'utility', 'unknown']);
const numish = z.union([z.string(), z.number()]);

const WATCH_SCHEMA = z.object({
	agent_id: z.string().uuid(),
	network: z.enum(['mainnet', 'devnet']).optional(),
	armed: z.boolean().optional(),
	mode: z.enum(['simulate', 'live']).optional(),
	min_score: numish.optional(),
	min_tier: z.string().optional(),
	categories: z.array(z.string()).optional(),
	per_trade_sol: numish.optional(),
	max_daily_sol: numish.optional(),
	max_open: numish.optional(),
	require_smart_money: z.boolean().optional(),
	size_scaling: z.boolean().optional(),
	telegram_chat_id: z.string().max(64).optional().nullable(),
});

async function resolveUserId(req) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return bearer.userId;
	return null;
}

async function ownsAgent(userId, agentId) {
	const rows = await sql`
		select id from agent_identities
		where id = ${agentId} and user_id = ${userId} and deleted_at is null
		limit 1
	`.catch(() => []);
	return rows.length > 0;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const userId = await resolveUserId(req);
	if (!userId) return error(res, 401, 'unauthorized', 'sign in to arm an agent');

	if (req.method === 'GET') {
		const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
		const agentId = (url.searchParams.get('agent_id') || '').trim();
		const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';
		if (!agentId) return error(res, 400, 'validation_error', 'agent_id is required');
		// A non-uuid can never match agent_identities.id — without this the query
		// below throws `invalid input syntax for type uuid`, the catch swallows it,
		// and the caller is told they do not own an agent that cannot exist.
		if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id must be a uuid');
		if (!(await ownsAgent(userId, agentId))) return error(res, 403, 'forbidden', 'you do not own this agent');

		const [watch, actions, summary] = await Promise.all([
			getWatch(agentId, network),
			recentActions(agentId, network, 50),
			actionsSummary(agentId, network),
		]);
		return json(res, 200, { agent_id: agentId, network, watch: watch || defaultWatch(agentId, network), actions, summary });
	}

	// POST — arm / update.
	const body = await readJson(req).catch(() => null);
	const parsed = WATCH_SCHEMA.safeParse(body);
	if (!parsed.success) return error(res, 400, 'validation_error', 'invalid watch config', { issues: parsed.error.issues });

	const cfg = parsed.data;
	const network = NETWORKS.has(cfg.network) ? cfg.network : 'mainnet';
	if (!(await ownsAgent(userId, cfg.agent_id))) return error(res, 403, 'forbidden', 'you do not own this agent');

	// Normalize + clamp the risk knobs server-side; never trust the client.
	const minScore = clampInt(cfg.min_score, 0, 100, 80);
	const minTier = TIERS.has(cfg.min_tier) ? cfg.min_tier : 'strong';
	const categories = Array.isArray(cfg.categories) ? cfg.categories.filter((c) => CATEGORIES.has(c)).slice(0, 11) : [];
	const perTrade = clampNum(cfg.per_trade_sol, MIN_TRADE_SOL, 5, 0.05);
	const maxDaily = clampNum(cfg.max_daily_sol, perTrade, 50, Math.max(0.5, perTrade * 10));
	const maxOpen = clampInt(cfg.max_open, 1, 50, 5);

	// Arming live commits the agent's own SOL, so a clamp must never round the
	// caller's number UP into a larger real-money commitment than they asked for.
	// `perTrade` floors at MIN_TRADE_SOL and `maxDaily` floors at `perTrade`, so
	// `{armed:true, mode:'live', per_trade_sol:0}` armed a real-spend loop at
	// 0.001 SOL a trade with a 0.5 SOL daily ceiling. The guard that was meant to
	// catch this read the already-clamped value (`perTrade <= 0`) and therefore
	// could never fire. Judge the caller's raw numbers, and only when the request
	// actually puts funds at risk: a simulate run keeps the forgiving clamps.
	if (cfg.armed && cfg.mode === 'live') {
		const rawPerTrade = cfg.per_trade_sol == null ? null : Number(cfg.per_trade_sol);
		if (rawPerTrade != null && !(rawPerTrade >= MIN_TRADE_SOL)) {
			return error(res, 400, 'validation_error', `per_trade_sol must be at least ${MIN_TRADE_SOL} SOL to arm a live agent`);
		}
		const rawDaily = cfg.max_daily_sol == null ? null : Number(cfg.max_daily_sol);
		if (rawDaily != null && !(rawDaily >= perTrade)) {
			return error(res, 400, 'validation_error', 'max_daily_sol must be at least per_trade_sol to arm a live agent');
		}
	}

	// Sanitize telegram_chat_id: allow numeric IDs (positive or negative) and
	// @handle-style strings. Strip anything that looks like a URL or injection.
	const rawTg = (cfg.telegram_chat_id || '').trim();
	const telegramChatId = /^-?\d{1,20}$/.test(rawTg) || /^@[A-Za-z0-9_]{3,32}$/.test(rawTg)
		? rawTg : null;

	const saved = await upsertWatch(cfg.agent_id, userId, network, {
		armed: !!cfg.armed,
		mode: cfg.mode || 'simulate',
		min_score: minScore,
		min_tier: minTier,
		categories,
		per_trade_sol: perTrade,
		max_daily_sol: maxDaily,
		max_open: maxOpen,
		require_smart_money: cfg.require_smart_money !== false,
		size_scaling: !!cfg.size_scaling,
		telegram_chat_id: telegramChatId || null,
	});

	return json(res, 200, { agent_id: cfg.agent_id, network, watch: saved });
});

function defaultWatch(agentId, network) {
	return {
		agent_id: agentId, network, armed: false, mode: 'simulate',
		min_score: 80, min_tier: 'strong', categories: [],
		per_trade_sol: 0.05, max_daily_sol: 0.5, max_open: 5,
		require_smart_money: true, size_scaling: false, telegram_chat_id: null,
	};
}

function clampInt(v, lo, hi, dflt) {
	const n = Math.round(Number(v));
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
function clampNum(v, lo, hi, dflt) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
