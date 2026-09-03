/**
 * Copy-trading decision engine — PURE, deterministic, no DB / no network.
 *
 * Given a copier's subscription, the leader's triggering position, and the coin's
 * safety context, it decides whether to generate a copy intent and at what size.
 * This is the money-adjacent core, so it's isolated and exhaustively tested
 * (tests/copy-engine.test.js). Every "skip" carries a machine + human reason so
 * the dashboard can explain exactly why a copy didn't fire.
 *
 * Non-custodial: this never signs or moves funds — it produces an INTENT the
 * copier acts on. Sizing is always clamped to the per-trade cap and the remaining
 * daily budget, so a runaway leader can never drain a copier.
 */

/** Clamp helper. */
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Validate + normalize a subscription's tunables coming from user input.
 * Returns { ok, value, error }. Never throws.
 */
export function normalizeSubscriptionInput(raw = {}) {
	const sizing = ['fixed', 'multiplier', 'pct_balance'].includes(raw.sizing_rule) ? raw.sizing_rule : 'fixed';
	const fixed = n(raw.fixed_sol);
	const mult = n(raw.multiplier);
	const pct = n(raw.pct_balance);
	const cap = n(raw.per_trade_cap_sol);
	const minOrder = n(raw.min_order_sol);
	const daily = n(raw.daily_budget_sol);
	const maxOpen = Math.floor(n(raw.max_open_copies));
	const perfBps = Math.floor(n(raw.perf_fee_bps ?? 1000));

	if (cap <= 0) return { ok: false, error: 'per_trade_cap_sol must be greater than 0' };
	if (minOrder < 0) return { ok: false, error: 'min_order_sol cannot be negative' };
	if (daily <= 0) return { ok: false, error: 'daily_budget_sol must be greater than 0' };
	if (minOrder > cap) return { ok: false, error: 'min_order_sol cannot exceed per_trade_cap_sol' };
	if (sizing === 'fixed' && fixed <= 0) return { ok: false, error: 'fixed_sol must be greater than 0' };
	if (sizing === 'multiplier' && mult <= 0) return { ok: false, error: 'multiplier must be greater than 0' };
	if (sizing === 'pct_balance' && !(pct > 0 && pct <= 100)) return { ok: false, error: 'pct_balance must be between 0 and 100' };
	if (perfBps < 0 || perfBps > 3000) return { ok: false, error: 'perf_fee_bps must be between 0 and 3000' };

	const mcapFloor = raw.mcap_floor_usd == null || raw.mcap_floor_usd === '' ? null : n(raw.mcap_floor_usd);
	const mcapCeil = raw.mcap_ceiling_usd == null || raw.mcap_ceiling_usd === '' ? null : n(raw.mcap_ceiling_usd);
	if (mcapFloor != null && mcapCeil != null && mcapFloor > mcapCeil) {
		return { ok: false, error: 'mcap_floor_usd cannot exceed mcap_ceiling_usd' };
	}

	const minOracleScore = raw.min_oracle_score == null || raw.min_oracle_score === '' ? null : Math.round(n(raw.min_oracle_score));
	if (minOracleScore != null && (minOracleScore < 0 || minOracleScore > 100)) {
		return { ok: false, error: 'min_oracle_score must be between 0 and 100' };
	}

	// Drawdown circuit breaker (null = opted out). Enforced per tick by
	// api/cron/copy-fanout.js against the leader's realized equity curve; see
	// api/_lib/copy-eligibility.js for the definition the percentage is measured on.
	const maxDrawdownPct = raw.max_drawdown_pct == null || raw.max_drawdown_pct === '' ? null : n(raw.max_drawdown_pct);
	if (maxDrawdownPct != null && !(maxDrawdownPct > 0 && maxDrawdownPct <= 100)) {
		return { ok: false, error: 'max_drawdown_pct must be between 0 and 100' };
	}

	// Telegram chat ID: numeric string (positive or negative integer).
	const tgRaw = raw.telegram_chat_id == null ? null : String(raw.telegram_chat_id).trim();
	const telegramChatId = tgRaw === '' || tgRaw === null ? null : tgRaw;
	if (telegramChatId != null && !/^-?[0-9]+$/.test(telegramChatId)) {
		return { ok: false, error: 'telegram_chat_id must be a numeric Telegram chat ID' };
	}

	return {
		ok: true,
		value: {
			sizing_rule: sizing,
			fixed_sol: fixed,
			multiplier: mult,
			pct_balance: pct,
			per_trade_cap_sol: cap,
			min_order_sol: minOrder,
			daily_budget_sol: daily,
			max_open_copies: clamp(maxOpen || 5, 1, 100),
			mcap_floor_usd: mcapFloor,
			mcap_ceiling_usd: mcapCeil,
			copy_sells: raw.copy_sells !== false,
			require_safety_pass: raw.require_safety_pass === true,
			min_oracle_score: minOracleScore,
			max_drawdown_pct: maxDrawdownPct,
			perf_fee_bps: perfBps,
			telegram_chat_id: telegramChatId,
		},
	};
}

/** Raw order size from the sizing rule, before any clamping. */
export function rawOrderSol(sub, { leaderEntrySol = 0, copierBalanceSol = null } = {}) {
	switch (sub.sizing_rule) {
		case 'fixed': return n(sub.fixed_sol);
		case 'multiplier': return n(leaderEntrySol) * n(sub.multiplier);
		case 'pct_balance':
			return copierBalanceSol == null ? NaN : n(copierBalanceSol) * (n(sub.pct_balance) / 100);
		default: return 0;
	}
}

/**
 * Decide a copy for a single (subscription, leader-position, coin) tuple.
 *
 * @param {object} p
 * @param {object} p.subscription   normalized subscription row.
 * @param {object} p.position       triggering agent_sniper_positions row (entry_sol, mint, direction…).
 * @param {object} [p.coin]         coin context: { market_cap_usd, dev_holding_pct, liquidity_usd, honeypot, graduated }.
 * @param {number} [p.copierBalanceSol]  copier's spendable SOL (required only for pct_balance sizing).
 * @param {number} [p.spentTodaySol]     SOL already fanned out for this sub today.
 * @param {number} [p.openCopies]        copier's current pending intents on this sub.
 * @returns {{ action:'copy'|'skip', direction:'buy'|'sell', order_sol?:number, reason?:string, detail?:string }}
 */
export function planCopyOrder({ subscription: sub, position, coin = null, copierBalanceSol = null, spentTodaySol = 0, openCopies = 0 }) {
	const direction = position.direction === 'sell' ? 'sell' : 'buy';

	if (sub.status !== 'active') return skip('subscription_inactive', 'Subscription is not active.');
	if (direction === 'sell' && !sub.copy_sells) return skip('sells_disabled', 'This subscription does not mirror sells.');

	// --- Safety gate (entries only; exits should always be allowed to mirror) ---
	if (direction === 'buy') {
		const safety = evaluateSafety(sub, coin);
		if (!safety.ok) return skip(safety.reason, safety.detail);

		if (openCopies >= sub.max_open_copies) {
			return skip('max_open_copies', `You already have ${openCopies} open copy intents (cap ${sub.max_open_copies}).`);
		}
	}

	// --- Sizing (buys size the order; sells mirror "exit your copy" with no new SOL) ---
	if (direction === 'sell') {
		return { action: 'copy', direction, order_sol: 0, reason: 'mirror_exit' };
	}

	let order = rawOrderSol(sub, { leaderEntrySol: n(position.entry_sol), copierBalanceSol });
	if (!Number.isFinite(order) || order <= 0) {
		return skip('sizing_unavailable', 'Could not size this order (missing balance for % sizing).');
	}

	order = clamp(order, 0, sub.per_trade_cap_sol);

	const remainingDaily = sub.daily_budget_sol - n(spentTodaySol);
	if (remainingDaily <= 0) return skip('daily_budget_spent', 'Daily copy budget is already used up.');
	order = Math.min(order, remainingDaily);

	if (order < sub.min_order_sol) {
		return skip('below_min_order', `Sized order ${order.toFixed(4)} SOL is below your ${sub.min_order_sol} SOL minimum.`);
	}

	return { action: 'copy', direction, order_sol: round6(order), reason: 'sized' };
}

/** Coin safety gate. Conservative: when context is missing, honor require_safety_pass. */
export function evaluateSafety(sub, coin) {
	if (!coin) {
		return sub.require_safety_pass
			? { ok: false, reason: 'safety_unknown', detail: 'Coin safety could not be confirmed and you require a safety pass.' }
			: { ok: true };
	}
	if (coin.honeypot === true) return { ok: false, reason: 'honeypot', detail: 'Coin flagged as a honeypot (sells blocked).' };

	const mcap = n(coin.market_cap_usd);
	if (sub.mcap_floor_usd != null && mcap > 0 && mcap < sub.mcap_floor_usd) {
		return { ok: false, reason: 'below_mcap_floor', detail: `Market cap $${fmt(mcap)} is below your $${fmt(sub.mcap_floor_usd)} floor.` };
	}
	if (sub.mcap_ceiling_usd != null && mcap > sub.mcap_ceiling_usd) {
		return { ok: false, reason: 'above_mcap_ceiling', detail: `Market cap $${fmt(mcap)} is above your $${fmt(sub.mcap_ceiling_usd)} ceiling.` };
	}
	if (coin.dev_holding_pct != null && coin.dev_holding_pct >= 30) {
		return { ok: false, reason: 'dev_heavy', detail: `Dev holds ${n(coin.dev_holding_pct).toFixed(0)}% of supply — dump risk.` };
	}
	if (coin.liquidity_usd != null && coin.liquidity_usd > 0 && coin.liquidity_usd < 1000) {
		return { ok: false, reason: 'low_liquidity', detail: `Liquidity $${fmt(coin.liquidity_usd)} is too thin to copy safely.` };
	}

	// Oracle conviction gate: skip if the score is known and below the threshold.
	if (sub.min_oracle_score != null && coin.oracle_score != null) {
		if (n(coin.oracle_score) < n(sub.min_oracle_score)) {
			return { ok: false, reason: 'below_oracle_threshold', detail: `Oracle conviction ${n(coin.oracle_score)} is below your minimum ${n(sub.min_oracle_score)}.` };
		}
	}

	return { ok: true };
}

function skip(reason, detail) { return { action: 'skip', direction: 'buy', reason, detail }; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function fmt(x) {
	const v = n(x);
	if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
	if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
	return String(Math.round(v));
}
