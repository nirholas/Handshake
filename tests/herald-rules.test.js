// Unit tests for the @three-ws/herald rules engine (herald-sdk/src/rules.js).
//
// This is the file that decides whether a human gets interrupted, so it is
// tested the way an interrupt budget deserves: every drop reason, every hold
// reason, the wrap-around quiet-hours window, the batch collapse, and the
// sloppy input a real feed hands over.

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_RULES,
	DROP_REASONS,
	HOLD_REASONS,
	clampImportance,
	decide,
	dedupeKeyFor,
	dwellMsFor,
	planBatch,
	pruneSeen,
	resolveRules,
	scoreMessage,
	toMessage,
	withinQuietHours,
} from '../herald-sdk/src/rules.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');

function ctx(over = {}) {
	return {
		rules: resolveRules(over.rules),
		now: NOW,
		hour: 12,
		seen: new Map(),
		recent: [],
		focused: true,
		busy: false,
		muted: false,
		scorers: [],
		...over,
		// `rules` must stay resolved even when the caller passed a partial.
		...(over.rules ? { rules: resolveRules(over.rules) } : {}),
	};
}

const msg = (over = {}) => ({ id: 'm1', text: 'Deploy is green', at: NOW, ...over });

describe('resolveRules', () => {
	it('fills every default and lets a caller override one', () => {
		expect(resolveRules().minImportance).toBe(DEFAULT_RULES.minImportance);
		const r = resolveRules({ minImportance: 90 });
		expect(r.minImportance).toBe(90);
		expect(r.rateWindowMs).toBe(DEFAULT_RULES.rateWindowMs);
	});
});

describe('clampImportance', () => {
	it('clamps to 0-100 and falls back on junk', () => {
		expect(clampImportance(120)).toBe(100);
		expect(clampImportance(-5)).toBe(0);
		expect(clampImportance('72')).toBe(72);
		expect(clampImportance('nope', 33)).toBe(33);
		expect(clampImportance(undefined)).toBe(DEFAULT_RULES.minImportance);
	});
});

describe('scoreMessage', () => {
	it('takes the highest opinion, ignoring abstainers', () => {
		const score = scoreMessage(msg({ importance: 40 }), [
			() => undefined,
			(m) => (m.text.includes('Deploy') ? 85 : undefined),
			() => 10,
		]);
		expect(score).toBe(85);
	});

	it('survives a scorer that throws', () => {
		const score = scoreMessage(msg({ importance: 51 }), [
			() => {
				throw new Error('bad rule');
			},
		]);
		expect(score).toBe(51);
	});
});

describe('dedupeKeyFor', () => {
	it('prefers an explicit key, then the id, then the text', () => {
		expect(dedupeKeyFor({ key: 'k', id: 'i', text: 't' })).toBe('k');
		expect(dedupeKeyFor({ id: 'i', text: 't' })).toBe('i');
		expect(dedupeKeyFor({ text: 't' })).toBe('t');
	});
});

describe('withinQuietHours', () => {
	it('handles a same-day window', () => {
		expect(withinQuietHours(13, [9, 17])).toBe(true);
		expect(withinQuietHours(8, [9, 17])).toBe(false);
		expect(withinQuietHours(17, [9, 17])).toBe(false);
	});

	it('handles a window that wraps past midnight', () => {
		expect(withinQuietHours(23, [22, 7])).toBe(true);
		expect(withinQuietHours(3, [22, 7])).toBe(true);
		expect(withinQuietHours(7, [22, 7])).toBe(false);
		expect(withinQuietHours(12, [22, 7])).toBe(false);
	});

	it('is off when unset or degenerate', () => {
		expect(withinQuietHours(3, null)).toBe(false);
		expect(withinQuietHours(3, [5, 5])).toBe(false);
	});
});

describe('decide', () => {
	it('delivers a fresh, important, unseen message', () => {
		expect(decide(msg({ importance: 80 }), ctx()).action).toBe('deliver');
	});

	it('drops an empty line', () => {
		const v = decide({ text: '   ' }, ctx());
		expect(v).toMatchObject({ action: 'drop', reason: DROP_REASONS.EMPTY });
	});

	it('drops a duplicate inside the dedupe TTL and lets it through after', () => {
		const seen = new Map([['m1', NOW - 1000]]);
		expect(decide(msg({ importance: 80 }), ctx({ seen })).reason).toBe(DROP_REASONS.DUPLICATE);
		const old = new Map([['m1', NOW - DEFAULT_RULES.dedupeTtlMs - 1]]);
		expect(decide(msg({ importance: 80 }), ctx({ seen: old })).action).toBe('deliver');
	});

	it('drops history', () => {
		const stale = msg({ importance: 90, at: NOW - DEFAULT_RULES.freshnessMs - 1 });
		expect(decide(stale, ctx()).reason).toBe(DROP_REASONS.STALE);
	});

	it('treats a message with no timestamp as now, never as history', () => {
		const undated = { id: 'x', text: 'Manual line', importance: 80 };
		expect(decide(undated, ctx()).action).toBe('deliver');
	});

	it('drops anything under the interrupt floor', () => {
		expect(decide(msg({ importance: 10 }), ctx()).reason).toBe(DROP_REASONS.BELOW_FLOOR);
	});

	it('drops everything while muted', () => {
		expect(decide(msg({ importance: 100 }), ctx({ muted: true })).reason).toBe(DROP_REASONS.MUTED);
	});

	it('holds while another delivery is on screen', () => {
		expect(decide(msg({ importance: 80 }), ctx({ busy: true }))).toMatchObject({
			action: 'hold',
			reason: HOLD_REASONS.BUSY,
		});
	});

	it('holds for a background tab, unless focusOnly is off', () => {
		expect(decide(msg({ importance: 80 }), ctx({ focused: false })).reason).toBe(
			HOLD_REASONS.UNFOCUSED,
		);
		expect(
			decide(msg({ importance: 80 }), ctx({ focused: false, rules: { focusOnly: false } })).action,
		).toBe('deliver');
	});

	it('holds once the rate window is full, and only counts what is inside it', () => {
		const full = Array.from({ length: DEFAULT_RULES.maxPerWindow }, (_, i) => NOW - i * 1000);
		expect(decide(msg({ importance: 80 }), ctx({ recent: full })).reason).toBe(
			HOLD_REASONS.RATE_LIMITED,
		);
		const expired = full.map((t) => t - DEFAULT_RULES.rateWindowMs - 1);
		expect(decide(msg({ importance: 80 }), ctx({ recent: expired })).action).toBe('deliver');
	});

	it('holds through quiet hours but lets a true emergency through', () => {
		const night = ctx({ hour: 2, rules: { quietHours: [22, 7] } });
		expect(decide(msg({ importance: 80 }), night).reason).toBe(HOLD_REASONS.QUIET_HOURS);
		expect(decide(msg({ importance: 95 }), night).action).toBe('deliver');
	});

	it('reports the score it judged with, whatever the outcome', () => {
		const v = decide(msg({ importance: 12 }), ctx({ scorers: [() => 99] }));
		expect(v.importance).toBe(99);
		expect(v.action).toBe('deliver');
	});
});

describe('planBatch', () => {
	const many = [
		{ text: 'a', importance: 60, at: 1 },
		{ text: 'b', importance: 95, at: 2 },
		{ text: 'c', importance: 80, at: 3 },
		{ text: 'd', importance: 70, at: 4 },
	];

	it('says the most important few and collapses the rest into one line', () => {
		const plan = planBatch(many, 2);
		expect(plan.deliver.map((m) => m.text)).toEqual(['b', 'c']);
		expect(plan.collapsed).toHaveLength(2);
		expect(plan.summary).toBe('2 more messages waiting');
	});

	it('has no summary when everything fits', () => {
		expect(planBatch(many, 10).summary).toBe(null);
	});

	it('uses the singular for exactly one collapsed message', () => {
		expect(planBatch(many, 3).summary).toBe('1 more message waiting');
	});

	it('never divides by a nonsense batch size', () => {
		expect(planBatch(many, 0).deliver).toHaveLength(1);
	});
});

describe('dwellMsFor', () => {
	it('scales with length and stays inside its bounds', () => {
		expect(dwellMsFor('hi')).toBeGreaterThanOrEqual(4200);
		expect(dwellMsFor('x'.repeat(10_000))).toBe(14_000);
		expect(dwellMsFor('a short line')).toBeLessThan(dwellMsFor('a considerably longer line'));
	});
});

describe('pruneSeen', () => {
	it('forgets expired keys and caps the rest', () => {
		const seen = new Map([
			['old', NOW - 10_000],
			['fresh', NOW],
		]);
		pruneSeen(seen, NOW, 5_000);
		expect([...seen.keys()]).toEqual(['fresh']);

		const big = new Map(Array.from({ length: 10 }, (_, i) => [`k${i}`, NOW]));
		pruneSeen(big, NOW, 60_000, 4);
		expect(big.size).toBe(4);
	});
});

describe('toMessage', () => {
	it('accepts a bare string', () => {
		expect(toMessage('hello')).toMatchObject({ text: 'hello' });
	});

	it('maps the field names real feeds actually use', () => {
		const m = toMessage({
			id: 7,
			body: 'Something happened',
			priority: 88,
			link: '/x',
			created_at: '2026-08-28T12:00:00.000Z',
		});
		expect(m).toMatchObject({ id: '7', text: 'Something happened', importance: 88, url: '/x' });
		expect(m.at).toBe(NOW);
	});

	it('rejects anything with no line in it', () => {
		expect(toMessage(null)).toBe(null);
		expect(toMessage({ id: 'x' })).toBe(null);
	});
});
