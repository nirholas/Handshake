/**
 * Why an armed sniper strategy is not trading.
 *
 * An arm can be `enabled = true`, hold SOL, evaluate every launch that crosses
 * the feed, and still never buy — because one of its own knobs makes an entry
 * arithmetically impossible. That failure is silent by construction: a skipped
 * evaluation writes no position row, so the board shows "0 trades" with no
 * reason, and an arm can sit dead for a week without anything looking broken.
 * Four arms did exactly that.
 *
 * This module names the condition from data the scoreboard already has. Every
 * diagnosis is a fact about the configuration, not a guess: each one is a rule
 * the executor really enforces, evaluated against the same numbers.
 *
 * Pure — no DB, no RPC, no clock. The caller supplies the facts.
 */

// A pump.fun launch is created ON the bonding curve at a fixed starting market
// cap — around $2.1k at current SOL prices, and never more than a few thousand
// dollars before its first buy. A `new_mint` trigger fires at exactly that
// moment, so a floor above this band can never be cleared by that trigger: by
// the time the coin is worth $10k the create event is long gone. Triggers that
// fire on an already-traded coin (intel_confirmed, oracle_crossing,
// graduation_ride) are the ones that can satisfy a band.
export const LAUNCH_MCAP_USD = 5_000;
// What a launch is actually worth at the create event. Sampled live: 40 of 40
// fresh pump.fun mints priced between $0.1k and $5.8k, median $2.1k. A floor
// between this and LAUNCH_MCAP_USD is reachable but rare (about 5% of launches),
// which is worth saying out loud without calling the arm broken.
export const TYPICAL_LAUNCH_MCAP_USD = 2_500;
const LAUNCH_TRIGGERS = new Set(['new_mint']);

// Floor a wallet must hold to open anything: the firewall's round-trip probe
// reserve (~0.006 SOL of ATA rent + fees) plus a minimum entry. Under this the
// arm cannot even prove the coin is sellable, so it never broadcasts.
export const MIN_WALLET_SOL = 0.008;

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * @param {object} o
 * @param {object} o.strategy            agent_sniper_strategies row (snake_case)
 * @param {number} [o.closed]            real closes in the window
 * @param {number} [o.open]              open positions
 * @param {number|null} [o.balanceSol]   live wallet SOL, or null when unread
 * @param {number} [o.verdictCount]      LLM verdicts requested for this arm's model
 * @param {number} [o.namedModelAnswers] of those, how many the NAMED model answered
 * @returns {{ code:string, blocking:boolean, message:string }|null}
 */
export function diagnoseStall({ strategy, closed = 0, open = 0, balanceSol = null, verdictCount = 0, namedModelAnswers = 0 } = {}) {
	const s = strategy || {};
	if (s.enabled !== true) {
		return { code: 'disabled', blocking: true, message: 'This arm is switched off — it evaluates nothing.' };
	}
	if (s.kill_switch === true) {
		return { code: 'kill_switch', blocking: true, message: 'The per-strategy kill switch is engaged, so no entry can broadcast.' };
	}

	if (balanceSol != null && balanceSol < MIN_WALLET_SOL) {
		return {
			code: 'wallet_dry',
			blocking: true,
			message: `Wallet holds ${balanceSol.toFixed(4)} SOL — under the ~${MIN_WALLET_SOL} SOL needed to fund the safety simulation and a minimum entry, so no buy can be attempted.`,
		};
	}

	const minMcap = num(s.min_market_cap_usd);
	if (LAUNCH_TRIGGERS.has(s.trigger || 'new_mint') && minMcap != null && minMcap > LAUNCH_MCAP_USD) {
		return {
			code: 'mcap_band_unreachable',
			blocking: true,
			message: `The ${s.trigger || 'new_mint'} trigger fires at creation, when a launch is worth about $2k — this arm's $${Math.round(minMcap).toLocaleString('en-US')} floor can never be cleared at that moment. An intel_confirmed or oracle_crossing trigger scores a coin after it has traded into the band.`,
		};
	}

	if (LAUNCH_TRIGGERS.has(s.trigger || 'new_mint') && minMcap != null && minMcap > TYPICAL_LAUNCH_MCAP_USD && closed === 0) {
		return {
			code: 'mcap_band_tight',
			blocking: false,
			message: `A launch is worth about $2k at the moment ${s.trigger || 'new_mint'} fires, so this arm's $${Math.round(minMcap).toLocaleString('en-US')} floor only clears the small minority of launches that open unusually high.`,
		};
	}

	if ((s.decision_mode || 'rules') === 'llm' && s.llm_strict_model === true && verdictCount > 0 && namedModelAnswers === 0) {
		return {
			code: 'strict_model_offline',
			blocking: true,
			message: `Strict-model arm: every one of its last ${verdictCount} verdicts came from the failover chain rather than ${s.llm_model || 'the named model'}, and a strict arm refuses to trade on a fallback's judgment. Restore the named model's route to resume.`,
		};
	}

	const perTrade = num(s.per_trade_lamports);
	const dailyBudget = num(s.daily_budget_lamports);
	if (perTrade != null && dailyBudget != null && dailyBudget > 0 && perTrade > dailyBudget) {
		return {
			code: 'size_over_budget',
			blocking: false,
			message: `Configured size (${(perTrade / 1e9).toFixed(4)} SOL) is larger than the whole daily budget (${(dailyBudget / 1e9).toFixed(4)} SOL); entries are clamped down to the day's remainder.`,
		};
	}

	if (closed === 0 && open === 0) {
		return {
			code: 'no_qualifying_launch',
			blocking: false,
			message: 'Config is reachable — nothing has met this arm\'s entry conditions in the window yet.',
		};
	}

	return null;
}
