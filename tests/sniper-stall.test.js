import { describe, it, expect } from 'vitest';
import { diagnoseStall, LAUNCH_MCAP_USD, MIN_WALLET_SOL } from '../api/_lib/sniper-stall.js';

const SOL = (n) => Math.round(n * 1e9);

// A healthy arm: armed, funded, reachable band, and it has actually traded.
const healthy = {
	enabled: true,
	kill_switch: false,
	trigger: 'new_mint',
	decision_mode: 'rules',
	per_trade_lamports: SOL(0.01),
	daily_budget_lamports: SOL(0.05),
	min_market_cap_usd: null,
};

describe('diagnoseStall', () => {
	it('says nothing about an arm that is trading normally', () => {
		expect(diagnoseStall({ strategy: healthy, closed: 6, open: 1, balanceSol: 0.05 })).toBeNull();
	});

	it('reports a disabled arm before anything else', () => {
		const d = diagnoseStall({ strategy: { ...healthy, enabled: false }, balanceSol: 0 });
		expect(d).toMatchObject({ code: 'disabled', blocking: true });
	});

	it('reports an engaged kill switch', () => {
		expect(diagnoseStall({ strategy: { ...healthy, kill_switch: true }, balanceSol: 1 }))
			.toMatchObject({ code: 'kill_switch', blocking: true });
	});

	it('reports a wallet too thin to fund the safety simulation', () => {
		const d = diagnoseStall({ strategy: healthy, balanceSol: MIN_WALLET_SOL - 0.001 });
		expect(d).toMatchObject({ code: 'wallet_dry', blocking: true });
		expect(d.message).toContain((MIN_WALLET_SOL - 0.001).toFixed(4));
	});

	it('leaves a funded wallet alone', () => {
		expect(diagnoseStall({ strategy: healthy, closed: 3, balanceSol: MIN_WALLET_SOL + 0.001 })).toBeNull();
	});

	// The real production shape: three arms with a $5k–$10k floor on a create-event
	// trigger, which fires while the launch is worth ~$2k. Zero trades, ever.
	it('names an unreachable market-cap band on a launch trigger', () => {
		const d = diagnoseStall({
			strategy: { ...healthy, min_market_cap_usd: 10_000 },
			balanceSol: 0.05,
		});
		expect(d).toMatchObject({ code: 'mcap_band_unreachable', blocking: true });
		expect(d.message).toContain('$10,000');
	});

	it('accepts a band at or below the launch price', () => {
		expect(diagnoseStall({ strategy: { ...healthy, min_market_cap_usd: LAUNCH_MCAP_USD }, closed: 2, balanceSol: 0.05 })).toBeNull();
	});

	it('calls a floor above the typical launch price tight, not broken, while it has no fills', () => {
		const d = diagnoseStall({ strategy: { ...healthy, min_market_cap_usd: 4_000 }, closed: 0, balanceSol: 0.05 });
		expect(d).toMatchObject({ code: 'mcap_band_tight', blocking: false });
	});

	it('stops calling a tight band tight once the arm proves it can fill', () => {
		expect(diagnoseStall({ strategy: { ...healthy, min_market_cap_usd: 4_000 }, closed: 3, balanceSol: 0.05 })).toBeNull();
	});

	it('does not fault a band on a trigger that fires after the coin has traded', () => {
		const strategy = { ...healthy, trigger: 'intel_confirmed', min_market_cap_usd: 10_000 };
		expect(diagnoseStall({ strategy, closed: 4, balanceSol: 0.05 })).toBeNull();
	});

	// A strict arm refuses a fallback's judgment by design; when the named model
	// stops answering entirely, that design silently parks the arm.
	it('names a strict-model arm whose model never answers', () => {
		const strategy = { ...healthy, decision_mode: 'llm', llm_strict_model: true, llm_model: 'moonshotai/kimi-k3' };
		const d = diagnoseStall({ strategy, balanceSol: 0.05, verdictCount: 400, namedModelAnswers: 0 });
		expect(d).toMatchObject({ code: 'strict_model_offline', blocking: true });
		expect(d.message).toContain('moonshotai/kimi-k3');
	});

	it('stays quiet when the named model is answering', () => {
		const strategy = { ...healthy, decision_mode: 'llm', llm_strict_model: true, llm_model: 'x-ai/grok-4.3' };
		expect(diagnoseStall({ strategy, closed: 5, balanceSol: 0.05, verdictCount: 400, namedModelAnswers: 12 })).toBeNull();
	});

	it('does not fault a non-strict LLM arm running on the fallback chain', () => {
		const strategy = { ...healthy, decision_mode: 'llm', llm_strict_model: false, llm_model: 'openrouter/auto' };
		expect(diagnoseStall({ strategy, closed: 9, balanceSol: 0.05, verdictCount: 400, namedModelAnswers: 0 })).toBeNull();
	});

	it('flags a size larger than the whole daily budget as non-blocking (entries clamp down)', () => {
		const strategy = { ...healthy, per_trade_lamports: SOL(0.13), daily_budget_lamports: SOL(0.09) };
		const d = diagnoseStall({ strategy, closed: 3, balanceSol: 0.05 });
		expect(d).toMatchObject({ code: 'size_over_budget', blocking: false });
	});

	it('explains an arm with a reachable config and no fills yet', () => {
		expect(diagnoseStall({ strategy: healthy, closed: 0, open: 0, balanceSol: 0.05 }))
			.toMatchObject({ code: 'no_qualifying_launch', blocking: false });
	});
});
