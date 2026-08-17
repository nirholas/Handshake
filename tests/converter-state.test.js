import { describe, it, expect } from 'vitest';
import {
	EMPTY,
	MAX_AMOUNT,
	assetCode,
	assetRef,
	buildConverterQuery,
	convert,
	fiatPerUsd,
	formatCryptoAmount,
	formatFiatAmount,
	formatInAsset,
	fromUsd,
	parseAmount,
	parseConverterQuery,
	resolveAssetRef,
	toUsd,
} from '../src/shared/converter-state.js';

// Numbers shaped like a real /api/coin/rates payload: fiat units per 1 BTC.
const USD_PER_BTC = 60000;
const USD = { kind: 'fiat', code: 'USD', name: 'US Dollar', unit: '$', per_btc: USD_PER_BTC };
const EUR = { kind: 'fiat', code: 'EUR', name: 'Euro', unit: '€', per_btc: 54000 };
const CHF = { kind: 'fiat', code: 'CHF', name: 'Swiss Franc', unit: 'Fr.', per_btc: 51000 };
const BTC = { kind: 'crypto', id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', priceUSD: 60000 };
const ETH = { kind: 'crypto', id: 'ethereum', symbol: 'ETH', name: 'Ethereum', priceUSD: 3000 };
const DEAD = { kind: 'crypto', id: 'ghost', symbol: 'GHOST', name: 'Ghost', priceUSD: NaN };

const FIATS = new Map([
	['USD', USD],
	['EUR', EUR],
]);

describe('converter conversion math', () => {
	it('derives fiat units per USD from the shared BTC anchor', () => {
		expect(fiatPerUsd(USD, USD_PER_BTC)).toBe(1);
		expect(fiatPerUsd(EUR, USD_PER_BTC)).toBeCloseTo(0.9, 10);
	});

	it('converts crypto to fiat', () => {
		expect(convert(2, BTC, USD, USD_PER_BTC)).toBeCloseTo(120000, 6);
		expect(convert(1, BTC, EUR, USD_PER_BTC)).toBeCloseTo(54000, 6);
	});

	it('converts fiat to crypto', () => {
		expect(convert(60000, USD, BTC, USD_PER_BTC)).toBeCloseTo(1, 10);
		expect(convert(54000, EUR, BTC, USD_PER_BTC)).toBeCloseTo(1, 10);
	});

	it('converts crypto to crypto', () => {
		expect(convert(1, BTC, ETH, USD_PER_BTC)).toBeCloseTo(20, 10);
	});

	it('converts fiat to fiat', () => {
		expect(convert(100, USD, EUR, USD_PER_BTC)).toBeCloseTo(90, 10);
	});

	it('round-trips a value back to where it started', () => {
		const there = convert(7.5, ETH, CHF, USD_PER_BTC);
		expect(convert(there, CHF, ETH, USD_PER_BTC)).toBeCloseTo(7.5, 10);
	});

	it('returns null instead of a wrong number when a leg has no price', () => {
		expect(convert(1, DEAD, USD, USD_PER_BTC)).toBeNull();
		expect(convert(1, BTC, DEAD, USD_PER_BTC)).toBeNull();
		expect(convert(1, BTC, USD, NaN)).toBeNull();
		expect(convert(NaN, BTC, USD, USD_PER_BTC)).toBeNull();
		expect(convert(1, null, USD, USD_PER_BTC)).toBeNull();
	});

	it('refuses to divide by a zero price', () => {
		expect(fromUsd(100, { ...BTC, priceUSD: 0 }, USD_PER_BTC)).toBeNull();
		expect(toUsd(100, { ...USD, per_btc: 0 }, USD_PER_BTC)).toBeNull();
	});
});

describe('converter formatting', () => {
	it('hugs glyph units and spaces alphabetic ones', () => {
		expect(formatFiatAmount(1234.5, '$')).toBe('$1,234.50');
		expect(formatFiatAmount(1234.5, 'Fr.')).toBe('Fr. 1,234.50');
		expect(formatFiatAmount(-20, '€')).toBe('-€20.00');
	});

	it('keeps precision on sub-cent fiat values', () => {
		expect(formatFiatAmount(0.000123456, '$')).toBe('$0.0001235');
	});

	it('expands deep-decimal crypto amounts instead of using exponents', () => {
		expect(formatCryptoAmount(0.0000158733)).toBe('0.0000158733');
		expect(formatCryptoAmount(1.5e-9)).not.toContain('e');
		expect(formatCryptoAmount(2)).toBe('2');
		expect(formatCryptoAmount(0)).toBe('0');
	});

	it('falls back to the placeholder glyph for an unusable value', () => {
		expect(formatCryptoAmount(NaN)).toBe(EMPTY);
		expect(formatFiatAmount(null, '$')).toBe(EMPTY);
		expect(formatInAsset(1, null)).toBe(EMPTY);
	});

	it('formats in whichever asset it is given', () => {
		expect(formatInAsset(5, USD)).toBe('$5.00');
		expect(formatInAsset(5, BTC)).toBe('5');
		expect(assetCode(USD)).toBe('USD');
		expect(assetCode(BTC)).toBe('BTC');
		expect(assetCode(null)).toBe('');
	});
});

describe('converter amount parsing', () => {
	it('accepts plain and grouped numbers', () => {
		expect(parseAmount('250')).toBe(250);
		expect(parseAmount('1,234.5')).toBe(1234.5);
		expect(parseAmount(' 0.5 ')).toBe(0.5);
		expect(parseAmount(0)).toBe(0);
	});

	it('rejects anything that is not a usable positive number', () => {
		for (const bad of ['abc', '', null, undefined, '-5', '1e9', 'Infinity', '1.2.3', '  ']) {
			expect(Number.isNaN(parseAmount(bad))).toBe(true);
		}
	});

	it('rejects values past the supported ceiling', () => {
		expect(parseAmount(String(MAX_AMOUNT))).toBe(MAX_AMOUNT);
		expect(Number.isNaN(parseAmount('9'.repeat(30)))).toBe(true);
	});
});

describe('converter shareable URL codec', () => {
	it('serializes a view into a readable query', () => {
		expect(buildConverterQuery({ from: BTC, to: USD, amount: 1 })).toBe('?from=bitcoin&to=USD');
		expect(buildConverterQuery({ from: ETH, to: EUR, amount: 3 })).toBe(
			'?from=ethereum&to=EUR&amount=3',
		);
	});

	it('omits the default amount and any missing side', () => {
		expect(buildConverterQuery({ from: BTC, to: null, amount: 1 })).toBe('?from=bitcoin');
		expect(buildConverterQuery({})).toBe('');
		expect(buildConverterQuery({ from: BTC, to: USD, amount: NaN })).toBe('?from=bitcoin&to=USD');
	});

	it('never emits exponent notation an amount parser would reject', () => {
		const q = buildConverterQuery({ from: BTC, to: USD, amount: 1e-9 });
		expect(q).not.toContain('e');
		expect(parseConverterQuery(q).amount).toBeCloseTo(1e-9, 15);
	});

	it('round-trips a view through the query string', () => {
		const q = buildConverterQuery({ from: ETH, to: EUR, amount: 12.25 });
		const parsed = parseConverterQuery(q);
		expect(parsed).toEqual({ from: 'ethereum', to: 'EUR', amount: 12.25 });
		expect(resolveAssetRef(parsed.from, FIATS)).toEqual({ kind: 'crypto', id: 'ethereum' });
		expect(resolveAssetRef(parsed.to, FIATS)).toEqual({ kind: 'fiat', code: 'EUR' });
	});

	it('drops refs that cannot be a coin id or currency code', () => {
		const parsed = parseConverterQuery('?from=<script>&to=' + 'x'.repeat(80) + '&amount=abc');
		expect(parsed.from).toBeNull();
		expect(parsed.to).toBeNull();
		expect(Number.isNaN(parsed.amount)).toBe(true);
	});

	it('treats a known currency code as fiat regardless of case', () => {
		expect(resolveAssetRef('usd', FIATS)).toEqual({ kind: 'fiat', code: 'USD' });
		expect(resolveAssetRef('USD', FIATS)).toEqual({ kind: 'fiat', code: 'USD' });
	});

	it('treats an unknown ref as a coin id rather than failing', () => {
		expect(resolveAssetRef('ZZZ', FIATS)).toEqual({ kind: 'crypto', id: 'zzz' });
		expect(resolveAssetRef(null, FIATS)).toBeNull();
	});

	it('uses the code for fiat and the coin id for crypto', () => {
		expect(assetRef(USD)).toBe('USD');
		expect(assetRef(BTC)).toBe('bitcoin');
		expect(assetRef(null)).toBeNull();
	});
});
