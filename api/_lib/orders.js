/**
 * Programmable Orders Engine — data model, validated condition language, and the
 * owner-facing CRUD layer (trading-frontier/02).
 *
 * This module is the single source of truth for what a valid order IS. The HTTP
 * endpoint (api/agents/orders.js) and the evaluation worker (workers/agent-orders)
 * both import from here so the rules can never drift between "what you can create"
 * and "what fires". Trigger + condition evaluation are exported as PURE functions
 * (no I/O) so they are unit-testable and identical on both sides.
 *
 * Order types:
 *   limit       — fill at a target price/market-cap (buy on a dip, sell on a rise)
 *   stop        — fill when a level is breached (stop-loss sell / breakout buy)
 *   trailing    — fill on a % drawdown from the high-water mark (or run-up from the low)
 *   dca         — recurring buys/sells on a fixed interval, N slices
 *   twap        — slice ONE large order over time to cut price impact, N slices
 *   conditional — fill when a validated signal condition is true
 *
 * No arbitrary code in conditions — only a closed set of real signals + operators.
 */

import { validateSolanaAddress } from './agent-trade-guards.js';
import { sql } from './db.js';

export const ORDER_TYPES = Object.freeze(['limit', 'stop', 'trailing', 'dca', 'twap', 'conditional']);
export const ORDER_SIDES = Object.freeze(['buy', 'sell']);
export const TRIGGER_METRICS = Object.freeze(['price_sol', 'mcap_sol', 'mcap_usd']);

// The closed set of live signals a conditional trigger may reference. Each maps to
// a real, on-chain-or-derived value the worker computes per sweep (see
// workers/agent-orders/market.js). `kind` gates which operators are legal.
export const CONDITION_SIGNALS = Object.freeze({
	price_sol: { kind: 'number', label: 'Price (SOL/token)' },
	mcap_sol: { kind: 'number', label: 'Market cap (SOL)' },
	mcap_usd: { kind: 'number', label: 'Market cap (USD)' },
	price_change_pct: { kind: 'number', label: 'Price change since created (%)' },
	smart_money_score: { kind: 'number', label: 'Smart-money score (0–100)' },
	dev_dump: { kind: 'bool', label: 'Dev has dumped' },
	graduated: { kind: 'bool', label: 'Graduated to AMM' },
});

export const NUMBER_OPS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq', 'ne']);
export const BOOL_OPS = Object.freeze(['is_true', 'is_false']);

const OP_LABEL = {
	gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠', is_true: 'is', is_false: 'is not',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(code, message) {
	return { ok: false, error: code, message };
}

function num(v) {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function posNum(v) {
	const n = num(v);
	return n != null && n > 0 ? n : null;
}

// ── condition language ────────────────────────────────────────────────────────

/**
 * Validate a condition spec. Shape: `{ all: [leaf, …] }` or `{ any: [leaf, …] }`,
 * where each leaf is `{ signal, op, value }`. One level deep — no nested groups,
 * no expressions, no code. Returns { ok, spec } or { ok:false, error, message }.
 */
export function validateCondition(raw) {
	if (!raw || typeof raw !== 'object') return err('invalid_condition', 'a condition object is required');
	const mode = 'all' in raw ? 'all' : 'any' in raw ? 'any' : null;
	if (!mode) return err('invalid_condition', 'condition must have an "all" or "any" array');
	const leaves = raw[mode];
	if (!Array.isArray(leaves) || leaves.length === 0) return err('invalid_condition', `"${mode}" must be a non-empty array`);
	if (leaves.length > 8) return err('invalid_condition', 'a condition may have at most 8 clauses');

	const clean = [];
	for (const leaf of leaves) {
		if (!leaf || typeof leaf !== 'object') return err('invalid_condition', 'each clause must be an object');
		const signal = String(leaf.signal || '');
		const def = CONDITION_SIGNALS[signal];
		if (!def) return err('invalid_condition', `unknown signal "${signal}"`);
		const op = String(leaf.op || '');
		if (def.kind === 'bool') {
			if (!BOOL_OPS.includes(op)) return err('invalid_condition', `"${signal}" needs is_true or is_false`);
			clean.push({ signal, op });
		} else {
			if (!NUMBER_OPS.includes(op)) return err('invalid_condition', `"${signal}" needs one of ${NUMBER_OPS.join(', ')}`);
			const value = num(leaf.value);
			if (value == null) return err('invalid_condition', `"${signal}" ${op} needs a numeric value`);
			clean.push({ signal, op, value });
		}
	}
	return { ok: true, spec: { [mode]: clean } };
}

function compareNumber(op, a, b) {
	switch (op) {
		case 'gt': return a > b;
		case 'gte': return a >= b;
		case 'lt': return a < b;
		case 'lte': return a <= b;
		case 'eq': return a === b;
		case 'ne': return a !== b;
		default: return false;
	}
}

/**
 * Evaluate a (pre-validated) condition spec against a `signals` map of live
 * values. A signal that is null/undefined is treated as INDETERMINATE: it never
 * counts as satisfied and is reported in `missing` so the worker can stay honest
 * about data gaps (it must not fire on absent data). Pure — no I/O.
 *
 * @returns {{ fired: boolean, missing: string[] }}
 */
export function evaluateCondition(spec, signals) {
	const mode = 'all' in spec ? 'all' : 'any';
	const leaves = spec[mode];
	const missing = [];
	const results = leaves.map((leaf) => {
		const def = CONDITION_SIGNALS[leaf.signal];
		const v = signals?.[leaf.signal];
		if (v == null) { missing.push(leaf.signal); return false; }
		if (def.kind === 'bool') return leaf.op === 'is_true' ? v === true : v === false;
		const n = Number(v);
		if (!Number.isFinite(n)) { missing.push(leaf.signal); return false; }
		return compareNumber(leaf.op, n, leaf.value);
	});
	const fired = mode === 'all' ? results.every(Boolean) : results.some(Boolean);
	return { fired, missing };
}

/** Signals a condition spec references — so the worker only fetches what it needs. */
export function conditionSignals(spec) {
	const mode = 'all' in spec ? 'all' : 'any';
	return [...new Set((spec[mode] || []).map((l) => l.signal))];
}

// ── price-trigger logic (limit / stop / trailing) ─────────────────────────────

/**
 * Decide whether a price-driven order fires at the observed metric value, given
 * its tracked peak (for trailing). Pure. Returns true when the order should fire.
 *
 * - limit  buy : fire when value <= target  (patient entry on a dip)
 * - limit  sell: fire when value >= target  (take profit on a rise)
 * - stop   buy : fire when value >= target  (breakout entry)
 * - stop   sell: fire when value <= target  (stop-loss)
 * - trailing buy : fire when value >= trough * (1 + trail_pct/100)
 * - trailing sell: fire when value <= peak   * (1 - trail_pct/100)
 */
export function shouldFirePrice(order, value, peak) {
	if (!Number.isFinite(value)) return false;
	if (order.type === 'limit') {
		const t = Number(order.limit_price);
		return order.side === 'buy' ? value <= t : value >= t;
	}
	if (order.type === 'stop') {
		const t = Number(order.stop_price);
		return order.side === 'buy' ? value >= t : value <= t;
	}
	if (order.type === 'trailing') {
		const p = Number(peak);
		if (!Number.isFinite(p) || p <= 0) return false;
		const tp = Number(order.trail_pct) / 100;
		return order.side === 'sell' ? value <= p * (1 - tp) : value >= p * (1 + tp);
	}
	return false;
}

// ── order normalization / validation ──────────────────────────────────────────

function parseSizing(raw, side) {
	// Buys spend SOL; sells dispose tokens (raw base units) or a % of the holding.
	if (side === 'buy') {
		const size_sol = posNum(raw.size_sol);
		if (!size_sol) return err('invalid_size', 'a positive size_sol (SOL to spend per fill) is required for a buy');
		return { ok: true, sizing: { size_sol, size_tokens: null, sell_pct: null } };
	}
	const sell_pct = num(raw.sell_pct);
	const size_tokens = posNum(raw.size_tokens);
	if (sell_pct != null) {
		if (sell_pct <= 0 || sell_pct > 100) return err('invalid_size', 'sell_pct must be between 0 and 100');
		return { ok: true, sizing: { size_sol: null, size_tokens: null, sell_pct } };
	}
	if (size_tokens) return { ok: true, sizing: { size_sol: null, size_tokens, sell_pct: null } };
	return err('invalid_size', 'a sell needs size_tokens (base units) or sell_pct (0–100)');
}

function parseSchedule(raw, { minInterval, minSlices }) {
	const s = raw && typeof raw === 'object' ? raw : {};
	const interval_seconds = Math.round(num(s.interval_seconds) ?? 0);
	const slices = Math.round(num(s.slices) ?? 0);
	if (!(interval_seconds >= minInterval)) return err('invalid_schedule', `interval_seconds must be at least ${minInterval}`);
	if (!(slices >= minSlices)) return err('invalid_schedule', `slices must be at least ${minSlices}`);
	if (slices > 1000) return err('invalid_schedule', 'slices may be at most 1000');
	return { ok: true, schedule: { interval_seconds, slices, filled_slices: 0 } };
}

function parseExpiry(raw) {
	if (raw == null || raw === '') return null;
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) return undefined; // signals invalid
	return d.toISOString();
}

/**
 * Coerce + validate a raw order body into a clean, bounded order spec ready to
 * persist. Returns { ok, order } or { ok:false, error, message }. Does NOT touch
 * the DB or the chain — it only decides validity + shape.
 */
export function normalizeOrder(raw) {
	if (!raw || typeof raw !== 'object') return err('invalid_order', 'an order object is required');

	const type = String(raw.type || '');
	if (!ORDER_TYPES.includes(type)) return err('invalid_type', `type must be one of ${ORDER_TYPES.join(', ')}`);
	const side = String(raw.side || '');
	if (!ORDER_SIDES.includes(side)) return err('invalid_side', 'side must be "buy" or "sell"');

	const mintCheck = validateSolanaAddress(raw.mint);
	if (!mintCheck.valid) return err('invalid_mint', `mint is not a valid Solana address (${mintCheck.reason})`);

	const slippage_bps = Math.max(1, Math.min(5000, Math.round(num(raw.slippage_bps) ?? 500)));
	const max_price_impact_pct = (() => { const n = num(raw.max_price_impact_pct); return n != null && n > 0 ? Math.min(100, n) : null; })();

	const expires_at = parseExpiry(raw.expires_at);
	if (expires_at === undefined) return err('invalid_expiry', 'expires_at must be a valid date/time');

	const trigger_metric = TRIGGER_METRICS.includes(raw.trigger_metric) ? raw.trigger_metric : 'mcap_usd';

	const out = {
		type, side, mint: mintCheck.base58, symbol: typeof raw.symbol === 'string' ? raw.symbol.slice(0, 32) : null,
		network: raw.network === 'devnet' ? 'devnet' : 'mainnet',
		slippage_bps, max_price_impact_pct, expires_at: expires_at || null,
		trigger_metric,
		limit_price: null, stop_price: null, trail_pct: null,
		schedule: null, condition: null,
		size_sol: null, size_tokens: null, sell_pct: null,
	};

	// sizing (shared by all single-fill types and per-slice for dca; twap derives below)
	if (type !== 'twap') {
		const sz = parseSizing(raw, side);
		if (!sz.ok) return sz;
		Object.assign(out, sz.sizing);
	}

	if (type === 'limit') {
		const v = posNum(raw.limit_price);
		if (!v) return err('invalid_price', 'limit_price must be a positive number');
		out.limit_price = v;
	} else if (type === 'stop') {
		const v = posNum(raw.stop_price);
		if (!v) return err('invalid_price', 'stop_price must be a positive number');
		out.stop_price = v;
	} else if (type === 'trailing') {
		const v = num(raw.trail_pct);
		if (v == null || v <= 0 || v >= 100) return err('invalid_trail', 'trail_pct must be between 0 and 100');
		out.trail_pct = v;
	} else if (type === 'dca') {
		const sch = parseSchedule(raw.schedule, { minInterval: 60, minSlices: 1 });
		if (!sch.ok) return sch;
		out.schedule = sch.schedule;
	} else if (type === 'twap') {
		const sch = parseSchedule(raw.schedule, { minInterval: 30, minSlices: 2 });
		if (!sch.ok) return sch;
		out.schedule = sch.schedule;
		// TWAP slices ONE total order; derive per-slice size from the total.
		if (side === 'buy') {
			const total = posNum(raw.total_sol ?? raw.size_sol);
			if (!total) return err('invalid_size', 'a positive total_sol is required for a TWAP buy');
			out.size_sol = round8(total / sch.schedule.slices);
			out.schedule.total_sol = total;
		} else {
			const pct = num(raw.sell_pct);
			const totalTokens = posNum(raw.total_tokens ?? raw.size_tokens);
			if (pct != null) {
				if (pct <= 0 || pct > 100) return err('invalid_size', 'sell_pct must be between 0 and 100');
				out.sell_pct = round8(pct / sch.schedule.slices);
				out.schedule.total_pct = pct;
			} else if (totalTokens) {
				out.size_tokens = round8(totalTokens / sch.schedule.slices);
				out.schedule.total_tokens = totalTokens;
			} else {
				return err('invalid_size', 'a TWAP sell needs total_tokens (base units) or sell_pct (0–100)');
			}
		}
	} else if (type === 'conditional') {
		const cond = validateCondition(raw.condition);
		if (!cond.ok) return cond;
		out.condition = cond.spec;
	}

	return { ok: true, order: out };
}

function round8(n) {
	return Math.round(n * 1e8) / 1e8;
}

// ── human-readable description ────────────────────────────────────────────────

function metricLabel(metric, value) {
	if (value == null) return '—';
	if (metric === 'mcap_usd') return `$${fmt(value)} mcap`;
	if (metric === 'mcap_sol') return `${fmt(value)} SOL mcap`;
	return `${value} SOL/token`;
}

function fmt(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return String(n);
	if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
	if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
	return String(v);
}

function sizeLabel(o) {
	if (o.side === 'buy') return `${o.size_sol} SOL`;
	if (o.sell_pct != null) return `${o.sell_pct}% of the holding`;
	// size_tokens is raw base units, not whole tokens; label it as what it is so
	// the readback can't be misread as a 1e6x larger sell on a 6-decimal mint.
	return `${o.size_tokens} base units`;
}

/** A plain-language readback of an order — what it does, in one line. */
export function describeOrder(o) {
	const sym = o.symbol ? `$${o.symbol}` : `${String(o.mint).slice(0, 4)}…`;
	const verb = o.side === 'buy' ? 'Buy' : 'Sell';
	switch (o.type) {
		case 'limit':
			return `${verb} ${sizeLabel(o)} of ${sym} when it reaches ${metricLabel(o.trigger_metric, o.limit_price)} (limit ${o.side}).`;
		case 'stop':
			return o.side === 'sell'
				? `Stop-loss: sell ${sizeLabel(o)} of ${sym} if it falls to ${metricLabel(o.trigger_metric, o.stop_price)}.`
				: `Breakout: buy ${sizeLabel(o)} of ${sym} once it breaks ${metricLabel(o.trigger_metric, o.stop_price)}.`;
		case 'trailing':
			return o.side === 'sell'
				? `Trailing stop: sell ${sizeLabel(o)} of ${sym} after a ${o.trail_pct}% drop from its high.`
				: `Trailing entry: buy ${sizeLabel(o)} of ${sym} after a ${o.trail_pct}% bounce from its low.`;
		case 'dca': {
			const every = humanInterval(o.schedule?.interval_seconds);
			return `DCA: ${verb.toLowerCase()} ${sizeLabel(o)} of ${sym} every ${every}, ${o.schedule?.slices}× total.`;
		}
		case 'twap': {
			const every = humanInterval(o.schedule?.interval_seconds);
			const total = o.side === 'buy' ? `${o.schedule?.total_sol} SOL` : (o.schedule?.total_pct != null ? `${o.schedule.total_pct}%` : `${o.schedule?.total_tokens} base units`);
			return `TWAP: ${verb.toLowerCase()} ${total} of ${sym} sliced over ${o.schedule?.slices} fills, one every ${every}.`;
		}
		case 'conditional':
			return `${verb} ${sizeLabel(o)} of ${sym} when ${describeCondition(o.condition)}.`;
		default:
			return `${verb} ${sym}.`;
	}
}

export function describeCondition(spec) {
	if (!spec) return 'a condition is met';
	const mode = 'all' in spec ? 'all' : 'any';
	const join = mode === 'all' ? ' and ' : ' or ';
	return (spec[mode] || []).map((l) => {
		const def = CONDITION_SIGNALS[l.signal];
		if (def?.kind === 'bool') return `${def.label.toLowerCase()} ${l.op === 'is_true' ? 'is true' : 'is false'}`;
		return `${def?.label || l.signal} ${OP_LABEL[l.op] || l.op} ${fmt(l.value)}`;
	}).join(join);
}

function humanInterval(seconds) {
	const s = Number(seconds) || 0;
	if (s % 86400 === 0 && s >= 86400) return `${s / 86400} day${s === 86400 ? '' : 's'}`;
	if (s % 3600 === 0 && s >= 3600) return `${s / 3600} hour${s === 3600 ? '' : 's'}`;
	if (s % 60 === 0 && s >= 60) return `${s / 60} min`;
	return `${s}s`;
}

// ── persistence (CRUD) ────────────────────────────────────────────────────────

/** Shape a DB row for the API: numeric strings → numbers, attach a readback. */
export function shapeOrder(row) {
	if (!row) return null;
	const o = {
		id: row.id, agent_id: row.agent_id, network: row.network, mint: row.mint, symbol: row.symbol,
		type: row.type, side: row.side,
		size_sol: numOrNull(row.size_sol), size_tokens: numOrNull(row.size_tokens), sell_pct: numOrNull(row.sell_pct),
		trigger_metric: row.trigger_metric,
		limit_price: numOrNull(row.limit_price), stop_price: numOrNull(row.stop_price),
		trail_pct: numOrNull(row.trail_pct), peak_price: numOrNull(row.peak_price),
		reference_price: numOrNull(row.reference_price),
		schedule: row.schedule || null, next_fire_at: row.next_fire_at, condition: row.condition || null,
		slippage_bps: row.slippage_bps, max_price_impact_pct: numOrNull(row.max_price_impact_pct),
		expires_at: row.expires_at, status: row.status,
		filled_sol: numOrNull(row.filled_sol) || 0, filled_tokens: numOrNull(row.filled_tokens) || 0,
		fill_count: row.fill_count || 0,
		last_eval_at: row.last_eval_at, last_price: numOrNull(row.last_price), last_error: row.last_error,
		created_at: row.created_at, updated_at: row.updated_at, cancelled_at: row.cancelled_at,
	};
	o.readback = describeOrder(o);
	return o;
}

function numOrNull(v) {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** List an agent's orders (newest first), optionally filtered by status set. */
export async function listOrders(agentId, { network = null, statuses = null, limit = 100 } = {}) {
	const lim = Math.min(200, Math.max(1, Number(limit) || 100));
	const rows = await sql`
		SELECT * FROM orders
		WHERE agent_id = ${agentId}
		  AND (${network}::text IS NULL OR network = ${network})
		  AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}::text[]))
		ORDER BY created_at DESC
		LIMIT ${lim}
	`;
	return rows.map(shapeOrder);
}

/** A single order (owner-scoped). */
export async function getOrder(agentId, orderId) {
	if (!UUID_RE.test(orderId)) return null;
	const [row] = await sql`SELECT * FROM orders WHERE id = ${orderId} AND agent_id = ${agentId}`;
	return shapeOrder(row);
}

/** Recent fills for an order. */
export async function listFills(orderId, { limit = 50 } = {}) {
	const lim = Math.min(200, Math.max(1, Number(limit) || 50));
	const rows = await sql`
		SELECT id, slice_index, side, trigger_reason, trigger_price, sol_amount, token_amount,
		       price_impact_pct, venue, signature, custody_event_id, status, detail, created_at
		FROM order_fills WHERE order_id = ${orderId}
		ORDER BY created_at DESC LIMIT ${lim}
	`;
	return rows.map((r) => ({
		...r,
		trigger_price: numOrNull(r.trigger_price),
		sol_amount: numOrNull(r.sol_amount),
		token_amount: numOrNull(r.token_amount),
		price_impact_pct: numOrNull(r.price_impact_pct),
	}));
}

/**
 * Persist a validated order. `normalized` is the output of normalizeOrder.order.
 * Schedule-driven orders (dca/twap) get next_fire_at = now so the first slice
 * fires on the next sweep. Returns the shaped row.
 */
export async function createOrder(agentId, userId, normalized) {
	const o = normalized;
	const scheduled = o.type === 'dca' || o.type === 'twap';
	const [row] = await sql`
		INSERT INTO orders
			(agent_id, user_id, network, mint, symbol, type, side, size_sol, size_tokens,
			 sell_pct, trigger_metric, limit_price, stop_price, trail_pct, schedule,
			 next_fire_at, condition, slippage_bps, max_price_impact_pct, expires_at, status)
		VALUES (
			${agentId}, ${userId}, ${o.network}, ${o.mint}, ${o.symbol}, ${o.type}, ${o.side},
			${o.size_sol}, ${o.size_tokens}, ${o.sell_pct}, ${o.trigger_metric},
			${o.limit_price}, ${o.stop_price}, ${o.trail_pct},
			${o.schedule ? JSON.stringify(o.schedule) : null}::jsonb,
			${scheduled ? sql`now()` : null},
			${o.condition ? JSON.stringify(o.condition) : null}::jsonb,
			${o.slippage_bps}, ${o.max_price_impact_pct}, ${o.expires_at}, 'active')
		RETURNING *
	`;
	return shapeOrder(row);
}

/**
 * Owner edit: pause/resume (status active↔paused via cancel is separate), or
 * patch trigger params on an order that hasn't filled. Only a bounded set of
 * fields can change; type/side/mint are immutable (delete + recreate instead).
 */
export async function updateOrder(agentId, orderId, patch) {
	const current = await getOrder(agentId, orderId);
	if (!current) return null;
	if (['filled', 'cancelled', 'expired'].includes(current.status)) {
		return { error: 'immutable', message: `a ${current.status} order can’t be edited` };
	}

	const sets = [];
	if ('limit_price' in patch && current.type === 'limit') {
		const v = posNum(patch.limit_price);
		if (!v) return { error: 'invalid_price', message: 'limit_price must be positive' };
		sets.push(sql`limit_price = ${v}`);
	}
	if ('stop_price' in patch && current.type === 'stop') {
		const v = posNum(patch.stop_price);
		if (!v) return { error: 'invalid_price', message: 'stop_price must be positive' };
		sets.push(sql`stop_price = ${v}`);
	}
	if ('trail_pct' in patch && current.type === 'trailing') {
		const v = num(patch.trail_pct);
		if (v == null || v <= 0 || v >= 100) return { error: 'invalid_trail', message: 'trail_pct must be 0–100' };
		sets.push(sql`trail_pct = ${v}`);
	}
	if ('slippage_bps' in patch) {
		sets.push(sql`slippage_bps = ${Math.max(1, Math.min(5000, Math.round(num(patch.slippage_bps) ?? current.slippage_bps)))}`);
	}
	if ('expires_at' in patch) {
		const e = parseExpiry(patch.expires_at);
		if (e === undefined) return { error: 'invalid_expiry', message: 'expires_at must be a valid date/time' };
		sets.push(sql`expires_at = ${e}`);
	}
	if ('paused' in patch) {
		// Pause parks the order in a non-evaluated 'paused' state without losing fill
		// progress; resume returns it to 'partial' (if it has fills) or 'active'.
		if (patch.paused === true) {
			sets.push(sql`status = 'paused'`);
		} else {
			sets.push(sql`status = ${current.fill_count > 0 ? 'partial' : 'active'}`);
		}
	}
	if (!sets.length) return current;

	let setClause = sets[0];
	for (let i = 1; i < sets.length; i++) setClause = sql`${setClause}, ${sets[i]}`;
	const [row] = await sql`
		UPDATE orders SET ${setClause}, updated_at = now()
		WHERE id = ${orderId} AND agent_id = ${agentId}
		RETURNING *
	`;
	return shapeOrder(row);
}

/** Cancel an order instantly. Idempotent; a filled order can't be cancelled. */
export async function cancelOrder(agentId, orderId) {
	const [row] = await sql`
		UPDATE orders SET status = 'cancelled', cancelled_at = now(), updated_at = now()
		WHERE id = ${orderId} AND agent_id = ${agentId}
		  AND status NOT IN ('filled', 'cancelled', 'expired')
		RETURNING *
	`;
	if (row) return shapeOrder(row);
	// Already terminal (or not found) — return current state so cancel is idempotent.
	return getOrder(agentId, orderId);
}

/** Cancel every active/partial order for an agent (kill switch). Returns count. */
export async function cancelAllOrders(agentId, network = null) {
	const rows = await sql`
		UPDATE orders SET status = 'cancelled', cancelled_at = now(), updated_at = now()
		WHERE agent_id = ${agentId}
		  AND (${network}::text IS NULL OR network = ${network})
		  AND status IN ('active', 'partial', 'firing', 'paused')
		RETURNING id
	`;
	return rows.length;
}

/** Owner-facing summary across an agent's orders. */
export async function ordersSummary(agentId, network) {
	const [agg] = await sql`
		SELECT
			COUNT(*)::int AS total,
			COUNT(*) FILTER (WHERE status IN ('active','partial','firing'))::int AS active,
			COUNT(*) FILTER (WHERE status = 'filled')::int AS filled,
			COALESCE(SUM(fill_count), 0)::int AS fills,
			COALESCE(SUM(filled_sol), 0)::float8 AS filled_sol
		FROM orders
		WHERE agent_id = ${agentId} AND (${network}::text IS NULL OR network = ${network})
	`;
	return {
		total: agg?.total || 0,
		active: agg?.active || 0,
		filled: agg?.filled || 0,
		lifetime_fills: agg?.fills || 0,
		lifetime_filled_sol: Number(agg?.filled_sol || 0),
	};
}
