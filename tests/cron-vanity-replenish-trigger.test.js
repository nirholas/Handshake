// The vanity shelf's replenishment trigger (api/cron/vanity-inventory-replenish.js).
//
// The cron's contract was always "fire the grinder when stock OR the distinct-tier
// count drops below a watermark", but only the stock half was implemented: a shelf
// holding hundreds of items that had collapsed to a single rarity tier read as
// healthy forever, so the premium tiers (api/x402/vanity-premium.js sells per tier)
// could go permanently unservable while the grinder never ran. These lock both
// halves in, including the case that regressed.
import { test, expect } from 'vitest';
import { replenishTrigger } from '../api/cron/vanity-inventory-replenish.js';

test('a deep, well-spread shelf does not fire a grind', () => {
	const { low, reasons } = replenishTrigger({ available: 385, tiers: 5 });
	expect(low).toBe(false);
	expect(reasons).toEqual([]);
});

test('shallow stock fires a grind and says so', () => {
	const { low, reasons } = replenishTrigger({ available: 4, tiers: 5 });
	expect(low).toBe(true);
	expect(reasons.join(' ')).toMatch(/available 4/);
});

test('a deep shelf collapsed to one tier still fires a grind', () => {
	// The regression: depth alone reads healthy, spread does not.
	const { low, reasons } = replenishTrigger({ available: 300, tiers: 1 });
	expect(low).toBe(true);
	expect(reasons.join(' ')).toMatch(/tiers 1/);
	expect(reasons.join(' ')).not.toMatch(/available/);
});

test('both watermarks failing are both reported', () => {
	const { low, reasons } = replenishTrigger({ available: 2, tiers: 1 });
	expect(low).toBe(true);
	expect(reasons).toHaveLength(2);
});

test('an empty shelf is low, and a missing stat is treated as zero', () => {
	expect(replenishTrigger({}).low).toBe(true);
	expect(replenishTrigger({ available: 0, tiers: 0 }).low).toBe(true);
});
