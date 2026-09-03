/**
 * Alpha-drip: pure release-planning tests.
 *
 * Money-adjacent and trust-adjacent: a bug here either leaks a leader's signal
 * early or sells a holder a slower seat than the one below them, so every rule
 * the module promises is pinned.
 */

import { describe, it, expect } from 'vitest';
import {
	normalizeDripConfig, planRelease, planReleaseForUsd, dripDisclosure,
	describeSchedule, formatDelay, assessFairness, maxDelaySec, emptyDripConfig, applyCapacityCap, maskUnreleasedIntent,
	MAX_DELAY_SEC, TIER_IDS,
} from '../api/_lib/alpha-drip.js';

const ok = (raw) => {
	const r = normalizeDripConfig(raw);
	expect(r.ok, r.error).toBe(true);
	return r.value;
};

const ladder = {
	enabled: true,
	schedule: [
		{ tier: 'gold', delay_sec: 0 },
		{ tier: 'bronze', delay_sec: 20 },
	],
	public_delay_sec: 60,
};

describe('normalizeDripConfig', () => {
	it('sorts the schedule high tier first', () => {
		const v = ok({ ...ladder, schedule: [{ tier: 'bronze', delay_sec: 20 }, { tier: 'genesis', delay_sec: 0 }] });
		expect(v.schedule.map((e) => e.tier)).toEqual(['genesis', 'bronze']);
	});

	it('defaults an unset cap to null and rounds a set one', () => {
		const v = ok({ ...ladder, schedule: [{ tier: 'gold', delay_sec: 0, max_copy_size_sol: 0.1234567 }] });
		expect(v.schedule[0].max_copy_size_sol).toBe(0.123457);
		const w = ok(ladder);
		expect(w.schedule[0].max_copy_size_sol).toBeNull();
	});

	it('rejects a tier that is not on the $THREE ladder', () => {
		expect(normalizeDripConfig({ ...ladder, schedule: [{ tier: 'platinum', delay_sec: 0 }] }))
			.toMatchObject({ ok: false });
	});

	it('rejects a duplicated tier', () => {
		expect(normalizeDripConfig({ ...ladder, schedule: [{ tier: 'gold', delay_sec: 0 }, { tier: 'gold', delay_sec: 5 }] }))
			.toMatchObject({ ok: false });
	});

	it('rejects a higher tier waiting longer than a lower one', () => {
		const r = normalizeDripConfig({
			enabled: true,
			schedule: [{ tier: 'gold', delay_sec: 30 }, { tier: 'bronze', delay_sec: 5 }],
			public_delay_sec: 60,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/never wait longer/);
	});

	it('rejects a public delay shorter than a paid tier', () => {
		const r = normalizeDripConfig({ enabled: true, schedule: [{ tier: 'bronze', delay_sec: 60 }], public_delay_sec: 10 });
		expect(r.ok).toBe(false);
	});

	it('rejects delays past the ceiling and below zero', () => {
		expect(normalizeDripConfig({ enabled: true, schedule: [{ tier: 'gold', delay_sec: MAX_DELAY_SEC + 1 }] }).ok).toBe(false);
		expect(normalizeDripConfig({ enabled: true, public_delay_sec: -1 }).ok).toBe(false);
	});

	it('refuses to enable a drip that delays nobody', () => {
		expect(normalizeDripConfig({ enabled: true, schedule: [], public_delay_sec: 0 }).ok).toBe(false);
	});

	it('accepts a disabled empty config (the off switch)', () => {
		const v = ok({ enabled: false, schedule: [], public_delay_sec: 0 });
		expect(v.enabled).toBe(false);
	});

	it('trims and caps free text', () => {
		const v = ok({ ...ladder, disclosure: `  ${'x'.repeat(400)}  `, capacity_note: '   ' });
		expect(v.disclosure).toHaveLength(280);
		expect(v.capacity_note).toBeNull();
	});
});

describe('planRelease', () => {
	const cfg = ok(ladder);

	it('gives the top tier the priced instant seat', () => {
		expect(planRelease(cfg, 'genesis')).toMatchObject({ delay_sec: 0, matched_tier: 'gold' });
	});

	it('inherits the nearest lower priced tier', () => {
		expect(planRelease(cfg, 'silver')).toMatchObject({ delay_sec: 20, matched_tier: 'bronze' });
	});

	it('falls through to the public delay below the lowest priced tier', () => {
		expect(planRelease(cfg, 'member')).toMatchObject({ delay_sec: 60, matched_tier: null });
	});

	it('never delays when the leader has the drip off', () => {
		expect(planRelease({ ...cfg, enabled: false }, 'member').delay_sec).toBe(0);
		expect(planRelease(null, 'member').delay_sec).toBe(0);
		expect(planRelease(emptyDripConfig(), 'member').delay_sec).toBe(0);
	});

	it('treats an unknown tier id as the free floor', () => {
		expect(planRelease(cfg, 'nonsense')).toMatchObject({ delay_sec: 60, tier: TIER_IDS[0] });
	});

	it('is monotonic across the whole ladder', () => {
		const delays = TIER_IDS.map((t) => planRelease(cfg, t).delay_sec);
		for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeLessThanOrEqual(delays[i - 1]);
	});

	it('carries the tier capacity cap through', () => {
		const capped = ok({ enabled: true, schedule: [{ tier: 'gold', delay_sec: 0, max_copy_size_sol: 0.25 }], public_delay_sec: 30 });
		expect(planRelease(capped, 'gold').max_copy_size_sol).toBe(0.25);
		expect(planRelease(capped, 'member').max_copy_size_sol).toBeNull();
	});

	it('resolves straight from USD held', () => {
		expect(planReleaseForUsd(cfg, 0).delay_sec).toBe(60);
		expect(planReleaseForUsd(cfg, 10_000).delay_sec).toBe(0);
	});
});

describe('disclosure and copy', () => {
	it('always appends the standing not-your-orderflow sentence', () => {
		const line = dripDisclosure(ok({ ...ladder, disclosure: 'Subscribers first.' }));
		expect(line).toMatch(/^Subscribers first\./);
		expect(line).toMatch(/not privileged access/);
		expect(line).toMatch(/public track record/);
	});

	it('has no disclosure to make when the drip is off', () => {
		expect(dripDisclosure(emptyDripConfig())).toBeNull();
	});

	it('describes the ladder longest wait last', () => {
		expect(describeSchedule(ok(ladder))).toBe('Gold+ instant, Bronze+ after 20s, everyone else after 1m.');
		expect(describeSchedule(emptyDripConfig())).toMatch(/same moment/);
	});

	it('formats delays the one way every surface prints', () => {
		expect(formatDelay(0)).toBe('0s');
		expect(formatDelay(45)).toBe('45s');
		expect(formatDelay(120)).toBe('2m');
		expect(formatDelay(150)).toBe('2m 30s');
	});
});

describe('assessFairness', () => {
	it('flags a slowest tier that outlives the edge', () => {
		const r = assessFairness(ok(ladder), 30);
		expect(r.fair).toBe(false);
		expect(r.warning).toMatch(/release to everyone at once/);
	});

	it('passes when the edge outlives the longest wait', () => {
		expect(assessFairness(ok(ladder), 600)).toMatchObject({ fair: true, warning: null });
	});

	it('cannot judge without a half-life, and says nothing rather than guessing', () => {
		expect(assessFairness(ok(ladder), null).warning).toBeNull();
	});

	it('reports the longest wait anyone serves', () => {
		expect(maxDelaySec(ok(ladder))).toBe(60);
		expect(maxDelaySec(emptyDripConfig())).toBe(0);
	});
});

describe('applyCapacityCap', () => {
	it('leaves an order under the cap alone', () => {
		expect(applyCapacityCap(0.1, 0.5, 0.02)).toEqual({ ok: true, order_sol: 0.1, capped: false });
	});

	it('clamps an order over the cap', () => {
		expect(applyCapacityCap(0.9, 0.25, 0.02)).toEqual({ ok: true, order_sol: 0.25, capped: true });
	});

	it('skips rather than filling below the copier\'s minimum', () => {
		expect(applyCapacityCap(0.9, 0.01, 0.05)).toMatchObject({ ok: false, reason: 'drip_capacity_cap' });
	});

	it('is a no-op with no cap, a zero cap, or a sell mirror', () => {
		expect(applyCapacityCap(0.4, null, 0.02).capped).toBe(false);
		expect(applyCapacityCap(0.4, 0, 0.02).capped).toBe(false);
		expect(applyCapacityCap(0, 0.25, 0.02).capped).toBe(false);
	});
});

describe('maskUnreleasedIntent', () => {
	const now = Date.UTC(2026, 8, 3, 12, 0, 0);
	const row = () => ({
		id: 'e1', status: 'pending', leader_agent_id: 'a1', leader_name: 'Nine',
		direction: 'buy', mint: 'THREEsynthetic1111', symbol: 'TICKER', name: 'Ticker',
		planned_sol: 0.2, leader_entry_sol: 1.5, safety: { market_cap_usd: 40000 },
		quote: { out: 1 }, leader_buy_sig: 'sig', drip_tier: 'member',
		visible_at: new Date(now + 45_000).toISOString(),
	});

	it('hides the coin and the size until the seat is reached', () => {
		const masked = maskUnreleasedIntent(row(), now);
		expect(masked.locked).toBe(true);
		expect(masked.unlocks_in_sec).toBe(45);
		for (const k of ['mint', 'symbol', 'name', 'planned_sol', 'leader_entry_sol', 'safety', 'quote', 'leader_buy_sig']) {
			expect(masked[k]).toBeNull();
		}
	});

	it('still names the leader and the direction, only the trade is held', () => {
		const masked = maskUnreleasedIntent(row(), now);
		expect(masked.leader_name).toBe('Nine');
		expect(masked.direction).toBe('buy');
		expect(masked.drip_tier).toBe('member');
	});

	it('unmasks itself the moment the reveal passes', () => {
		const masked = maskUnreleasedIntent(row(), now + 45_000);
		expect(masked.locked).toBe(false);
		expect(masked.mint).toBe('THREEsynthetic1111');
	});

	it('never masks a row with no drip applied', () => {
		expect(maskUnreleasedIntent({ ...row(), visible_at: null }, now).locked).toBe(false);
	});

	it('never hides history from the copier it belongs to', () => {
		for (const status of ['acted', 'dismissed', 'skipped', 'expired']) {
			expect(maskUnreleasedIntent({ ...row(), status }, now).locked).toBe(false);
		}
	});
});

describe('the suggested-ladder lane', () => {
	it('reads a fenced JSON reply, a bare one, and prose around one', async () => {
		const { parseJsonBlock } = await import('../api/copy/alpha-drip.js');
		const payload = '{"schedule":[{"tier":"gold","delay_sec":0}],"public_delay_sec":45}';
		for (const reply of [payload, '```json\n' + payload + '\n```', 'Here you go:\n' + payload + '\nHope that helps.']) {
			expect(parseJsonBlock(reply)).toEqual({ schedule: [{ tier: 'gold', delay_sec: 0 }], public_delay_sec: 45 });
		}
	});

	it('returns null rather than throwing on a reply with no JSON in it', async () => {
		const { parseJsonBlock } = await import('../api/copy/alpha-drip.js');
		for (const reply of ['', 'I cannot help with that.', '{ not json', null, undefined, 42]) {
			expect(parseJsonBlock(reply)).toBeNull();
		}
	});

	it('holds a suggestion to the same rules as a hand-written ladder', async () => {
		const { parseJsonBlock } = await import('../api/copy/alpha-drip.js');
		// A model that inverts the ladder (a higher tier waiting longer) must be
		// refused, not saved: the normalizer is the only authority on the rules.
		const bad = parseJsonBlock('{"schedule":[{"tier":"gold","delay_sec":60},{"tier":"bronze","delay_sec":5}],"public_delay_sec":90}');
		expect(normalizeDripConfig({ ...bad, enabled: true }).ok).toBe(false);
		// And one that respects them normalizes exactly like a hand-written one.
		const good = parseJsonBlock('```json\n{"schedule":[{"tier":"gold","delay_sec":0},{"tier":"bronze","delay_sec":30}],"public_delay_sec":90}\n```');
		const norm = normalizeDripConfig({ ...good, enabled: true });
		expect(norm.ok).toBe(true);
		expect(describeSchedule(norm.value)).toBe('Gold+ instant, Bronze+ after 30s, everyone else after 1m 30s.');
	});
});
