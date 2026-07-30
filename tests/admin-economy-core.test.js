// The /admin/economy verdict has to be trustworthy, because its whole purpose is
// letting an operator skip the hours of manual endpoint-walking that diagnosing
// the 2026-07-30 flatline actually took.
//
// The cases below are the real ones. The hard part is that several distinct
// faults present identically from the outside (a busy activity feed, a healthy
// action count) and have opposite remediations, so the ORDER of the rules is
// itself the thing under test.

import { describe, it, expect } from 'vitest';
import {
	diagnose, chainLinks, totalDeficit, linkState, linkFill,
	fmtSol, fmtUsd, attemptsFor, firstProblem, PAID_KINDS,
} from '../src/admin-economy-core.js';

/** A healthy-looking payload; individual tests break one thing at a time. */
const healthy = () => ({
	stats: { volume_24h: { sol: 0.297, usd: 24.88 }, trades_24h: 500, snipes_24h: 4, tips_24h: { count: 8, sol: 0.027 }, active_wallets_24h: 31 },
	health: {
		config: { enabled: true, treasury_configured: true, pool_target: 14, actions_per_tick: 4 },
		pool_size: 112,
		liveness: { stale: false, minutes_since: 0, actions_1h: 180, actions_24h: 5068 },
		fuel: { caps: { per_run_usd: 5, daily_usd: 150, target_sol: 0.15 }, today_usd: 5, recent: [] },
		window_24h: {
			by_kind: {
				tip: { ok: 8, skipped: 0, error: 0, last_problem: null },
				payment: { ok: 559, skipped: 2, error: 0, last_problem: null },
				trade: { ok: 12, skipped: 1, error: 0, last_problem: null },
				launch: { ok: 1, skipped: 0, error: 0, last_problem: null },
			},
		},
	},
	topup: { master_sol: 0.42, master_operating_sol: 0.15, reserve_sol: 0.02, master_deficit_sol: 0, targets: [], fuel: { reason: 'not_needed', usdcAvailable: 46.24 } },
});

describe('diagnose', () => {
	it('reports healthy when money is moving and the chain is above its floors', () => {
		const v = diagnose(healthy());
		expect(v.level).toBe('good');
		expect(v.title).toMatch(/healthy/i);
		expect(v.detail).toContain('$24.88');
	});

	it('catches the flatline signature: free lanes alive, paid lanes never planned', () => {
		const d = healthy();
		// Exactly what production looked like: reviews and trials still running,
		// every paid lane at zero ATTEMPTS because the governor cut the budget.
		d.health.window_24h.by_kind = {
			review: { ok: 2001, skipped: 0, error: 0 },
			trial: { ok: 309, skipped: 2756, error: 0 },
			tip: { ok: 0, skipped: 0, error: 0 },
			payment: { ok: 0, skipped: 0, error: 0 },
			trade: { ok: 0, skipped: 0, error: 0 },
			launch: { ok: 0, skipped: 0, error: 0 },
		};
		const v = diagnose(d);
		expect(v.level).toBe('bad');
		expect(v.title).toMatch(/never ran/i);
		// It must point at funding, not at the lanes themselves.
		expect(v.detail).toMatch(/treasury|reserve|budget/i);
	});

	it('ranks an unreadable USDC balance above the budget verdict', () => {
		const d = healthy();
		d.topup.fuel = { reason: 'usdc_read_failed', usdcAvailable: 0 };
		d.health.window_24h.by_kind = { tip: { ok: 0, skipped: 0, error: 0 } };
		const v = diagnose(d);
		expect(v.level).toBe('bad');
		expect(v.title).toMatch(/unreadable/i);
		// The operative distinction: do NOT send money to fix an RPC fault.
		expect(v.detail).toMatch(/UNKNOWN, not zero/);
		expect(v.detail).toMatch(/do not send funds/i);
	});

	it('separates a genuinely dry chain from an unreadable one', () => {
		const d = healthy();
		d.topup.master_deficit_sol = 0.9;
		d.topup.fuel = { reason: 'no_spare_usdc', usdcAvailable: 0 };
		const v = diagnose(d);
		expect(v.level).toBe('bad');
		expect(v.title).toMatch(/genuinely dry/i);
		// This is the ONLY verdict that should ask the owner for money.
		expect(v.detail).toMatch(/send funds/i);
	});

	it('treats a spent daily cap as a pause, not a failure', () => {
		const d = healthy();
		d.topup.master_deficit_sol = 0.4;
		d.topup.fuel = { reason: 'daily_cap_reached' };
		const v = diagnose(d);
		expect(v.level).toBe('warn');
		expect(v.title).toMatch(/daily cap/i);
	});

	it('names the individual stalled lanes when others are settling', () => {
		const d = healthy();
		d.health.window_24h.by_kind.trade = { ok: 0, skipped: 9, error: 0, last_problem: 'still short on $THREE after top-up buy' };
		const v = diagnose(d);
		expect(v.level).toBe('warn');
		expect(v.title).toContain('trade');
		expect(v.detail).toContain('still short on $THREE');
	});

	it('puts a stale tick above every downstream reading', () => {
		const d = healthy();
		d.health.liveness = { stale: true, minutes_since: 47 };
		// Even with a broken fuel lane below it, a dead cron wins: nothing else
		// can be trusted while the engine is not running.
		d.topup.fuel = { reason: 'usdc_read_failed' };
		const v = diagnose(d);
		expect(v.level).toBe('bad');
		expect(v.title).toContain('47');
		expect(v.detail).toMatch(/cron|scheduler/i);
	});

	it('distinguishes "switched off" from "broken"', () => {
		const d = healthy();
		d.health.config.enabled = false;
		const v = diagnose(d);
		expect(v.level).toBe('bad');
		expect(v.detail).toMatch(/inert by design|nothing is broken/i);
	});

	it('degrades honestly when health cannot be read', () => {
		const v = diagnose({ stats: null, health: null, topup: null });
		expect(v.level).toBe('warn');
		expect(v.detail).toMatch(/incomplete/i);
	});

	it('reports self-heal in progress rather than alarming on a covered deficit', () => {
		const d = healthy();
		d.topup.master_deficit_sol = 0.3;
		d.topup.fuel = { reason: 'dry_run' };
		const v = diagnose(d);
		expect(v.level).toBe('warn');
		expect(v.title).toMatch(/self-heal/i);
		expect(v.detail).toMatch(/No action needed/i);
	});
});

describe('funding chain', () => {
	it('always leads with the master and ends with the USDC reserve', () => {
		const links = chainLinks(healthy());
		expect(links[0].id).toBe('master');
		expect(links[links.length - 1].id).toBe('usdc');
	});

	it('includes each under-floor engine with its own refill target', () => {
		const d = healthy();
		d.topup.targets = [{ name: 'circulation-treasury', pubkey: 'abc', currentSol: 0.012, refillToSol: 1 }];
		const links = chainLinks(d);
		const engine = links.find((l) => l.label === 'circulation-treasury');
		expect(engine).toBeTruthy();
		expect(engine.floor).toBe(1);
		expect(engine.state).toBe('dry');
	});

	it('shows an unreadable USDC balance as dry rather than as a real zero', () => {
		const d = healthy();
		d.topup.fuel = { reason: 'usdc_read_failed', usdcAvailable: 0 };
		const usdc = chainLinks(d).find((l) => l.id === 'usdc');
		expect(usdc.state).toBe('dry');
		expect(usdc.note).toMatch(/not the same as empty/i);
	});

	it('sums the master shortfall and every engine shortfall', () => {
		const d = healthy();
		d.topup.master_deficit_sol = 0.1;
		d.topup.targets = [
			{ name: 'a', currentSol: 0.2, refillToSol: 1 },
			{ name: 'b', currentSol: 0, refillToSol: 0.5 },
		];
		expect(totalDeficit(d)).toBeCloseTo(0.1 + 0.8 + 0.5, 6);
	});
});

describe('formatters and helpers', () => {
	it('keeps dust legible instead of collapsing it to zero', () => {
		expect(fmtSol(0.000123)).toBe('0.000123');
		expect(fmtSol(0)).toBe('0');
		expect(fmtUsd(0.004)).toBe('<$0.01');
		expect(fmtUsd(24.88)).toBe('$24.88');
	});

	it('grades a balance against its floor', () => {
		expect(linkState(1, 1)).toBe('ok');
		expect(linkState(0.7, 1)).toBe('low');
		expect(linkState(0.2, 1)).toBe('dry');
		expect(linkFill(0.5, 1)).toBe(0.5);
		expect(linkFill(9, 1)).toBe(1);
	});

	it('counts attempts across ok, skipped and error', () => {
		const byKind = { trade: { ok: 1, skipped: 2, error: 3 } };
		expect(attemptsFor(byKind, 'trade')).toBe(6);
		expect(attemptsFor(byKind, 'missing')).toBe(0);
	});

	it('finds the first real problem across the paid lanes', () => {
		const byKind = { tip: { last_problem: null }, trade: { last_problem: 'quote failed' } };
		expect(firstProblem(byKind, PAID_KINDS)).toEqual({ kind: 'trade', problem: 'quote failed' });
		expect(firstProblem({}, PAID_KINDS)).toBeNull();
	});
});
