// api/_lib/pump-onchain-trades.js — decoded-event field access.
//
// The live failure this guards: anchor's coder emits snake_case event fields
// with the current pump IDL (sol_amount, is_buy), while older toolchains
// camelCased them. Consumers that read only one casing silently dropped every
// trade (the oracle pipeline starved on exactly this). eventField must serve
// both shapes.

import { describe, it, expect } from 'vitest';
import { eventField } from '../api/_lib/pump-onchain-trades.js';

// Mimics a BN-ish decoded value: only toString matters to consumers.
const bn = (v) => ({ toString: () => String(v) });

describe('eventField', () => {
	it('reads snake_case fields via their camelCase name', () => {
		const data = { sol_amount: bn(493827159), is_buy: true, token_amount: bn(2558317), user: bn('abc') };
		expect(eventField(data, 'solAmount').toString()).toBe('493827159');
		expect(eventField(data, 'isBuy')).toBe(true);
		expect(eventField(data, 'tokenAmount').toString()).toBe('2558317');
	});

	it('prefers the camelCase field when present', () => {
		const data = { solAmount: bn(7), sol_amount: bn(9) };
		expect(eventField(data, 'solAmount').toString()).toBe('7');
	});

	it('handles multi-hump names', () => {
		const data = { quote_amount_in: bn(11), base_amount_out: bn(22) };
		expect(eventField(data, 'quoteAmountIn').toString()).toBe('11');
		expect(eventField(data, 'baseAmountOut').toString()).toBe('22');
	});

	it('returns undefined for absent fields and nullish data', () => {
		expect(eventField({}, 'solAmount')).toBeUndefined();
		expect(eventField(null, 'solAmount')).toBeUndefined();
		expect(eventField(undefined, 'solAmount')).toBeUndefined();
	});

	it('does not confuse falsy values with absence', () => {
		expect(eventField({ is_buy: false }, 'isBuy')).toBe(false);
		expect(eventField({ sol_amount: 0 }, 'solAmount')).toBe(0);
	});
});
