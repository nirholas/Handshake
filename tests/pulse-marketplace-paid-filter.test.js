// /pulse marketplace accounting — the money columns and the party counts must
// agree on what a "sale" is.
//
// The defect this pins: `purchases` filtered on status + kind, while `gmv_atomic`,
// `fee_atomic`, `buyers`, `sellers` and `pairs` filtered on status alone. Any row
// that is 'confirmed' but not a paid kind (a trial, or the access record a bundle
// unlock writes) therefore landed in the published GMV, fee and party counts while
// being excluded from the purchase count. That also skewed `avg_ticket_three`,
// which divides a GMV by a count that excluded part of what produced it.
//
// Measured on the real table, one 1000-unit sale alongside a confirmed bundle row
// and a confirmed trial published GMV 2600 and 3 buyers instead of 1000 and 1.
//
// These are numbers on a public transparency page, so this is asserted against the
// source: every aggregate has to derive from the one shared predicate rather than
// being kept in sync by hand.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../api/pulse.js', import.meta.url)), 'utf8');

describe('pulse marketplace paid-row predicate', () => {
	it('defines a shared predicate that gates on BOTH status and paid kind', () => {
		// Both marketplace aggregate sites build the predicate once.
		const defs = SRC.match(/const paidRow\w*\s*=\s*sql`[^`]+`/g) || [];
		expect(defs.length).toBeGreaterThanOrEqual(2);
		for (const def of defs) {
			expect(def).toMatch(/sp\.status = 'confirmed'/);
			expect(def).toMatch(/sp\.kind = ANY\(\$\{MARKET_PAID_KINDS\}\)/);
		}
	});

	it('never filters an aggregate on confirmed status alone', () => {
		// A bare status filter is exactly the bug: it admits confirmed non-sale rows.
		const bare = SRC.match(/FILTER \(WHERE sp\.status = 'confirmed'\)/g) || [];
		expect(bare).toEqual([]);
	});

	it('routes money and party aggregates through the predicate', () => {
		// The five columns that were wrong, plus the purchase count they must agree with.
		for (const col of ['gmv_atomic', 'fee_atomic', 'buyers', 'sellers', 'pairs']) {
			const line = SRC.split('\n').find((l) => l.includes(`AS ${col}`) && l.includes('FILTER'));
			expect(line, `${col} should be an aggregate filtered by the shared predicate`).toBeTruthy();
			expect(line, `${col} must use the shared paidRow predicate`).toMatch(/\$\{paidRow\w*\}/);
		}
	});

	it('keeps the trial counter deliberately status-free, and says so', () => {
		// trials counts trials STARTED in the window (a lapsed trial still counts), so
		// it is the one column that legitimately has no status filter. Pinned with its
		// comment so a future reader does not "fix" it into the paid predicate.
		const trialLine = SRC.split('\n').find((l) => l.includes("AS trials"));
		expect(trialLine).toMatch(/sp\.kind = 'trial'/);
		expect(SRC).toMatch(/Deliberately status-free/);
	});
});
