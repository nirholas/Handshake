import { describe, it, expect } from 'vitest';
import {
	lamportsToSol,
	clamp01,
	fmtSol,
	fmtUsd,
	fmtPrice,
	shortMint,
	curveValue,
	curvePointAt,
	curvePoints,
	areaPathFor,
	computeView,
	renderCardShell,
	isPumpMint,
} from './bonding-curve.js';

const LAMPORTS = 1_000_000_000;

describe('lamportsToSol', () => {
	it('converts lamports (number or string) to SOL', () => {
		expect(lamportsToSol(LAMPORTS)).toBe(1);
		expect(lamportsToSol(String(5 * LAMPORTS))).toBe(5);
		expect(lamportsToSol(0)).toBe(0);
	});
	it('returns 0 for non-finite input', () => {
		expect(lamportsToSol('abc')).toBe(0);
		expect(lamportsToSol(undefined)).toBe(0);
		expect(lamportsToSol(null)).toBe(0);
	});
});

describe('clamp01', () => {
	it('clamps into [0,1]', () => {
		expect(clamp01(-2)).toBe(0);
		expect(clamp01(0.5)).toBe(0.5);
		expect(clamp01(3)).toBe(1);
		expect(clamp01(NaN)).toBe(0);
	});
});

describe('fmtSol', () => {
	it('renders compact suffixes and the ◎ glyph', () => {
		expect(fmtSol(0)).toBe('◎ 0');
		expect(fmtSol(0.123)).toBe('◎ 0.123');
		expect(fmtSol(18.4)).toBe('◎ 18.40');
		expect(fmtSol(1500)).toBe('◎ 1.50K');
		expect(fmtSol(2_500_000)).toBe('◎ 2.50M');
	});
	it('handles bad input', () => {
		expect(fmtSol(NaN)).toBe('◎ —');
	});
});

describe('fmtUsd', () => {
	it('renders compact USD', () => {
		expect(fmtUsd(0)).toBe('$0');
		expect(fmtUsd(12.5)).toBe('$12.50');
		expect(fmtUsd(12_300)).toBe('$12.3K');
		expect(fmtUsd(4_500_000)).toBe('$4.50M');
		expect(fmtUsd(2_100_000_000)).toBe('$2.10B');
	});
	it('handles sub-dollar and bad input', () => {
		expect(fmtUsd(0.42)).toBe('$0.42');
		expect(fmtUsd(NaN)).toBe('$—');
	});
});

describe('fmtPrice', () => {
	it('renders tiny prices without scientific notation', () => {
		const out = fmtPrice(0.0000003);
		expect(out.startsWith('◎ ')).toBe(true);
		expect(out).not.toContain('e');
		expect(out).toContain('0.0000003');
	});
	it('renders USD prices and guards zero/negative', () => {
		expect(fmtPrice(0.05, { usd: true })).toBe('$0.0500');
		expect(fmtPrice(0, { usd: true })).toBe('$—');
		expect(fmtPrice(-1)).toBe('◎ —');
	});
});

describe('shortMint', () => {
	it('truncates the middle', () => {
		expect(shortMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('EPjF…Dt1v');
	});
	it('leaves short strings intact', () => {
		expect(shortMint('abc')).toBe('abc');
		expect(shortMint('')).toBe('');
	});
});

describe('isPumpMint', () => {
	it('accepts mints ending in the pump suffix', () => {
		expect(isPumpMint('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump')).toBe(true);
	});
	it('rejects settlement / native tokens', () => {
		expect(isPumpMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(false); // USDC
		expect(isPumpMint('So11111111111111111111111111111111111111112')).toBe(false); // wSOL
		expect(isPumpMint('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')).toBe(false); // USDT
		expect(isPumpMint('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')).toBe(false); // USDC devnet
	});
	it('rejects any mint that does not end in "pump"', () => {
		expect(isPumpMint('So11111111111111111111111111111111111111112')).toBe(false);
		expect(isPumpMint('')).toBe(false);
		expect(isPumpMint(null)).toBe(false);
		expect(isPumpMint(undefined)).toBe(false);
	});
});

describe('curve geometry', () => {
	it('curveValue is 0 at t=0, 1 at t=1, and monotonically increasing', () => {
		expect(curveValue(0)).toBe(0);
		expect(curveValue(1)).toBe(1);
		expect(curveValue(0.25)).toBeLessThan(curveValue(0.75));
	});

	it('curveValue is convex (accelerating)', () => {
		const a = curveValue(0.5) - curveValue(0.4);
		const b = curveValue(0.9) - curveValue(0.8);
		expect(b).toBeGreaterThan(a);
	});

	it('curvePointAt rises to the right (y decreases as t grows)', () => {
		const left = curvePointAt(0);
		const right = curvePointAt(1);
		expect(right.x).toBeGreaterThan(left.x);
		expect(right.y).toBeLessThan(left.y);
	});

	it('curvePoints starts with a move command and is non-empty', () => {
		const d = curvePoints();
		expect(d.startsWith('M')).toBe(true);
		expect(d.length).toBeGreaterThan(20);
	});

	it('areaPathFor produces a closed path and grows with progress', () => {
		const small = areaPathFor(0.1);
		const big = areaPathFor(0.9);
		expect(small.endsWith('Z')).toBe(true);
		expect(big.endsWith('Z')).toBe(true);
		expect(big.length).toBeGreaterThan(small.length);
	});
});

describe('computeView', () => {
	it('returns empty status with no data', () => {
		expect(computeView(null).status).toBe('empty');
		expect(computeView({}).status).toBe('empty');
	});

	it('derives progress and SOL figures from a bonding payload', () => {
		const data = {
			mint: 'MintAddr',
			network: 'mainnet',
			curve: {
				realSolReserves: String(20 * LAMPORTS),
				tokenTotalSupply: '1000000000000000', // 1B tokens at 6 decimals
				complete: false,
				isMayhemMode: false,
			},
			price: { buyPricePerToken: '30', marketCap: String(42 * LAMPORTS), isGraduated: false },
			graduation: {
				progressBps: 3450,
				isGraduated: false,
				solAccumulated: String(18 * LAMPORTS),
			},
		};
		const v = computeView(data, null);
		expect(v.status).toBe('bonding');
		expect(v.progress).toBeCloseTo(0.345, 5);
		expect(v.progressPct).toBeCloseTo(34.5, 5);
		// 30 lamports per token × 1B tokens = 30 SOL. The SDK's `price.marketCap`
		// is deliberately not used — see the derivation note in computeView.
		expect(v.marketCapSol).toBeCloseTo(30, 6);
		expect(v.raisedSol).toBe(18);
		expect(v.hasUsd).toBe(false);
		expect(v.marketCapUsd).toBeNull();
	});

	it('falls back to the fixed 1B pump.fun supply when the payload omits it', () => {
		const v = computeView(
			{
				mint: 'M',
				curve: { realSolReserves: '0', complete: false },
				price: { buyPricePerToken: '30' },
				graduation: { progressBps: 0, solAccumulated: '0' },
			},
			null,
		);
		expect(v.marketCapSol).toBeCloseTo(30, 6);
	});

	it('enriches with USD when a SOL price is supplied', () => {
		const data = {
			mint: 'M',
			curve: { realSolReserves: '0', complete: false, tokenTotalSupply: '1000000000000000' },
			price: { marketCap: String(10 * LAMPORTS), buyPricePerToken: '10' },
			graduation: { progressBps: 5000, solAccumulated: String(2 * LAMPORTS) },
		};
		const v = computeView(data, 150);
		expect(v.hasUsd).toBe(true);
		expect(v.marketCapUsd).toBe(1500); // 10 SOL × $150
		expect(v.raisedUsd).toBe(300);
	});

	it('clamps a graduated token to 100% regardless of bps', () => {
		const data = {
			mint: 'M',
			curve: { complete: true, realSolReserves: '0' },
			price: { marketCap: '0', isGraduated: true },
			graduation: { progressBps: 10_000, isGraduated: true, solAccumulated: '0' },
		};
		const v = computeView(data);
		expect(v.status).toBe('graduated');
		expect(v.progress).toBe(1);
	});

	it('renders a graduated coin from graduatedPrice even when the curve account lingers', () => {
		// The exact production shape for our $THREE: the closed curve account is still
		// readable (complete=true, reserves zeroed) AND a live DEX price is attached.
		// The widget must use the DEX price, not the curve's zeroed reserves.
		const data = {
			mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
			network: 'mainnet',
			graduated: true,
			curve: { realSolReserves: '0', complete: true, isMayhemMode: false },
			price: null,
			graduation: { isGraduated: true, progressBps: 10_000 },
			graduatedPrice: { priceUsd: 0.0035, marketCapUsd: 3_500_000, source: 'jupiter' },
		};
		const v = computeView(data, 150);
		expect(v.status).toBe('graduated');
		expect(v.progress).toBe(1);
		expect(v.priceUsd).toBe(0.0035);
		expect(v.marketCapUsd).toBe(3_500_000);
		expect(v.hasUsd).toBe(true);
		expect(v.raisedSol).toBeNull();
	});

	it('derives a graduated market cap from price × fixed supply when none is supplied', () => {
		// Older/partial payload: priceUsd present, marketCapUsd absent (the current
		// live curve endpoint before its market-cap enrichment ships).
		const data = {
			mint: 'M',
			curve: { complete: true, realSolReserves: '0' },
			graduation: { isGraduated: true, progressBps: 10_000 },
			graduatedPrice: { priceUsd: 0.002, source: 'jupiter' },
		};
		const v = computeView(data);
		expect(v.status).toBe('graduated');
		expect(v.priceUsd).toBe(0.002);
		expect(v.marketCapUsd).toBeCloseTo(0.002 * 1_000_000_000, 3);
		expect(v.hasUsd).toBe(true);
	});

	it('handles the curve-gone graduated shape (account closed on migration)', () => {
		const data = {
			mint: 'M',
			graduated: true,
			curve: null,
			graduation: { isGraduated: true, progressBps: 10_000 },
			graduatedPrice: { priceUsd: 0.01, marketCapUsd: 10_000_000, source: 'jupiter' },
		};
		const v = computeView(data);
		expect(v.status).toBe('graduated');
		expect(v.priceUsd).toBe(0.01);
		expect(v.marketCapUsd).toBe(10_000_000);
	});

	// The SDK's `price.marketCap` goes negative on real curves — a live devnet
	// coin 95% of the way to graduation reports -1.75 SOL while holding 30.3 SOL
	// of virtual reserves. Reading it and clamping rendered "◎0" for a coin with
	// a real price, which is why the market cap is derived from price × supply.
	it('ignores the negative pseudo-market-cap the SDK reports', () => {
		const data = {
			mint: 'M',
			network: 'mainnet',
			curve: {
				realSolReserves: '0',
				tokenTotalSupply: '1000000000000000',
				complete: false,
				isMayhemMode: false,
			},
			price: { marketCap: '-2041006523', buyPricePerToken: '30', isGraduated: false },
			graduation: { progressBps: 0, isGraduated: false, solAccumulated: '0' },
		};
		const v = computeView(data, 150);
		expect(v.status).toBe('bonding');
		expect(v.progress).toBe(0);
		expect(v.marketCapSol).toBeCloseTo(30, 6);
		expect(v.marketCapUsd).toBeCloseTo(4500, 6);
	});

	it('reports no market cap when the curve has no price yet', () => {
		const v = computeView(
			{
				mint: 'M',
				curve: { realSolReserves: '0', complete: false, tokenTotalSupply: '1000000000000000' },
				price: { buyPricePerToken: '0' },
				graduation: { progressBps: 0, solAccumulated: '0' },
			},
			150,
		);
		expect(v.marketCapSol).toBe(0);
		expect(v.marketCapUsd).toBe(0);
	});
});

describe('renderCardShell', () => {
	it('embeds a pump.fun link and the shortened mint', () => {
		const html = renderCardShell(
			{
				status: 'bonding',
				mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				network: 'mainnet',
			},
			{},
		);
		expect(html).toContain('https://pump.fun/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
		expect(html).toContain('EPjF…Dt1v');
		expect(html).toContain('data-area');
		expect(html).toContain('data-marker');
	});

	it('marks devnet and mayhem mode', () => {
		const html = renderCardShell(
			{ status: 'bonding', mint: 'M', network: 'devnet', isMayhem: true },
			{},
		);
		expect(html).toContain('devnet');
		expect(html).toContain('mayhem');
	});

	it('omits the powered-by link when disabled', () => {
		const html = renderCardShell({ status: 'bonding', mint: 'M' }, { showPoweredBy: false });
		expect(html).not.toContain('>three.ws<');
	});

	it('escapes hostile mint input', () => {
		const html = renderCardShell(
			{ status: 'bonding', mint: '"><script>x', network: 'mainnet' },
			{},
		);
		expect(html).not.toContain('<script>x');
	});
});
