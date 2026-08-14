// Currency-normalisation contract for POST /api/x402/analytics { report: 'marketplace' }.
//
// The marketplace report converts every listing price to USD before averaging.
// It decides whether a price is convertible by lower-casing the row's mint and
// looking it up in USDC_MINTS / SOL_MINTS. A set entry that is not itself fully
// lower-cased can therefore never match: the Solana USDC entry had kept its
// mixed-case tail, so every Solana-priced agent came back priceable:false and
// dropped silently out of avg/min/max USD, leaving a paid report that
// under-reported the catalog. These tests pin the invariant that makes the
// lookup work at all.

import { describe, it, expect } from 'vitest';
import { __test__ } from '../../api/x402/analytics.js';

const { USDC_MINTS, SOL_MINTS, currencyLabel } = __test__;

const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

describe('analytics marketplace currency sets', () => {
	it('stores every mint lower-cased, so a lower-cased lookup can match', () => {
		for (const mint of [...USDC_MINTS, ...SOL_MINTS]) {
			expect(mint).toBe(mint.toLowerCase());
		}
	});

	it('recognises USDC on both chains from the canonical mixed-case mint', () => {
		expect(USDC_MINTS.has(SOLANA_USDC.toLowerCase())).toBe(true);
		expect(USDC_MINTS.has(BASE_USDC.toLowerCase())).toBe(true);
	});

	it('recognises SOL from both the native marker and wrapped mint', () => {
		expect(SOL_MINTS.has('native')).toBe(true);
		expect(SOL_MINTS.has(WRAPPED_SOL.toLowerCase())).toBe(true);
	});

	it('does not treat an unrelated mint as convertible', () => {
		expect(USDC_MINTS.has('notamint')).toBe(false);
		expect(SOL_MINTS.has('notamint')).toBe(false);
	});
});

describe('analytics currencyLabel', () => {
	it('labels the recognised assets by ticker regardless of input casing', () => {
		expect(currencyLabel(SOLANA_USDC)).toBe('USDC');
		expect(currencyLabel(SOLANA_USDC.toLowerCase())).toBe('USDC');
		expect(currencyLabel(BASE_USDC)).toBe('USDC');
		expect(currencyLabel('native')).toBe('SOL');
		expect(currencyLabel(WRAPPED_SOL)).toBe('SOL');
	});

	it('abbreviates an unknown long mint and passes a short one through', () => {
		const unknown = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
		expect(currencyLabel(unknown)).toBe(`${unknown.slice(0, 4)}…${unknown.slice(-4)}`);
		expect(currencyLabel('short')).toBe('short');
		expect(currencyLabel(null)).toBe('unknown');
	});
});
