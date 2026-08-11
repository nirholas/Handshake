/**
 * Launch Copilot market-maker — policy model + anti-manipulation guard tests.
 *
 * Covers the pure rulebook in api/_lib/market-maker.js: preset normalization,
 * lamports/SOL conversion, the HARD anti-manipulation caps (interval, volume
 * share, recycle), the live-vs-budget safety gate, and the public view shaping.
 * These are the rules that make the maker non-manipulative by construction, so
 * the suite asserts every refusal path explicitly. No DB is touched (the pure
 * functions never call sql).
 */

import { describe, it, expect } from 'vitest';
import {
	GUARDS, PRESETS, PolicyError,
	normalizePolicyPatch, assertPolicySafe, toPublicPolicy, toPublicAction, SOL,
	engineLivenessFromBeat, ENGINE_STALE_AFTER_SECONDS,
} from '../api/_lib/market-maker.js';

describe('normalizePolicyPatch — presets + coercion', () => {
	it('seeds the full behavioral shape from a preset', () => {
		const p = normalizePolicyPatch({ preset: 'balanced', floor_price_sol: 0.0001 }, { isCreate: true });
		expect(p.preset).toBe('balanced');
		expect(p.floor_band_pct).toBe(PRESETS.balanced.floor_band_pct);
		expect(p.recycle_pct).toBe(PRESETS.balanced.recycle_pct);
		expect(p.graduation_action).toBe(PRESETS.balanced.graduation_action);
		expect(p.floor_price_sol).toBe(0.0001);
	});

	it('lets explicit fields override the preset', () => {
		const p = normalizePolicyPatch({ preset: 'gentle', floor_price_sol: 1, recycle_pct: 7 });
		expect(p.recycle_pct).toBe(7);
	});

	it('converts SOL budgets to lamports strings', () => {
		const p = normalizePolicyPatch({ floor_price_sol: 1, dip_buy_budget_sol: 0.5, daily_budget_sol: 2, seed_sol: 0.1 });
		expect(p.dip_buy_budget_lamports).toBe(String(0.5 * SOL));
		expect(p.daily_budget_lamports).toBe(String(2 * SOL));
		expect(p.seed_lamports).toBe(String(0.1 * SOL));
	});

	it('requires a floor price on create', () => {
		expect(() => normalizePolicyPatch({ preset: 'balanced' }, { isCreate: true })).toThrow(PolicyError);
	});

	it('rejects an invalid preset / mode / graduation action', () => {
		expect(() => normalizePolicyPatch({ preset: 'wild', floor_price_sol: 1 })).toThrow(/preset/);
		expect(() => normalizePolicyPatch({ mode: 'turbo', floor_price_sol: 1 })).toThrow(/mode/);
		expect(() => normalizePolicyPatch({ graduation_action: 'rug', floor_price_sol: 1 })).toThrow(/graduation_action/);
	});
});

describe('normalizePolicyPatch — anti-manipulation caps (refused at create)', () => {
	it('refuses a sub-floor action interval (wash-trade prevention)', () => {
		try {
			normalizePolicyPatch({ floor_price_sol: 1, min_action_interval_seconds: GUARDS.MIN_ACTION_INTERVAL_SECONDS - 1 });
			throw new Error('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(PolicyError);
			expect(e.code).toBe('manipulation_guard');
			expect(e.status).toBe(422);
			expect(e.message).toMatch(/wash-trad/i);
		}
	});

	it('refuses a volume share above the ceiling (tape-painting prevention)', () => {
		try {
			normalizePolicyPatch({ floor_price_sol: 1, max_volume_pct: GUARDS.MAX_VOLUME_PCT_CEILING + 5 });
			throw new Error('should have thrown');
		} catch (e) {
			expect(e.code).toBe('manipulation_guard');
			expect(e.message).toMatch(/painting the tape/i);
		}
	});

	it('refuses a recycle share above the dump ceiling', () => {
		expect(() => normalizePolicyPatch({ floor_price_sol: 1, recycle_pct: GUARDS.MAX_RECYCLE_PCT + 1 })).toThrow(/recycle/i);
	});

	it('accepts values exactly at the caps', () => {
		const p = normalizePolicyPatch({
			floor_price_sol: 1,
			min_action_interval_seconds: GUARDS.MIN_ACTION_INTERVAL_SECONDS,
			max_volume_pct: GUARDS.MAX_VOLUME_PCT_CEILING,
			recycle_pct: GUARDS.MAX_RECYCLE_PCT,
		});
		expect(p.min_action_interval_seconds).toBe(GUARDS.MIN_ACTION_INTERVAL_SECONDS);
		expect(p.max_volume_pct).toBe(GUARDS.MAX_VOLUME_PCT_CEILING);
	});
});

describe('assertPolicySafe — final gate before enabling', () => {
	const base = {
		floor_price_sol: 0.0001,
		min_action_interval_seconds: 60,
		max_volume_pct: 15,
		recycle_pct: 20,
		enabled: true,
		mode: 'simulate',
		dip_buy_budget_lamports: '0',
		daily_budget_lamports: '0',
		seed_lamports: '0',
	};

	it('passes a sane simulate policy with no budget', () => {
		expect(assertPolicySafe({ ...base })).toBe(true);
	});

	it('refuses enabling LIVE with no budget (misleading no-op)', () => {
		expect(() => assertPolicySafe({ ...base, mode: 'live' })).toThrow(/budget/i);
	});

	it('allows LIVE once any budget is set', () => {
		expect(assertPolicySafe({ ...base, mode: 'live', daily_budget_lamports: String(SOL) })).toBe(true);
	});

	it('refuses a sub-floor interval / over-ceiling volume even post-merge', () => {
		expect(() => assertPolicySafe({ ...base, min_action_interval_seconds: 5 })).toThrow(/wash/i);
		expect(() => assertPolicySafe({ ...base, max_volume_pct: 80 })).toThrow(/tape/i);
	});
});

describe('toPublicPolicy / toPublicAction', () => {
	it('shapes a row into SOL-denominated budgets + a disclosure', () => {
		const pub = toPublicPolicy({
			id: 'p1', mint: 'M', network: 'mainnet', agent_id: 'a1', enabled: true, mode: 'live',
			preset: 'balanced', status: 'active', kill_switch: false,
			floor_price_sol: '0.0001', floor_band_pct: '5', take_profit_band_pct: '25', recycle_pct: '20',
			max_inventory_tokens: '0', graduation_action: 'provide_lp', slippage_bps: '500', max_price_impact_pct: '8',
			min_action_interval_seconds: 60, max_volume_pct: '15',
			dip_buy_budget_lamports: String(SOL / 2), daily_budget_lamports: String(2 * SOL), seed_lamports: '0',
			realized_pnl_lamports: String(SOL), sol_deployed_lamports: String(3 * SOL), sol_recovered_lamports: String(4 * SOL),
			inventory_tokens: '100', inventory_value_lamports: String(SOL), last_price_sol: '0.0002',
		});
		expect(pub.budgets.dip_buy_sol).toBeCloseTo(0.5, 6);
		expect(pub.budgets.daily_sol).toBeCloseTo(2, 6);
		expect(pub.realized.pnl_sol).toBeCloseTo(1, 6);
		expect(pub.disclosure).toMatch(/non-manipulative|wash-trade/i);
		expect(pub.disclosure).toContain('60s');
	});

	it('shapes an action row with lamports → SOL', () => {
		const a = toPublicAction({ id: '7', kind: 'defend_buy', side: 'buy', sol_lamports: String(SOL / 10), price_sol: '0.0001', status: 'executed', created_at: '2026-06-23T00:00:00Z' });
		expect(a.id).toBe(7);
		expect(a.sol).toBeCloseTo(0.1, 6);
		expect(a.kind).toBe('defend_buy');
	});
});

describe('engineLivenessFromBeat: is a worker actually sweeping?', () => {
	const NOW = Date.parse('2026-06-23T12:00:00Z');

	it('reports a fresh heartbeat as live', () => {
		const e = engineLivenessFromBeat({ mode: 'simulate', last_beat_at: '2026-06-23T11:59:30Z' }, NOW);
		expect(e.live).toBe(true);
		expect(e.mode).toBe('simulate');
		expect(e.seconds_since_beat).toBe(30);
		expect(e.stale_after_seconds).toBe(ENGINE_STALE_AFTER_SECONDS);
	});

	it('reports a stale heartbeat as down (six missed beats)', () => {
		const e = engineLivenessFromBeat({ mode: 'live', last_beat_at: '2026-06-23T11:50:00Z' }, NOW);
		expect(e.live).toBe(false);
		expect(e.seconds_since_beat).toBe(600);
		expect(e.last_beat_at).toBe('2026-06-23T11:50:00.000Z');
	});

	it('treats a missing or unreadable heartbeat as down, never as live', () => {
		for (const row of [null, undefined, {}, { last_beat_at: null }, { last_beat_at: 'not-a-date' }]) {
			const e = engineLivenessFromBeat(row, NOW);
			expect(e.live).toBe(false);
			expect(e.last_beat_at).toBeNull();
			expect(e.seconds_since_beat).toBeNull();
		}
	});

	it('holds the boundary exactly at the stale window', () => {
		const at = new Date(NOW - ENGINE_STALE_AFTER_SECONDS * 1000).toISOString();
		const past = new Date(NOW - (ENGINE_STALE_AFTER_SECONDS + 1) * 1000).toISOString();
		expect(engineLivenessFromBeat({ last_beat_at: at }, NOW).live).toBe(true);
		expect(engineLivenessFromBeat({ last_beat_at: past }, NOW).live).toBe(false);
	});
});
