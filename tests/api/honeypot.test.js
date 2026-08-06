// Honeypot.is client (api/_lib/honeypot.js) and its wiring into the generic
// token security snapshot (api/_lib/token-market.js).
//
// The EVM fixture mirrors the live api.honeypot.is/v2/IsHoneypot shape
// captured 2026-08-05 for WETH on Ethereum (a major, well-known token used
// for shape verification only). The Solana mint is $THREE, the platform's
// own promoted coin. No network is touched (URL-routing fetch mock).

import { describe, it, expect, vi, afterAll } from 'vitest';
import { fetchHoneypot, honeypotChainId } from '../../api/_lib/honeypot.js';
import { fetchTokenMarket, buildTokenRisk } from '../../api/_lib/token-market.js';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const NOW = Date.parse('2026-08-05T00:00:00.000Z');

const realFetch = global.fetch;
afterAll(() => { global.fetch = realFetch; });

function jres(obj, ok = true, status = 200) {
	return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

// Live shape from GET /v2/IsHoneypot?address={WETH} (captured 2026-08-05),
// trimmed to the sections the client reads.
const WETH_REPORT = {
	token: { name: 'Wrapped Ether', symbol: 'WETH', decimals: 18, address: WETH, totalHolders: 3311580 },
	summary: { risk: 'low', riskLevel: 1, flags: [] },
	simulationSuccess: true,
	honeypotResult: { isHoneypot: false },
	simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0, buyGas: '146653', sellGas: '130824' },
	flags: [],
	contractCode: { openSource: true, rootOpenSource: true, isProxy: false, hasProxyCalls: false },
	chain: { id: '1', name: 'Ethereum', shortName: 'eth', currency: 'ETH' },
	pairAddress: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
	pair: { pair: { name: 'Uniswap V3: USDC-WETH' }, liquidity: 95423022.35809729 },
};

describe('fetchHoneypot', () => {
	it('normalizes the live WETH report shape', async () => {
		global.fetch = vi.fn(async (url) => {
			const u = new URL(String(url));
			expect(u.origin + u.pathname).toBe('https://api.honeypot.is/v2/IsHoneypot');
			expect(u.searchParams.get('address')).toBe(WETH);
			expect(u.searchParams.get('chainID')).toBeNull();
			return jres(WETH_REPORT);
		});
		const h = await fetchHoneypot(WETH);
		expect(h.is_honeypot).toBe(false);
		expect(h.simulation_success).toBe(true);
		expect(h.buy_tax).toBe(0);
		expect(h.sell_tax).toBe(0);
		expect(h.open_source).toBe(true);
		expect(h.is_proxy).toBe(false);
		expect(h.risk).toBe('low');
		expect(h.risk_level).toBe(1);
		expect(h.chain).toEqual({ id: '1', name: 'Ethereum', short: 'eth' });
		expect(h.token).toEqual({ name: 'Wrapped Ether', symbol: 'WETH', decimals: 18, holders: 3311580 });
		expect(h.pair_address).toBe('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640');
		expect(h.pair_liquidity_usd).toBeCloseTo(95423022.36, 1);
		expect(h.source).toBe('honeypot.is');
	});

	it('pins the deployment when chainId is given', async () => {
		global.fetch = vi.fn(async (url) => {
			expect(new URL(String(url)).searchParams.get('chainID')).toBe('8453');
			return jres({ ...WETH_REPORT, chain: { id: '8453', name: 'Base', shortName: 'base', currency: 'ETH' } });
		});
		const h = await fetchHoneypot(WETH, { chainId: 8453 });
		expect(h.chain.id).toBe('8453');
	});

	it('surfaces a honeypot verdict with its reason and flags', async () => {
		global.fetch = vi.fn(async () => jres({
			...WETH_REPORT,
			summary: { risk: 'honeypot', riskLevel: 100, flags: [{ flag: 'honeypot', severity: 'critical' }] },
			honeypotResult: { isHoneypot: true, honeypotReason: 'Unable to sell' },
			simulationResult: { buyTax: 0, sellTax: 100, transferTax: 0 },
		}));
		const h = await fetchHoneypot(WETH);
		expect(h.is_honeypot).toBe(true);
		expect(h.honeypot_reason).toBe('Unable to sell');
		expect(h.sell_tax).toBe(100);
		expect(h.flags).toContain('honeypot');
	});

	it('returns null on 404 (live: {"code":404,"error":"No pairs found"})', async () => {
		global.fetch = vi.fn(async () => jres({ code: 404, error: 'No pairs found' }, false, 404));
		expect(await fetchHoneypot(WETH)).toBeNull();
	});

	it('returns null on a malformed body', async () => {
		global.fetch = vi.fn(async () => jres({ something: 'else' }));
		expect(await fetchHoneypot(WETH)).toBeNull();
		global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
		expect(await fetchHoneypot(WETH)).toBeNull();
	});
});

describe('honeypotChainId', () => {
	it('maps the DexScreener slugs Honeypot.is can simulate', () => {
		expect(honeypotChainId('ethereum')).toBe(1);
		expect(honeypotChainId('bsc')).toBe(56);
		expect(honeypotChainId('base')).toBe(8453);
	});
	it('answers null for chains it cannot simulate', () => {
		expect(honeypotChainId('polygon')).toBeNull();
		expect(honeypotChainId('solana')).toBeNull();
		expect(honeypotChainId(null)).toBeNull();
	});
});

// ── fetchTokenMarket: honeypot attachment ────────────────────────────────────

function dexPair(chainId, extra = {}) {
	return {
		chainId,
		dexId: 'uniswap',
		url: 'https://dexscreener.com/x',
		pairAddress: '0xPAIR',
		baseToken: { address: WETH, name: 'Wrapped Ether', symbol: 'WETH' },
		quoteToken: { address: '0x0000000000000000000000000000000000000002', symbol: 'USDC' },
		priceUsd: '3600',
		priceChange: { h24: 1.2 },
		volume: { h24: 1000000 },
		liquidity: { usd: 95000000 },
		marketCap: 9000000000,
		txns: { h24: { buys: 500, sells: 400 } },
		pairCreatedAt: NOW - 400 * 86_400_000,
		...extra,
	};
}

describe('fetchTokenMarket honeypot wiring', () => {
	it('attaches the Honeypot.is report for an EVM address', async () => {
		global.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('dexscreener.com')) return jres({ pairs: [dexPair('ethereum')] });
			if (u.includes('api.honeypot.is')) return jres(WETH_REPORT);
			throw new Error(`unexpected url ${u}`);
		});
		const m = await fetchTokenMarket(WETH);
		expect(m.symbol).toBe('WETH');
		expect(m.honeypot).not.toBeNull();
		expect(m.honeypot.is_honeypot).toBe(false);
		expect(m.honeypot.chain.id).toBe('1');
	});

	it('re-pins to the resolved chain when unpinned detection misses (Base-native case)', async () => {
		// Verified live: auto-detection answers 404 for a Base-only deployment
		// and succeeds pinned with chainID=8453.
		const hpCalls = [];
		global.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('dexscreener.com')) return jres({ pairs: [dexPair('base')] });
			if (u.includes('api.honeypot.is')) {
				const chainID = new URL(u).searchParams.get('chainID');
				hpCalls.push(chainID);
				if (chainID === '8453') return jres({ ...WETH_REPORT, chain: { id: '8453', name: 'Base', shortName: 'base', currency: 'ETH' } });
				return jres({ code: 404, error: 'Token not found' }, false, 404);
			}
			throw new Error(`unexpected url ${u}`);
		});
		const m = await fetchTokenMarket(WETH);
		expect(hpCalls).toEqual([null, '8453']);
		expect(m.honeypot.chain.id).toBe('8453');
	});

	it('drops a sibling-deployment report when the resolved chain is not simulatable', async () => {
		global.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('dexscreener.com')) return jres({ pairs: [dexPair('polygon')] });
			if (u.includes('api.honeypot.is')) return jres(WETH_REPORT); // auto-detect found the Ethereum deployment
			throw new Error(`unexpected url ${u}`);
		});
		const m = await fetchTokenMarket(WETH);
		expect(m.chain).toBe('polygon');
		expect(m.honeypot).toBeNull();
	});

	it('never calls Honeypot.is for a Solana mint', async () => {
		global.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('api.honeypot.is')) throw new Error('honeypot must not be called for solana');
			if (u.includes('dexscreener.com')) {
				return jres({ pairs: [{ ...dexPair('solana'), baseToken: { address: THREE, name: 'three.ws', symbol: 'three' }, dexId: 'pumpswap' }] });
			}
			throw new Error(`unexpected url ${u}`);
		});
		const m = await fetchTokenMarket(THREE);
		expect(m.symbol).toBe('three');
		expect(m.honeypot).toBeNull();
		expect(global.fetch.mock.calls.every(([u]) => !String(u).includes('api.honeypot.is'))).toBe(true);
	});

	it('security: false opts out of the simulation entirely', async () => {
		global.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('api.honeypot.is')) throw new Error('honeypot must not be called when opted out');
			if (u.includes('dexscreener.com')) return jres({ pairs: [dexPair('ethereum')] });
			throw new Error(`unexpected url ${u}`);
		});
		const m = await fetchTokenMarket(WETH, { security: false });
		expect(m.honeypot).toBeNull();
	});

	it('a Honeypot.is outage fails soft: the market read still answers', async () => {
		global.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('api.honeypot.is')) throw new Error('ECONNRESET');
			if (u.includes('dexscreener.com')) return jres({ pairs: [dexPair('ethereum')] });
			throw new Error(`unexpected url ${u}`);
		});
		const m = await fetchTokenMarket(WETH);
		expect(m.price_usd).toBe(3600);
		expect(m.honeypot).toBeNull();
	});
});

// ── buildTokenRisk: the honeypot factor ──────────────────────────────────────

// A healthy market shape so only the honeypot factor moves the score.
const HEALTHY = {
	symbol: 'WETH',
	liquidity_usd: 95_000_000,
	market_cap_usd: 9_000_000_000,
	pair_created_at: NOW - 400 * 86_400_000,
	txns_24h: { buys: 500, sells: 400 },
};

describe('buildTokenRisk honeypot factor', () => {
	it('a failed sell simulation is critical and dominates the score', () => {
		const r = buildTokenRisk({ ...HEALTHY, honeypot: { is_honeypot: true, honeypot_reason: 'Unable to sell', simulation_success: true, buy_tax: 0, sell_tax: 100, transfer_tax: 0, open_source: true } }, NOW);
		const f = r.factors.find((x) => x.label === 'Honeypot');
		expect(f.status).toBe('critical');
		expect(f.detail).toContain('Unable to sell');
		expect(r.score).toBeGreaterThanOrEqual(55);
		expect(['high', 'critical']).toContain(r.level);
	});

	it('an incomplete simulation reads as unproven sellability (high)', () => {
		const r = buildTokenRisk({ ...HEALTHY, honeypot: { is_honeypot: null, simulation_success: false, buy_tax: null, sell_tax: null, transfer_tax: null, open_source: true } }, NOW);
		expect(r.factors.find((x) => x.label === 'Honeypot').status).toBe('high');
	});

	it('heavy taxes are flagged even when the sell passes', () => {
		const r = buildTokenRisk({ ...HEALTHY, honeypot: { is_honeypot: false, simulation_success: true, buy_tax: 2, sell_tax: 25, transfer_tax: 0, open_source: true } }, NOW);
		const f = r.factors.find((x) => x.label === 'Honeypot');
		expect(f.status).toBe('high');
		expect(f.detail).toContain('25%');
	});

	it('an unverified contract adds its own factor', () => {
		const r = buildTokenRisk({ ...HEALTHY, honeypot: { is_honeypot: false, simulation_success: true, buy_tax: 0, sell_tax: 0, transfer_tax: 0, open_source: false } }, NOW);
		expect(r.factors.find((x) => x.label === 'Contract').status).toBe('medium');
	});

	it('a clean simulation reads low and the level stays low', () => {
		const r = buildTokenRisk({ ...HEALTHY, honeypot: { is_honeypot: false, simulation_success: true, buy_tax: 0, sell_tax: 0, transfer_tax: 0, open_source: true } }, NOW);
		expect(r.factors.find((x) => x.label === 'Honeypot').status).toBe('low');
		expect(r.level).toBe('low');
	});

	it('no honeypot data (Solana / unavailable) leaves the read unchanged', () => {
		const r = buildTokenRisk({ ...HEALTHY, honeypot: null }, NOW);
		expect(r.factors.some((x) => x.label === 'Honeypot')).toBe(false);
		expect(r.factors.some((x) => x.label === 'Contract')).toBe(false);
	});
});
