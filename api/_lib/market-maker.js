// Launch Copilot — autonomous fair-launch market-maker model + service layer.
//
// Single source of truth for the `market_maker_policies` model: presets,
// validation, the HARD anti-manipulation caps, ownership checks, the action
// ledger, and the derived live state. Shared by the API (api/launch/mm.js), the
// launch-time attach (api/pump/[action].js), and the engine worker
// (workers/agent-mm). The engine adds NO new way to move funds — it routes every
// fill through executeAgentTrade, the same firewall + spend-guard + custody path
// a manual trade uses. This module owns the rulebook; the worker owns the timing.
//
// Non-manipulation is a property of the policy, not a hope: a policy that would
// let the MM wash-trade, dominate volume, or round-trip in seconds is REFUSED at
// create time (assertPolicySafe), and the same caps are re-checked in the engine.

import { sql } from './db.js';

export const SOL = 1_000_000_000; // lamports per SOL

// ── anti-manipulation hard caps (the line the MM must never cross) ────────────
// These are enforced in BOTH directions: a create/update request outside them is
// refused with a plain-language reason, and the engine re-clamps at execution.
export const GUARDS = {
	// No two actions — and never a side flip — inside this window. The core
	// anti-wash-trade gate: you cannot buy then sell (or sell then buy) rapidly.
	MIN_ACTION_INTERVAL_SECONDS: 30,
	// A side flip (buy→sell / sell→buy) needs this multiple of the interval on top,
	// so the MM physically cannot round-trip to fake two-sided volume.
	SIDE_FLIP_INTERVAL_MULTIPLE: 2,
	// A single action may never exceed this share of live market volume.
	MAX_VOLUME_PCT_CEILING: 33,
	// Recycling can never be a dump: never sell more than this share of inventory
	// in one action, and a policy can't be configured above it.
	MAX_RECYCLE_PCT: 90,
	// When live volume can't be read, the engine refuses to act on anything larger
	// than this absolute SOL slice — so the MM never paints a no-volume tape.
	NO_VOLUME_FALLBACK_LAMPORTS: 50_000_000, // 0.05 SOL
	// Dust floor — below this an action is skipped (not worth a tx / fee).
	MIN_TRADE_LAMPORTS: 2_000_000, // 0.002 SOL
	// Default rolling window over which "live volume" is measured for the cap.
	VOLUME_WINDOW_SECONDS: 300,
};

// Plain-language preset rulebooks. The UI offers these; "custom" keeps whatever
// the owner set. Floor price is always supplied at attach time (it's coin-
// specific), so presets only carry the behavioral shape.
export const PRESETS = {
	gentle: {
		label: 'Gentle floor defense',
		description:
			'Quietly defends a tight floor and only trims into strong rallies. Small, infrequent, conservative.',
		floor_band_pct: 3,
		take_profit_band_pct: 40,
		recycle_pct: 12,
		slippage_bps: 300,
		max_price_impact_pct: 5,
		min_action_interval_seconds: 120,
		max_volume_pct: 8,
		graduation_action: 'hold',
	},
	balanced: {
		label: 'Balanced market-maker',
		description:
			'Two-sided support: defends the floor and recycles measured profit into rallies. The default.',
		floor_band_pct: 5,
		take_profit_band_pct: 25,
		recycle_pct: 20,
		slippage_bps: 500,
		max_price_impact_pct: 8,
		min_action_interval_seconds: 60,
		max_volume_pct: 15,
		graduation_action: 'provide_lp',
	},
	aggressive: {
		label: 'Aggressive recycle',
		description:
			'Defends a wider band and recycles harder into spikes to keep liquidity turning. Still volume-capped.',
		floor_band_pct: 8,
		take_profit_band_pct: 15,
		recycle_pct: 35,
		slippage_bps: 800,
		max_price_impact_pct: 12,
		min_action_interval_seconds: 45,
		max_volume_pct: 25,
		graduation_action: 'provide_lp',
	},
};

export const GRADUATION_ACTIONS = ['provide_lp', 'hold', 'distribute'];

/** A requested policy that would cross the anti-manipulation line. */
export class PolicyError extends Error {
	constructor(code, message, detail = {}) {
		super(message);
		this.name = 'PolicyError';
		this.code = code;
		this.detail = detail;
		this.status = code === 'manipulation_guard' ? 422 : 400;
	}
}

// ── coercion helpers (Neon returns numeric/bigint columns as strings) ─────────
function num(v, def = null) {
	if (v == null || v === '') return def;
	const n = Number(v);
	return Number.isFinite(n) ? n : def;
}
function bigintStr(v, def = 0n) {
	try {
		if (v == null || v === '') return def;
		return BigInt(typeof v === 'number' ? Math.round(v) : String(v).split('.')[0]);
	} catch {
		return def;
	}
}
function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n));
}

/**
 * Normalize + validate a create/update patch into the column shape. Throws a
 * PolicyError on anything malformed or outside the anti-manipulation caps. Only
 * keys present in `raw` are returned (so an update touches just those columns),
 * EXCEPT when `withPreset` seeds a full behavioral shape.
 *
 * @param {object} raw         caller-supplied fields (snake or camel tolerated)
 * @param {object} [opts]
 * @param {boolean} [opts.isCreate]  require floor price + full shape
 * @returns {object} validated column patch
 */
export function normalizePolicyPatch(raw = {}, { isCreate = false } = {}) {
	const get = (...keys) => {
		for (const k of keys) if (raw[k] != null) return raw[k];
		return undefined;
	};
	const patch = {};

	// Preset seeds the behavioral shape first; explicit fields then override it.
	const preset = get('preset');
	if (preset != null) {
		if (!['gentle', 'balanced', 'aggressive', 'custom'].includes(preset)) {
			throw new PolicyError('invalid_preset', 'preset must be gentle, balanced, aggressive, or custom');
		}
		patch.preset = preset;
		if (preset !== 'custom') Object.assign(patch, PRESETS[preset]);
	}

	const mode = get('mode');
	if (mode != null) {
		if (mode !== 'simulate' && mode !== 'live') throw new PolicyError('invalid_mode', 'mode must be simulate or live');
		patch.mode = mode;
	}

	const floor = get('floor_price_sol', 'floorPriceSol');
	if (floor != null) {
		const f = num(floor);
		if (f == null || f < 0) throw new PolicyError('invalid_floor', 'floor_price_sol must be a non-negative number (SOL per token)');
		patch.floor_price_sol = f;
	} else if (isCreate) {
		throw new PolicyError('missing_floor', 'floor_price_sol is required (the SOL-per-token price to defend)');
	}

	const numField = (keys, col, { min, max, label }) => {
		const v = get(...keys);
		if (v == null) return;
		const n = num(v);
		if (n == null || n < min || n > max) {
			throw new PolicyError(`invalid_${col}`, `${label} must be between ${min} and ${max}`);
		}
		patch[col] = n;
	};

	numField(['floor_band_pct', 'floorBandPct'], 'floor_band_pct', { min: 0, max: 90, label: 'floor band %' });
	numField(['take_profit_band_pct', 'takeProfitBandPct'], 'take_profit_band_pct', { min: 0, max: 10_000, label: 'take-profit band %' });
	numField(['recycle_pct', 'recyclePct'], 'recycle_pct', { min: 0.1, max: GUARDS.MAX_RECYCLE_PCT, label: 'recycle %' });
	numField(['max_inventory_tokens', 'maxInventoryTokens'], 'max_inventory_tokens', { min: 0, max: 1_000_000_000, label: 'max inventory (tokens)' });
	numField(['slippage_bps', 'slippageBps'], 'slippage_bps', { min: 0, max: 5_000, label: 'slippage (bps)' });
	numField(['max_price_impact_pct', 'maxPriceImpactPct'], 'max_price_impact_pct', { min: 0, max: 100, label: 'max price impact %' });

	// SOL budgets supplied in SOL → store lamports.
	const lamportsField = (keys, col, { maxSol, label }) => {
		const v = get(...keys);
		if (v == null) return;
		const sol = num(v);
		if (sol == null || sol < 0 || sol > maxSol) throw new PolicyError(`invalid_${col}`, `${label} must be between 0 and ${maxSol} SOL`);
		patch[col] = String(BigInt(Math.round(sol * SOL)));
	};
	lamportsField(['dip_buy_budget_sol', 'dipBuyBudgetSol'], 'dip_buy_budget_lamports', { maxSol: 1_000, label: 'dip-buy budget' });
	lamportsField(['daily_budget_sol', 'dailyBudgetSol'], 'daily_budget_lamports', { maxSol: 1_000, label: 'daily budget' });
	lamportsField(['seed_sol', 'seedSol'], 'seed_lamports', { maxSol: 50, label: 'seed buy' });

	const grad = get('graduation_action', 'graduationAction');
	if (grad != null) {
		if (!GRADUATION_ACTIONS.includes(grad)) throw new PolicyError('invalid_graduation_action', `graduation_action must be one of ${GRADUATION_ACTIONS.join(', ')}`);
		patch.graduation_action = grad;
	}

	// Anti-manipulation caps — clamped to the platform ceilings, never beyond.
	const interval = get('min_action_interval_seconds', 'minActionIntervalSeconds');
	if (interval != null) {
		const s = num(interval);
		if (s == null || s < GUARDS.MIN_ACTION_INTERVAL_SECONDS) {
			throw new PolicyError(
				'manipulation_guard',
				`min_action_interval_seconds must be at least ${GUARDS.MIN_ACTION_INTERVAL_SECONDS}s — a faster cadence would allow wash-trading, which the platform does not permit`,
				{ min: GUARDS.MIN_ACTION_INTERVAL_SECONDS },
			);
		}
		patch.min_action_interval_seconds = Math.round(clamp(s, GUARDS.MIN_ACTION_INTERVAL_SECONDS, 86_400));
	}
	const volPct = get('max_volume_pct', 'maxVolumePct');
	if (volPct != null) {
		const v = num(volPct);
		if (v == null || v <= 0) throw new PolicyError('invalid_max_volume_pct', 'max_volume_pct must be a positive number');
		if (v > GUARDS.MAX_VOLUME_PCT_CEILING) {
			throw new PolicyError(
				'manipulation_guard',
				`max_volume_pct cannot exceed ${GUARDS.MAX_VOLUME_PCT_CEILING}% — a market-maker that dominated more of the volume would be painting the tape, which the platform does not permit`,
				{ ceiling: GUARDS.MAX_VOLUME_PCT_CEILING },
			);
		}
		patch.max_volume_pct = v;
	}

	const enabled = get('enabled');
	if (enabled != null) patch.enabled = enabled === true || enabled === 'true';
	const kill = get('kill_switch', 'killSwitch');
	if (kill != null) patch.kill_switch = kill === true || kill === 'true';

	return patch;
}

/**
 * Final safety gate on a fully-resolved policy (post-merge). Throws PolicyError
 * if any combination would cross the anti-manipulation line. Called before a
 * policy is enabled — refusing rather than silently neutering, with a reason the
 * UI surfaces verbatim.
 */
export function assertPolicySafe(policy) {
	const interval = num(policy.min_action_interval_seconds);
	if (interval == null || interval < GUARDS.MIN_ACTION_INTERVAL_SECONDS) {
		throw new PolicyError('manipulation_guard', `Action interval must be at least ${GUARDS.MIN_ACTION_INTERVAL_SECONDS}s to prevent wash-trading.`);
	}
	const volPct = num(policy.max_volume_pct);
	if (volPct == null || volPct <= 0 || volPct > GUARDS.MAX_VOLUME_PCT_CEILING) {
		throw new PolicyError('manipulation_guard', `Max volume share must be between 0 and ${GUARDS.MAX_VOLUME_PCT_CEILING}% so the maker can't dominate the tape.`);
	}
	const recycle = num(policy.recycle_pct);
	if (recycle == null || recycle <= 0 || recycle > GUARDS.MAX_RECYCLE_PCT) {
		throw new PolicyError('manipulation_guard', `Recycle share must be between 0 and ${GUARDS.MAX_RECYCLE_PCT}% — recycling is measured profit-taking, not a dump.`);
	}
	if (num(policy.floor_price_sol) == null || num(policy.floor_price_sol) < 0) {
		throw new PolicyError('invalid_floor', 'A valid floor price is required to enable the market-maker.');
	}
	// Enabling LIVE requires a real spend budget — otherwise it's a no-op that
	// looks armed. Refuse the misleading state.
	if (policy.enabled && policy.mode === 'live') {
		const dip = bigintStr(policy.dip_buy_budget_lamports);
		const daily = bigintStr(policy.daily_budget_lamports);
		const seed = bigintStr(policy.seed_lamports);
		if (dip <= 0n && daily <= 0n && seed <= 0n) {
			throw new PolicyError('no_budget', 'Set a dip-buy, daily, or seed budget before enabling live — a live maker with no budget can never act.');
		}
	}
	return true;
}

// ── ownership ─────────────────────────────────────────────────────────────────

/**
 * Resolve the launched coin the owner controls. The MM can only be attached to a
 * coin launched THROUGH three.ws (a row in pump_agent_mints) by its owner — the
 * agent that owns it also owns the wallet the MM trades from. Returns the mint
 * row { agent_id, user_id, name, symbol } or null.
 */
export async function resolveOwnedLaunch({ userId, mint, network }) {
	const [row] = await sql`
		SELECT agent_id, user_id, name, symbol, network
		FROM pump_agent_mints
		WHERE mint = ${mint} AND network = ${network} AND user_id = ${userId}
		LIMIT 1
	`;
	return row || null;
}

// ── policy reads ──────────────────────────────────────────────────────────────

export async function getPolicyByMint(mint, network) {
	const [row] = await sql`SELECT * FROM market_maker_policies WHERE mint = ${mint} AND network = ${network} LIMIT 1`;
	return row || null;
}
export async function getPolicyById(id) {
	const [row] = await sql`SELECT * FROM market_maker_policies WHERE id = ${id} LIMIT 1`;
	return row || null;
}
export async function listOwnerPolicies(userId, { limit = 100 } = {}) {
	return sql`
		SELECT * FROM market_maker_policies
		WHERE user_id = ${userId}
		ORDER BY created_at DESC
		LIMIT ${Math.min(limit, 200)}
	`;
}

/** Active policies on a network for the engine worker (enabled, not killed). */
export async function getActivePolicies(network, limit = 500) {
	return sql`
		SELECT * FROM market_maker_policies
		WHERE network = ${network} AND enabled = true AND kill_switch = false
		  AND status NOT IN ('killed')
		ORDER BY last_eval_at ASC NULLS FIRST, created_at ASC
		LIMIT ${limit}
	`;
}

// ── create / update ─────────────────────────────────────────────────────────

/**
 * Create or update the (one) policy for a launched coin. Merges the validated
 * patch over the current row (or preset defaults on create), runs the final
 * safety gate, and writes. Returns the persisted row.
 */
export async function upsertPolicy({ mint, network, agentId, userId, patch }) {
	const existing = await getPolicyByMint(mint, network);

	// Resolved view used for the safety gate (merge patch over existing/defaults).
	const base = existing || {
		preset: 'balanced',
		mode: 'simulate',
		...PRESETS.balanced,
		dip_buy_budget_lamports: '0',
		daily_budget_lamports: '0',
		seed_lamports: '0',
		max_inventory_tokens: 0,
		enabled: false,
		kill_switch: false,
	};
	const resolved = { ...base, ...patch };
	if (resolved.enabled) assertPolicySafe(resolved);

	if (!existing) {
		// Create — fill every column from resolved (preset defaults already merged).
		const [row] = await sql`
			INSERT INTO market_maker_policies (
				mint, network, agent_id, user_id, enabled, mode, preset,
				floor_price_sol, floor_band_pct, dip_buy_budget_lamports,
				take_profit_band_pct, recycle_pct, max_inventory_tokens,
				seed_lamports, graduation_action,
				daily_budget_lamports, slippage_bps, max_price_impact_pct,
				min_action_interval_seconds, max_volume_pct, kill_switch, status
			) VALUES (
				${mint}, ${network}, ${agentId}, ${userId},
				${resolved.enabled === true}, ${resolved.mode || 'simulate'}, ${resolved.preset || 'balanced'},
				${num(resolved.floor_price_sol, 0)}, ${num(resolved.floor_band_pct, 5)}, ${String(bigintStr(resolved.dip_buy_budget_lamports))},
				${num(resolved.take_profit_band_pct, 25)}, ${num(resolved.recycle_pct, 20)}, ${num(resolved.max_inventory_tokens, 0)},
				${String(bigintStr(resolved.seed_lamports))}, ${resolved.graduation_action || 'hold'},
				${String(bigintStr(resolved.daily_budget_lamports))}, ${Math.round(num(resolved.slippage_bps, 500))}, ${num(resolved.max_price_impact_pct, 8)},
				${Math.round(num(resolved.min_action_interval_seconds, 60))}, ${num(resolved.max_volume_pct, 15)},
				${resolved.kill_switch === true}, ${resolved.enabled === true ? 'active' : 'idle'}
			)
			RETURNING *
		`;
		return row;
	}

	// Update — only the columns present in patch. Build a dynamic SET safely.
	const cols = [];
	const setEnabledStatus = patch.enabled != null || patch.kill_switch != null;
	const colMap = {
		mode: patch.mode,
		preset: patch.preset,
		floor_price_sol: patch.floor_price_sol != null ? num(patch.floor_price_sol) : undefined,
		floor_band_pct: patch.floor_band_pct,
		dip_buy_budget_lamports: patch.dip_buy_budget_lamports,
		take_profit_band_pct: patch.take_profit_band_pct,
		recycle_pct: patch.recycle_pct,
		max_inventory_tokens: patch.max_inventory_tokens,
		seed_lamports: patch.seed_lamports,
		graduation_action: patch.graduation_action,
		daily_budget_lamports: patch.daily_budget_lamports,
		slippage_bps: patch.slippage_bps,
		max_price_impact_pct: patch.max_price_impact_pct,
		min_action_interval_seconds: patch.min_action_interval_seconds,
		max_volume_pct: patch.max_volume_pct,
		enabled: patch.enabled,
		kill_switch: patch.kill_switch,
	};
	for (const [k, v] of Object.entries(colMap)) if (v !== undefined) cols.push([k, v]);
	if (setEnabledStatus) {
		// Recompute the lifecycle status from the new enabled/kill flags, without
		// clobbering a 'graduated' terminal state.
		const killed = patch.kill_switch === true;
		const enabled = patch.enabled != null ? patch.enabled === true : existing.enabled;
		const nextStatus = killed ? 'killed' : enabled ? (existing.status === 'graduated' ? 'graduated' : 'active') : 'paused';
		cols.push(['status', nextStatus]);
	}
	if (!cols.length) return existing;

	// Neon's tagged template can't take a dynamic column list directly; assemble a
	// parameterized statement with sql.unsafe-free interpolation via a fragment.
	const assignments = cols.map(([k], i) => `${k} = $${i + 1}`).join(', ');
	const values = cols.map(([, v]) => v);
	const [row] = await sql(
		`UPDATE market_maker_policies SET ${assignments}, updated_at = now() WHERE id = $${values.length + 1} RETURNING *`,
		[...values, existing.id],
	);
	return row;
}

// ── action ledger ─────────────────────────────────────────────────────────────

/**
 * Append an action to the transparent ledger. Returns the new row id. Every
 * decision (executed, simulated, skipped, blocked, failed) is recorded — the
 * skips included, so the live feed honestly shows "held, nothing to do".
 */
export async function recordAction(a) {
	const [row] = await sql`
		INSERT INTO market_maker_actions
			(policy_id, mint, network, kind, side, trigger_reason, price_sol,
			 sol_lamports, token_amount, price_impact_pct, venue, signature,
			 custody_event_id, status, detail, meta)
		VALUES (
			${a.policyId}, ${a.mint}, ${a.network}, ${a.kind}, ${a.side ?? null},
			${a.triggerReason ?? null}, ${a.priceSol ?? null},
			${a.solLamports != null ? String(bigintStr(a.solLamports)) : null},
			${a.tokenAmount ?? null}, ${a.priceImpactPct ?? null}, ${a.venue ?? null},
			${a.signature ?? null}, ${a.custodyEventId ?? null}, ${a.status ?? 'executed'},
			${a.detail ?? null}, ${JSON.stringify(a.meta ?? {})}::jsonb
		)
		RETURNING id, created_at
	`;
	return row;
}

export async function listActions(policyId, { limit = 50, sinceId = null, includeSkips = true } = {}) {
	const lim = Math.min(limit, 200);
	if (sinceId != null) {
		return includeSkips
			? sql`SELECT * FROM market_maker_actions WHERE policy_id = ${policyId} AND id > ${sinceId} ORDER BY id ASC LIMIT ${lim}`
			: sql`SELECT * FROM market_maker_actions WHERE policy_id = ${policyId} AND id > ${sinceId} AND kind <> 'skip' ORDER BY id ASC LIMIT ${lim}`;
	}
	return includeSkips
		? sql`SELECT * FROM market_maker_actions WHERE policy_id = ${policyId} ORDER BY id DESC LIMIT ${lim}`
		: sql`SELECT * FROM market_maker_actions WHERE policy_id = ${policyId} AND kind <> 'skip' ORDER BY id DESC LIMIT ${lim}`;
}

// ── rolling spend (24h, from the action ledger) ───────────────────────────────

/** Lamports the MM deployed (seed + defend buys) for a policy in the last 24h. */
export async function getDeployedLamports24h(policyId) {
	const [r] = await sql`
		SELECT COALESCE(SUM(sol_lamports), 0)::numeric AS s
		FROM market_maker_actions
		WHERE policy_id = ${policyId} AND side = 'buy'
		  AND status IN ('executed','simulated')
		  AND created_at > now() - interval '24 hours'
	`;
	return bigintStr(r?.s);
}

/** Lamports the MM spent ONLY on dip-defense in the last 24h (for the dip budget). */
export async function getDefenseLamports24h(policyId) {
	const [r] = await sql`
		SELECT COALESCE(SUM(sol_lamports), 0)::numeric AS s
		FROM market_maker_actions
		WHERE policy_id = ${policyId} AND kind = 'defend_buy'
		  AND status IN ('executed','simulated')
		  AND created_at > now() - interval '24 hours'
	`;
	return bigintStr(r?.s);
}

// ── engine liveness ───────────────────────────────────────────────────────────
// A policy only ever acts when a market-maker worker (workers/agent-mm) is
// sweeping. Without surfacing that, an enabled policy renders as an armed maker
// that will never fire, which reads as a broken promise rather than a stopped
// engine. The worker stamps `bot_heartbeat` every MM_HEARTBEAT_MS (30s default),
// so six missed beats is a confident "not running".

export const ENGINE_WORKER = 'agent-mm';
export const ENGINE_STALE_AFTER_SECONDS = 180;

/** Shape a bot_heartbeat row into the public engine-liveness view. Pure. */
export function engineLivenessFromBeat(row, now = Date.now()) {
	const beatAt = row?.last_beat_at ? new Date(row.last_beat_at).getTime() : NaN;
	if (!Number.isFinite(beatAt)) {
		return { live: false, mode: null, last_beat_at: null, seconds_since_beat: null, stale_after_seconds: ENGINE_STALE_AFTER_SECONDS };
	}
	const seconds = Math.max(0, Math.round((now - beatAt) / 1000));
	return {
		live: seconds <= ENGINE_STALE_AFTER_SECONDS,
		mode: row.mode || null,
		last_beat_at: new Date(beatAt).toISOString(),
		seconds_since_beat: seconds,
		stale_after_seconds: ENGINE_STALE_AFTER_SECONDS,
	};
}

/** Is a market-maker worker actually sweeping right now? */
export async function getEngineLiveness() {
	const [row] = await sql`SELECT mode, last_beat_at FROM bot_heartbeat WHERE worker = ${ENGINE_WORKER} LIMIT 1`;
	return engineLivenessFromBeat(row || null);
}

// ── derived view (for API + UI) ───────────────────────────────────────────────

/** A clean, typed, public-safe view of a policy row + its budgets/PnL. */
export function toPublicPolicy(p) {
	if (!p) return null;
	const lamToSol = (v) => Number(bigintStr(v)) / SOL;
	return {
		id: p.id,
		mint: p.mint,
		network: p.network,
		agent_id: p.agent_id,
		enabled: p.enabled === true,
		mode: p.mode,
		preset: p.preset,
		status: p.status,
		kill_switch: p.kill_switch === true,
		floor_price_sol: num(p.floor_price_sol, 0),
		floor_band_pct: num(p.floor_band_pct, 0),
		take_profit_band_pct: num(p.take_profit_band_pct, 0),
		recycle_pct: num(p.recycle_pct, 0),
		max_inventory_tokens: num(p.max_inventory_tokens, 0),
		graduation_action: p.graduation_action,
		graduation_status: p.graduation_status,
		graduation_signature: p.graduation_signature,
		slippage_bps: num(p.slippage_bps, 0),
		max_price_impact_pct: num(p.max_price_impact_pct, 0),
		min_action_interval_seconds: num(p.min_action_interval_seconds, 0),
		max_volume_pct: num(p.max_volume_pct, 0),
		budgets: {
			dip_buy_sol: lamToSol(p.dip_buy_budget_lamports),
			daily_sol: lamToSol(p.daily_budget_lamports),
			seed_sol: lamToSol(p.seed_lamports),
			seed_done: p.seed_done_at != null,
		},
		realized: {
			pnl_sol: lamToSol(p.realized_pnl_lamports),
			sol_deployed: lamToSol(p.sol_deployed_lamports),
			sol_recovered: lamToSol(p.sol_recovered_lamports),
			inventory_tokens: num(p.inventory_tokens, null),
			inventory_value_sol: p.inventory_value_lamports != null ? lamToSol(p.inventory_value_lamports) : null,
			last_price_sol: num(p.last_price_sol, null),
		},
		last_action_at: p.last_action_at,
		last_action_side: p.last_action_side,
		last_eval_at: p.last_eval_at,
		last_error: p.last_error,
		created_at: p.created_at,
		updated_at: p.updated_at,
		// The disclosed guarantee, surfaced so the UI can show it verbatim.
		disclosure:
			'This market-maker is rules-based and non-manipulative. It cannot wash-trade ' +
			`(no action and no side flip within ${num(p.min_action_interval_seconds, 60)}s), ` +
			`cannot exceed ${num(p.max_volume_pct, 15)}% of live volume in one action, ` +
			'and operates from the agent’s own audited wallet. The owner can pause, kill, or withdraw at any time.',
	};
}

export function toPublicAction(a) {
	if (!a) return null;
	return {
		id: Number(a.id),
		kind: a.kind,
		side: a.side,
		trigger_reason: a.trigger_reason,
		price_sol: num(a.price_sol, null),
		sol: a.sol_lamports != null ? Number(bigintStr(a.sol_lamports)) / SOL : null,
		token_amount: num(a.token_amount, null),
		price_impact_pct: num(a.price_impact_pct, null),
		venue: a.venue,
		signature: a.signature,
		status: a.status,
		detail: a.detail,
		created_at: a.created_at,
	};
}
