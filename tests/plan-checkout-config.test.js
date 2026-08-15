import { describe, it, expect, afterEach } from 'vitest';
import {
	PLANS,
	PLAN_ASSETS,
	planPriceUsd,
	threePlanDiscountBps,
	INTENT_TTL_MINUTES,
	QUOTED_INTENT_TTL_MINUTES,
	EVM_USDC,
	getEvmRecipient,
	getSolanaRecipient,
	toUsdcAtomics,
} from '../api/payments/_config.js';

const RECIPIENT_VARS = [
	'PAYMENT_RECIPIENT_SOLANA',
	'PAYMENT_RECIPIENT_EVM',
	'PAYMENT_RECIPIENT_EVM_8453',
];
const PRIOR = Object.fromEntries(RECIPIENT_VARS.map((k) => [k, process.env[k]]));

afterEach(() => {
	delete process.env.THREE_PLAN_DISCOUNT_BPS;
	for (const k of RECIPIENT_VARS) {
		if (PRIOR[k] === undefined) delete process.env[k];
		else process.env[k] = PRIOR[k];
	}
});

describe('PLAN_ASSETS', () => {
	it('accepts USDC, SOL, and THREE', () => {
		expect(PLAN_ASSETS).toEqual(['USDC', 'SOL', 'THREE']);
	});
});

describe('threePlanDiscountBps', () => {
	it('defaults to 20%', () => {
		expect(threePlanDiscountBps()).toBe(2000);
	});

	it('honors the env override', () => {
		process.env.THREE_PLAN_DISCOUNT_BPS = '1500';
		expect(threePlanDiscountBps()).toBe(1500);
	});

	it('allows disabling the discount entirely', () => {
		process.env.THREE_PLAN_DISCOUNT_BPS = '0';
		expect(threePlanDiscountBps()).toBe(0);
	});

	it('falls back to the default on garbage or out-of-range values', () => {
		for (const bad of ['nope', '-100', '9000', '']) {
			process.env.THREE_PLAN_DISCOUNT_BPS = bad;
			expect(threePlanDiscountBps()).toBe(2000);
		}
	});
});

describe('planPriceUsd', () => {
	it('charges the sticker price for USDC and SOL', () => {
		for (const plan of Object.keys(PLANS)) {
			expect(planPriceUsd(plan, 'USDC')).toBe(PLANS[plan].price_usd);
			expect(planPriceUsd(plan, 'SOL')).toBe(PLANS[plan].price_usd);
			expect(planPriceUsd(plan)).toBe(PLANS[plan].price_usd);
		}
	});

	it('applies the $THREE discount, rounded to cents', () => {
		expect(planPriceUsd('pro', 'THREE')).toBe(
			Math.round(PLANS.pro.price_usd * 0.8 * 100) / 100,
		);
	});

	it('never discounts below zero or above the sticker price', () => {
		for (const plan of Object.keys(PLANS)) {
			const three = planPriceUsd(plan, 'THREE');
			expect(three).toBeGreaterThan(0);
			expect(three).toBeLessThanOrEqual(PLANS[plan].price_usd);
		}
	});
});

describe('intent TTLs', () => {
	it('gives live-priced quotes a shorter session than USDC', () => {
		expect(QUOTED_INTENT_TTL_MINUTES).toBeLessThan(INTENT_TTL_MINUTES);
	});
});

describe('recipients', () => {
	// Both getters return null when unset, which is what turns checkout into a
	// 503 not_configured instead of quoting a payment nobody can collect.
	it('returns null when nothing is configured', () => {
		for (const k of RECIPIENT_VARS) delete process.env[k];
		expect(getSolanaRecipient()).toBeNull();
		expect(getEvmRecipient(8453)).toBeNull();
	});

	it('reads the configured Solana treasury', () => {
		process.env.PAYMENT_RECIPIENT_SOLANA = 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU';
		expect(getSolanaRecipient()).toBe('wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU');
	});

	it('prefers the per-chain EVM recipient over the shared default', () => {
		process.env.PAYMENT_RECIPIENT_EVM = '0x1111111111111111111111111111111111111111';
		process.env.PAYMENT_RECIPIENT_EVM_8453 = '0x2222222222222222222222222222222222222222';
		expect(getEvmRecipient(8453)).toBe('0x2222222222222222222222222222222222222222');
		expect(getEvmRecipient(137)).toBe('0x1111111111111111111111111111111111111111');
	});
});

describe('USDC atomics', () => {
	it('scales USD to 6-decimal atomics as a bigint', () => {
		expect(toUsdcAtomics(49)).toBe(49_000_000n);
		expect(toUsdcAtomics(0.01)).toBe(10_000n);
	});

	it('rounds sub-atomic fractions instead of throwing on a non-integer', () => {
		expect(toUsdcAtomics(1.0000004)).toBe(1_000_000n);
	});

	it('quotes a chain we accept for every EVM plan payment', () => {
		for (const [chainId, address] of Object.entries(EVM_USDC)) {
			expect(Number(chainId)).toBeGreaterThan(0);
			expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
		}
	});
});
