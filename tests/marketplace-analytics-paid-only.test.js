// /marketplace/analytics accounting : a free trial is not a sale.
//
// The defect this pins: every aggregate in the handler filtered on
// `status IN ('confirmed','trial')`, so a `trial` row (a free grant that never
// paid anything) was counted as a sale AND its `amount`, which is only the list
// price it *would* have cost, was summed into revenue and into the 30-day volume
// chart.
//
// Measured against the live database on 2026-07-30: the public page reported
// 10,454 "total sales" and 6,228,975 $THREE of "volume" while
// `SELECT count(*) FROM skill_purchases WHERE status='confirmed'` was exactly 0.
// Every headline number on a public transparency page was a free trial.
//
// These are public revenue figures, so the predicate is asserted against the
// source rather than trusted to stay correct by hand.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../api/marketplace/analytics.js', import.meta.url)), 'utf8');

// Every aggregate that represents MONEY. Each must be gated on confirmed alone.
const MONEY_AGGREGATES = [
	'total_sales',
	'total_revenue_atomic',
	'total_volume_atomic',
	'unique_buyers',
];

describe('marketplace analytics counts only paid purchases as sales', () => {
	it('gates every money aggregate on confirmed status', () => {
		for (const name of MONEY_AGGREGATES) {
			// Find the expression that produces this column.
			const re = new RegExp(`([^\\n]*?)\\s+AS ${name}`, 'i');
			const m = SRC.match(re);
			expect(m, `no expression found for ${name}`).toBeTruthy();
			expect(m[1], `${name} must filter on confirmed status`).toMatch(/status = 'confirmed'/);
		}
	});

	it('never sums an amount over a set that can contain trials', () => {
		// A bare SUM(amount) is fine when the surrounding query is already
		// restricted to confirmed rows, and a bug when it is not. So judge each
		// sql`` block, not the raw file.
		const blocks = SRC.match(/sql`[\s\S]*?`/g) || [];
		const offenders = blocks.filter((block) => {
			if (!/SUM\(\s*(?:sp\.)?amount\s*\)/.test(block)) return false;
			const filtered = /SUM\(\s*(?:sp\.)?amount\s*\)\s*FILTER \(WHERE (?:sp\.)?status = 'confirmed'\)/.test(block);
			const wholeQueryPaid = /WHERE\s+(?:sp\.)?status = 'confirmed'/.test(block);
			return !filtered && !wholeQueryPaid;
		});
		expect(offenders).toEqual([]);
	});

	it('restricts the 30-day volume chart to confirmed rows', () => {
		const block = SRC.slice(SRC.indexOf('salesVolume'), SRC.indexOf('Platform-wide summary'));
		expect(block).toMatch(/WHERE status = 'confirmed'/);
		expect(block).not.toMatch(/status IN \('confirmed', 'trial'\)/);
	});

	it('reports trials on their own, never folded into a sales number', () => {
		// Trials still have to be visible; they just cannot be revenue.
		expect(SRC).toMatch(/trialFunnel/);
		expect(SRC).toMatch(/totalTrials/);
		for (const stage of ['granted', 'used', 'exhausted', 'converted']) {
			expect(SRC, `funnel is missing the ${stage} stage`).toMatch(new RegExp(`AS ${stage}\\b`));
		}
	});

	it('derives trial usage from the granted count, not from a hardcoded number', () => {
		// `used` means "spent at least one run", which is only knowable by
		// comparing what remains against what the listing granted.
		const funnel = SRC.slice(SRC.indexOf('Trial funnel'), SRC.indexOf('Recent sales feed'));
		expect(funnel).toMatch(/agent_skill_prices/);
		expect(funnel).toMatch(/trial_remaining < asp\.trial_uses/);
	});
});
