/**
 * Personal Memetic Launcher — the per-user scope of the autonomous launcher.
 *
 *   GET  /api/launcher/me
 *     The caller's own launcher_config (scope='user'), their recent runs, today's
 *     throughput, how many of their agents are launch-ready, and the live cultural
 *     narratives their launcher would ride right now.
 *
 *   POST /api/launcher/me
 *     Upsert the caller's launcher policy (mode, sources, cadence, network, on/off,
 *     preview/live, dev buy, daily SOL cap).
 *     { action: 'preview' } → synthesize ONE sample coin the launcher would mint
 *                             right now (no DB write, on demand — never per poll).
 *     { action: 'funding' } → the caller's launch-ready agents with LIVE on-chain
 *                             SOL balances + the per-launch cost estimate (RPC-
 *                             backed, on demand — never per poll).
 *     { action: 'resume'  } → clear a tripped circuit breaker.
 *
 * SAFETY — why a normal user can run this live without an abuse vector: a user-scope
 * launcher is SELF-FUNDED. Live launches are paid by the user's own agents' custodial
 * wallets (the agent signs its own pump.fun create and pays base cost + dev buy —
 * the exact path /api/pump?action=launch-agent enforces with a 402 preflight). The
 * platform master wallet only ever funds the GLOBAL scope; the engine never routes
 * master SOL to a user launcher. So the blast radius of "live" is exactly the SOL a
 * user chose to deposit into wallets they own, bounded further by their daily cap.
 *
 * Auth: session cookie OR bearer JWT (so a user's agent can drive it too).
 */

import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { rankNarratives } from '../_lib/launcher-trends.js';
import { pickSource } from '../_lib/launcher-sources.js';
import { LAUNCH_BASE_SOL, SELF_FUND_FEE_BUFFER_SOL } from '../_lib/launcher-engine.js';
import { getSolanaAddressBalances } from '../_lib/agent-wallet.js';

const MODES = ['off', 'trend', 'meme', 'random', 'hybrid'];
const KNOWN_SOURCES = ['coin_intel', 'trending', 'x', 'knowyourmeme', 'hackernews', 'reddit', 'wikipedia'];

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

// jsonb columns arrive as arrays or (depending on driver) JSON strings — coerce.
function coerceArr(v) {
	if (Array.isArray(v)) return v;
	if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
	return [];
}

async function ensureUserRow(userId) {
	await sql`
		insert into launcher_config (scope, user_id, enabled, dry_run, mode)
		values ('user', ${userId}, false, true, 'hybrid')
		on conflict (user_id) where scope = 'user' do nothing
	`;
	const [row] = await sql`select * from launcher_config where scope = 'user' and user_id = ${userId} limit 1`;
	return row;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const userId = await resolveUserId(req);
	if (!userId) return error(res, 401, 'unauthorized', 'authentication required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const config = await ensureUserRow(userId);

	if (req.method === 'GET') return getState(res, userId, config);

	const body = (await readJson(req).catch(() => ({}))) || {};
	if (body.action === 'preview') return previewCoin(res, config, body);
	if (body.action === 'funding') return fundingState(res, userId, config);
	if (body.action === 'resume') return resumeBreaker(res, userId);
	return postConfig(res, userId, config, body);
});

// How many of the user's agents the funding readout covers. The rotation is
// LRU-ordered, so the first funded agent launches next regardless of list size.
const FUNDING_AGENT_LIMIT = 12;

async function eligibleAgents(userId) {
	return sql`
		select ai.id, ai.name, ai.meta->>'solana_address' as solana_address
		from agent_identities ai
		where ai.user_id = ${userId} and ai.deleted_at is null
		  and ai.avatar_id is not null and ai.meta->>'solana_address' is not null
		order by ai.created_at asc
		limit ${FUNDING_AGENT_LIMIT}
	`;
}

// Per-launch SOL a live launch needs in the agent wallet: pump.fun base cost
// (rent + fees, mirrored from the launch-agent preflight) + the dev buy + a
// priority-fee buffer.
function perLaunchEstSol(config) {
	return LAUNCH_BASE_SOL + (Number(config?.dev_buy_sol) || 0) + SELF_FUND_FEE_BUFFER_SOL;
}

// { action:'funding' } — live balances for the caller's launch-ready agents.
// RPC-backed, so it is user-initiated only (load + explicit refresh), never
// wired onto the 6s poll.
async function fundingState(res, userId, config) {
	const network = config?.network || 'mainnet';
	const agents = await eligibleAgents(userId);
	const need = perLaunchEstSol(config);
	const rows = await Promise.all(
		agents.map(async (a) => {
			const { sol } = await getSolanaAddressBalances(a.solana_address, network);
			return {
				id: a.id,
				name: a.name,
				address: a.solana_address,
				sol, // null ⇒ RPC read failed; the UI shows "—", never a fake 0
				funded: sol != null && sol >= need,
			};
		}),
	);
	return json(res, 200, {
		ok: true,
		network,
		launch_base_sol: LAUNCH_BASE_SOL,
		per_launch_est_sol: need,
		agents: rows,
	});
}

async function getState(res, userId, config) {
	const network = config?.network || 'mainnet';

	const [recent, stats, queue, eligible] = await Promise.all([
		sql`
			select id, agent_id, kind, trigger_source, trigger_detail, name, symbol, mint, network,
			       sol_spent, status, dry_run, tx_signature, error, created_at
			from launcher_runs
			where scope = 'user' and user_id = ${userId}
			order by created_at desc
			limit 50
		`,
		sql`
			select
				count(*)::int as runs_today,
				count(*) filter (where status = 'dry_run')::int as dry_runs_today,
				count(*) filter (where status in ('launched','confirmed'))::int as launched_today,
				count(*) filter (where status = 'skipped')::int as skipped_today,
				count(*) filter (where status = 'failed')::int as failed_today
			from launcher_runs
			where scope = 'user' and user_id = ${userId} and created_at >= date_trunc('day', now())
		`,
		sql`select count(*)::int as enabled from launcher_queue where scope = 'user' and user_id = ${userId} and enabled = true`,
		// The user's own launch-ready agents: public-or-not, avatar-bearing, walleted.
		sql`
			select count(*)::int as n from agent_identities ai
			where ai.user_id = ${userId} and ai.deleted_at is null
			  and ai.avatar_id is not null and ai.meta->>'solana_address' is not null
		`,
	]);

	const cfgSources = coerceArr(config?.sources);
	const narratives = await rankNarratives({
		network,
		sources: cfgSources.length ? cfgSources : undefined,
		categories: coerceArr(config?.categories),
		limit: 16,
	}).catch(() => null);

	return json(res, 200, {
		config: shapeConfig(config),
		console: recent,
		stats: stats[0] || {},
		queue_enabled: queue[0]?.enabled ?? 0,
		eligible_agents: eligible[0]?.n ?? 0,
		dry_run_locked: false, // live mode shipped — kept so older clients keep their gate logic
		per_launch_est_sol: perLaunchEstSol(config),
		// Fixed per-launch overhead (base cost + fee buffer) so the client can show
		// a live cost hint as the dev-buy input changes, without hardcoding it.
		launch_overhead_sol: LAUNCH_BASE_SOL + SELF_FUND_FEE_BUFFER_SOL,
		narratives: narratives
			? { terms: narratives.terms || [], top: narratives.top || null, providers: narratives.providers || [] }
			: null,
	});
}

// armed = this config will actually move SOL on the next eligible tick.
function shapeConfig(c) {
	if (!c) return null;
	return {
		...c,
		dry_run: c.dry_run !== false,
		dev_buy_sol: Number(c.dev_buy_sol) || 0,
		daily_sol_cap: Number(c.daily_sol_cap) || 0,
		armed: !!c.enabled && c.dry_run === false && !c.paused,
	};
}

// Cadence floor + hourly ceiling for user scope: each enabled user launcher is
// driven by the shared cron and may synthesize a coin (LLM) per tick, so keep the
// per-user load bounded regardless of what the client asks for.
const USER_MIN_CADENCE = 60;
const USER_MAX_PER_HOUR = 60;
// Live-mode spend bounds. The dev buy comes out of the user's own agent wallet on
// every launch; the daily cap bounds total live spend per UTC day. Both are hard
// server-side clamps — a client can't exceed them.
const USER_MAX_DEV_BUY_SOL = 1;
const USER_MAX_DAILY_SOL_CAP = 10;

// Pure validation + normalisation of a config patch. Returns { ok:false, code,
// message } on a bad field, else { ok:true, next } with every value range-clamped.
// dry_run (preview vs live) is user-controllable: live launches are self-funded
// from the user's own agent wallets, never the platform master (see SAFETY above).
// No I/O — unit tested in tests/user-launcher.test.js.
export function validateAndBuildPatch(body, cur) {
	if (body.mode != null && !MODES.includes(body.mode)) {
		return { ok: false, code: 'invalid_mode', message: `mode must be one of ${MODES.join(', ')}` };
	}
	if (body.network != null && !['mainnet', 'devnet'].includes(body.network)) {
		return { ok: false, code: 'invalid_network', message: 'network must be mainnet or devnet' };
	}
	if (body.sources != null && (!Array.isArray(body.sources) || body.sources.some((s) => !KNOWN_SOURCES.includes(s)))) {
		return { ok: false, code: 'invalid_sources', message: `sources must be a subset of ${KNOWN_SOURCES.join(', ')}` };
	}
	if (body.categories != null && !Array.isArray(body.categories)) {
		return { ok: false, code: 'invalid_categories', message: 'categories must be an array' };
	}
	const inRange = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi; };
	if (body.target_cadence_seconds != null && !inRange(body.target_cadence_seconds, USER_MIN_CADENCE, 86_400)) {
		return { ok: false, code: 'invalid_cadence', message: `target_cadence_seconds must be ${USER_MIN_CADENCE}..86400` };
	}
	if (body.max_per_hour != null && !inRange(body.max_per_hour, 0, USER_MAX_PER_HOUR)) {
		return { ok: false, code: 'invalid_max_per_hour', message: `max_per_hour must be 0..${USER_MAX_PER_HOUR}` };
	}
	if (body.dev_buy_sol != null && !inRange(body.dev_buy_sol, 0, USER_MAX_DEV_BUY_SOL)) {
		return { ok: false, code: 'invalid_dev_buy_sol', message: `dev_buy_sol must be 0..${USER_MAX_DEV_BUY_SOL}` };
	}
	if (body.daily_sol_cap != null && !inRange(body.daily_sol_cap, 0, USER_MAX_DAILY_SOL_CAP)) {
		return { ok: false, code: 'invalid_daily_sol_cap', message: `daily_sol_cap must be 0..${USER_MAX_DAILY_SOL_CAP}` };
	}

	const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
	const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
	const next = {
		enabled: has('enabled') ? Boolean(body.enabled) : cur.enabled,
		// Preview (true) vs live (false). Absent from the patch ⇒ keep, defaulting to
		// preview — a launcher only goes live on an explicit dry_run:false.
		dry_run: has('dry_run') ? Boolean(body.dry_run) : cur.dry_run !== false,
		mode: has('mode') ? body.mode : cur.mode,
		sources: has('sources') ? body.sources : coerceArr(cur.sources),
		categories: has('categories') ? body.categories : coerceArr(cur.categories),
		target_cadence_seconds: has('target_cadence_seconds') ? clamp(Math.round(Number(body.target_cadence_seconds)), USER_MIN_CADENCE, 86_400) : cur.target_cadence_seconds,
		max_per_hour: has('max_per_hour') ? clamp(Math.round(Number(body.max_per_hour)), 0, USER_MAX_PER_HOUR) : cur.max_per_hour,
		dev_buy_sol: has('dev_buy_sol') ? clamp(Number(body.dev_buy_sol), 0, USER_MAX_DEV_BUY_SOL) : Number(cur.dev_buy_sol) || 0,
		daily_sol_cap: has('daily_sol_cap') ? clamp(Number(body.daily_sol_cap), 0, USER_MAX_DAILY_SOL_CAP) : Number(cur.daily_sol_cap) || 0,
		network: has('network') ? body.network : cur.network,
	};
	return { ok: true, next };
}

async function postConfig(res, userId, cur, body) {
	const patch = validateAndBuildPatch(body, cur);
	if (!patch.ok) return error(res, 400, patch.code, patch.message);
	const next = patch.next;

	const [row] = await sql`
		update launcher_config set
			enabled = ${next.enabled},
			dry_run = ${next.dry_run},
			mode = ${next.mode},
			sources = ${JSON.stringify(next.sources)}::jsonb,
			categories = ${JSON.stringify(next.categories)}::jsonb,
			target_cadence_seconds = ${next.target_cadence_seconds},
			max_per_hour = ${next.max_per_hour},
			dev_buy_sol = ${next.dev_buy_sol},
			daily_sol_cap = ${next.daily_sol_cap},
			network = ${next.network},
			updated_at = now()
		where scope = 'user' and user_id = ${userId}
		returning *
	`;

	return json(res, 200, { ok: true, config: shapeConfig(row) });
}

// On-demand single-coin synthesis: shows exactly what the launcher would mint next.
// User-initiated only (it can call the LLM), so never wire this onto a poll.
async function previewCoin(res, config, body) {
	const mode = MODES.includes(body.mode) ? body.mode : (config?.mode || 'hybrid');
	const network = config?.network || 'mainnet';
	const coin = await pickSource({
		mode,
		network,
		categories: coerceArr(config?.categories),
		sources: coerceArr(config?.sources).length ? coerceArr(config?.sources) : undefined,
	}).catch(() => null);
	if (!coin) return error(res, 503, 'preview_unavailable', 'could not synthesize a sample coin right now');
	return json(res, 200, {
		ok: true,
		sample: {
			name: coin.name,
			symbol: coin.symbol,
			description: coin.description || '',
			kind: coin.kind,
			trigger_source: coin.trigger_source || null,
			top_narrative: coin.trigger_detail?.top_narrative || null,
		},
	});
}

async function resumeBreaker(res, userId) {
	const [row] = await sql`
		update launcher_config set paused = false, pause_reason = null, updated_at = now()
		where scope = 'user' and user_id = ${userId} returning *
	`;
	return json(res, 200, { ok: true, config: shapeConfig(row) });
}

export { MODES, KNOWN_SOURCES, USER_MAX_DEV_BUY_SOL, USER_MAX_DAILY_SOL_CAP, shapeConfig, perLaunchEstSol };
