import { describe, it, expect } from 'vitest';
import {
	usdcToAtomic,
	atomicToUsdc,
	discountedPrice,
	buyerPriceLadder,
	validatePrice,
	validateRule,
	effectivePriceNow,
	groupLedgerByStatus,
	ledgerToCsv,
	railLabel,
	funnelStage,
	TIER_LADDER,
} from './creator-helpers.js';

describe('usdcToAtomic / atomicToUsdc', () => {
	it('round-trips through 6-decimal atomic units', () => {
		expect(usdcToAtomic(1.5)).toBe(1_500_000);
		expect(usdcToAtomic(0.000001)).toBe(1);
		expect(atomicToUsdc(1_500_000)).toBe(1.5);
	});
	it('floors junk and negatives to 0', () => {
		expect(usdcToAtomic('nope')).toBe(0);
		expect(usdcToAtomic(-5)).toBe(0);
		expect(atomicToUsdc('x')).toBe(0);
	});
});

describe('discountedPrice — $THREE holder discount', () => {
	it('applies basis-point discounts using the canonical tier rates', () => {
		expect(discountedPrice(10, 0)).toBe(10);      // member
		expect(discountedPrice(10, 500)).toBe(9.5);   // bronze 5%
		expect(discountedPrice(10, 1000)).toBe(9);    // silver 10%
		expect(discountedPrice(10, 2000)).toBe(8);    // gold 20%
		expect(discountedPrice(10, 3000)).toBe(7);    // genesis 30%
	});
	it('rounds to USDC precision without float dust', () => {
		expect(discountedPrice(0.001, 500)).toBe(0.00095);
	});
	it('returns 0 for non-positive / invalid prices', () => {
		expect(discountedPrice(0, 1000)).toBe(0);
		expect(discountedPrice(-1, 1000)).toBe(0);
		expect(discountedPrice('x', 1000)).toBe(0);
	});
	it('clamps out-of-range bps', () => {
		expect(discountedPrice(10, 20000)).toBe(0);   // clamped to 100% off
		expect(discountedPrice(10, -50)).toBe(10);    // negative → no discount
	});
});

describe('buyerPriceLadder', () => {
	it('produces a price + savings row for every tier', () => {
		const ladder = buyerPriceLadder(100);
		expect(ladder).toHaveLength(TIER_LADDER.length);
		const genesis = ladder.find((r) => r.id === 'genesis');
		expect(genesis.price).toBe(70);
		expect(genesis.saves).toBe(30);
		const member = ladder.find((r) => r.id === 'member');
		expect(member.price).toBe(100);
		expect(member.saves).toBe(0);
	});
});

describe('validatePrice', () => {
	it('accepts valid prices and rounds to USDC precision', () => {
		expect(validatePrice('1.5')).toEqual({ ok: true, value: 1.5 });
		expect(validatePrice(0)).toEqual({ ok: true, value: 0 });
	});
	it('rejects empties, non-numbers, and negatives', () => {
		expect(validatePrice('').ok).toBe(false);
		expect(validatePrice(null).ok).toBe(false);
		expect(validatePrice('abc').ok).toBe(false);
		expect(validatePrice(-1).ok).toBe(false);
	});
	it('rejects sub-atomic and over-maximum prices', () => {
		expect(validatePrice(0.0000001).ok).toBe(false); // < 1 atomic
		expect(validatePrice(2_000_000).ok).toBe(false);
	});
});

describe('validateRule', () => {
	it('builds a first_n_purchases payload with atomic price', () => {
		const r = validateRule({ rule_type: 'first_n_purchases', threshold: 10, price_usdc: 0.5 });
		expect(r.ok).toBe(true);
		expect(r.payload).toMatchObject({ rule_type: 'first_n_purchases', threshold: 10, price_amount: 500_000 });
	});
	it('requires a whole-number threshold ≥ 1 for count rules', () => {
		expect(validateRule({ rule_type: 'after_n_purchases', threshold: 0, price_usdc: 1 }).ok).toBe(false);
		expect(validateRule({ rule_type: 'after_n_purchases', threshold: 1.5, price_usdc: 1 }).ok).toBe(false);
	});
	it('requires a positive rule price', () => {
		expect(validateRule({ rule_type: 'first_n_purchases', threshold: 5, price_usdc: 0 }).ok).toBe(false);
	});
	it('validates time_window bounds and ISO-normalizes them', () => {
		const start = '2026-01-01T00:00:00.000Z';
		const end = '2026-02-01T00:00:00.000Z';
		const ok = validateRule({ rule_type: 'time_window', price_usdc: 2, start_at: start, end_at: end });
		expect(ok.ok).toBe(true);
		expect(ok.payload.start_at).toBe(start);
		expect(ok.payload.end_at).toBe(end);

		expect(validateRule({ rule_type: 'time_window', price_usdc: 2 }).ok).toBe(false); // no bounds
		expect(validateRule({ rule_type: 'time_window', price_usdc: 2, start_at: end, end_at: start }).ok).toBe(false); // inverted
	});
	it('rejects unknown rule types', () => {
		expect(validateRule({ rule_type: 'bogus', price_usdc: 1 }).ok).toBe(false);
	});
});

describe('effectivePriceNow — mirrors server resolveSkillPrice', () => {
	const base = 1; // 1 USDC base
	it('falls back to base price when no rules match', () => {
		expect(effectivePriceNow({ basePriceUsdc: base, rules: [] })).toMatchObject({ priceUsdc: 1, source: 'base' });
	});
	it('applies first_n_purchases while under threshold', () => {
		const rules = [{ rule_type: 'first_n_purchases', threshold: 5, price_amount: 500_000, is_active: true }];
		expect(effectivePriceNow({ basePriceUsdc: base, rules, saleCount: 2 })).toMatchObject({ priceUsdc: 0.5, source: 'first_n_purchases' });
		expect(effectivePriceNow({ basePriceUsdc: base, rules, saleCount: 5 })).toMatchObject({ priceUsdc: 1, source: 'base' });
	});
	it('applies after_n_purchases once threshold is reached', () => {
		const rules = [{ rule_type: 'after_n_purchases', threshold: 3, price_amount: 2_000_000, is_active: true }];
		expect(effectivePriceNow({ basePriceUsdc: base, rules, saleCount: 3 }).priceUsdc).toBe(2);
		expect(effectivePriceNow({ basePriceUsdc: base, rules, saleCount: 1 }).priceUsdc).toBe(1);
	});
	it('respects time_window bounds and priority order', () => {
		const now = new Date('2026-06-15T12:00:00Z');
		const rules = [
			{ rule_type: 'time_window', price_amount: 3_000_000, is_active: true, priority: 0,
			  start_at: '2026-06-01T00:00:00Z', end_at: '2026-06-30T00:00:00Z' },
			{ rule_type: 'after_n_purchases', threshold: 1, price_amount: 9_000_000, is_active: true, priority: 1 },
		];
		// priority 0 (window) wins over the also-matching after_n rule
		expect(effectivePriceNow({ basePriceUsdc: base, rules, saleCount: 50, now }).priceUsdc).toBe(3);
	});
	it('ignores inactive rules', () => {
		const rules = [{ rule_type: 'first_n_purchases', threshold: 99, price_amount: 1, is_active: false }];
		expect(effectivePriceNow({ basePriceUsdc: base, rules, saleCount: 0 }).source).toBe('base');
	});
});

describe('groupLedgerByStatus', () => {
	it('buckets entries and totals each settlement state', () => {
		const entries = [
			{ status: 'pending', price_usd: 1 },
			{ status: 'pending', price_usd: 2 },
			{ status: 'settling', price_usd: 4 },
			{ status: 'settled', price_usd: 8 },
			{ status: 'failed', price_usd: 0.5 },
			{ status: 'weird', price_usd: 1 }, // unknown → pending
		];
		const { buckets, totals } = groupLedgerByStatus(entries);
		expect(totals.pending).toBe(4); // 1 + 2 + 1 (unknown)
		expect(totals.settling).toBe(4);
		expect(totals.settled).toBe(8);
		expect(totals.failed).toBe(0.5);
		expect(buckets.pending).toHaveLength(3);
	});
});

const CSV_HEADER = 'Date,Type,Skill,Agent,Amount (USD),Platform fee (USD),Status,Rail,Chain,Transaction';

describe('railLabel', () => {
	it('names each earning rail', () => {
		expect(railLabel('x402')).toBe('Per-call (x402)');
		expect(railLabel('skill-runtime')).toBe('In-app call');
		expect(railLabel('asset-sale')).toBe('Asset sale');
	});
	it('falls back to the in-app lane for an unknown or missing source', () => {
		expect(railLabel(undefined)).toBe('In-app call');
		expect(railLabel('something-new')).toBe('In-app call');
	});
});

describe('ledgerToCsv', () => {
	it('emits a header and escapes cells with commas/quotes', () => {
		const csv = ledgerToCsv([
			{ created_at: '2026-06-01', kind: 'skill', skill_name: 'Do, a thing', agent_name: 'Agent "X"', price_usd: 1.5, status: 'settled' },
		]);
		const lines = csv.split('\n');
		expect(lines[0]).toBe(CSV_HEADER);
		expect(lines[1]).toContain('"Do, a thing"');
		expect(lines[1]).toContain('"Agent ""X"""');
		expect(lines[1]).toContain('1.500000');
	});

	it('carries the settlement provenance of a per-call royalty', () => {
		const csv = ledgerToCsv(
			[{
				created_at: '2026-08-13', kind: 'skill', skill_name: 'Wallet Balance', agent_name: null,
				price_usd: 0.24375, platform_fee_usd: 0.00625, status: 'settled',
				source: 'x402', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', tx_hash: '5xTxSignature',
			}],
			{ networkLabel: () => 'Solana' },
		);
		const row = csv.split('\n')[1];
		expect(row).toContain('Per-call (x402)');
		expect(row).toContain('Solana');
		expect(row).toContain('5xTxSignature');
		// Full USDC precision: per-call royalties are routinely sub-cent, so a
		// 4-decimal export would round real money out of the author's records.
		expect(row).toContain('0.243750');
		expect(row).toContain('0.006250');
	});

	it('keeps a sub-cent royalty from rounding to zero', () => {
		const csv = ledgerToCsv([{ created_at: '2026-08-13', price_usd: 0.000001, status: 'settled' }]);
		expect(csv.split('\n')[1]).toContain('0.000001');
	});

	it('leaves the fee, chain and transaction blank rather than guessing', () => {
		const csv = ledgerToCsv([{ created_at: '2026-08-13', price_usd: 1, status: 'pending', source: 'skill-runtime' }]);
		expect(csv.split('\n')[1].endsWith(',,')).toBe(true);
	});

	it('handles empty input', () => {
		expect(ledgerToCsv([])).toBe(CSV_HEADER);
	});
});

describe('funnelStage', () => {
	it('walks the become-a-creator path', () => {
		expect(funnelStage({ agentCount: 0 })).toBe('no_agent');
		expect(funnelStage({ agentCount: 1, priceCount: 0 })).toBe('set_price');
		expect(funnelStage({ agentCount: 1, priceCount: 2, hasPayout: false })).toBe('configure_payout');
		expect(funnelStage({ agentCount: 1, priceCount: 2, hasPayout: true, hasSale: false })).toBe('first_sale');
		expect(funnelStage({ agentCount: 1, priceCount: 2, hasPayout: true, hasSale: true })).toBe('earning');
	});
});
