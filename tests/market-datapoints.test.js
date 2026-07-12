// Datapoint fabric (/api/x402/d/…) — registry, parsing, extractor, and
// payment-boundary guards. All offline: extractors run against real-shaped
// fixture rows; the 402 checks drive the actual dynamic route with a fake res.

import { describe, it, expect } from 'vitest';

Object.assign(process.env, {
	APP_ORIGIN: 'https://three.ws',
	X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
	X402_PAY_TO_SOLANA: 'So11111111111111111111111111111111111111112',
	X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	X402_ASSET_MINT_SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	X402_ASSET_ADDRESS_ARBITRUM: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
	X402_MAX_AMOUNT_REQUIRED: '1000',
	X402_FEE_PAYER_SOLANA: 'So11111111111111111111111111111111111111112',
});

const {
	DATAPOINT_FAMILIES,
	DATAPOINT_DEFAULT_ATOMICS,
	datapointDescription,
	parseDatapointPath,
	datapointEndpointCount,
} = await import('../api/_lib/market-data/datapoints.js');

function expectThrow(fn, { status, code }) {
	let err;
	try {
		fn();
	} catch (e) {
		err = e;
	}
	expect(err, 'expected a throw').toBeTruthy();
	expect(err.status).toBe(status);
	expect(err.code).toBe(code);
}

// ── Registry invariants ─────────────────────────────────────────────────────
describe('datapoint registry', () => {
	it('spans hundreds of thousands of addressable endpoints', () => {
		expect(datapointEndpointCount()).toBeGreaterThan(300_000);
	});

	it('every family and metric carries complete listing metadata', () => {
		for (const [family, def] of Object.entries(DATAPOINT_FAMILIES)) {
			expect(family).toMatch(/^[a-z-]+$/);
			expect(typeof def.row).toBe('function');
			expect(def.approxCount).toBeGreaterThan(0);
			if (def.describeId != null) expect(typeof def.validateId).toBe('function');
			const metrics = Object.entries(def.metrics);
			expect(metrics.length, `${family} metrics`).toBeGreaterThanOrEqual(2);
			for (const [slug, metricDef] of metrics) {
				expect(slug, `${family}/${slug}`).toMatch(/^[a-z0-9-]+$/);
				expect(metricDef.label.length).toBeGreaterThan(3);
				expect(metricDef.unit.length).toBeGreaterThan(0);
				expect(typeof metricDef.extract).toBe('function');
				// Discovery-listing quality: descriptions must clear the ≥60-char
				// bar every other cataloged service meets.
				const description = datapointDescription({
					family,
					metric: slug,
					priceAtomics: DATAPOINT_DEFAULT_ATOMICS,
				});
				expect(description.length, `${family}/${slug} description`).toBeGreaterThanOrEqual(60);
			}
		}
	});
});

// ── Path parsing / payment boundary ─────────────────────────────────────────
describe('parseDatapointPath', () => {
	it('parses id-family and no-id-family paths', () => {
		const coin = parseDatapointPath(['coin', 'bitcoin', 'price']);
		expect(coin.family).toBe('coin');
		expect(coin.id).toBe('bitcoin');
		expect(coin.metric).toBe('price');
		const global = parseDatapointPath(['global', 'btc-dominance']);
		expect(global.id).toBeNull();
		expect(global.metric).toBe('btc-dominance');
	});

	it('url-decodes ids (chain names with spaces)', () => {
		const parsed = parseDatapointPath(['chain', 'Arbitrum%20Nova', 'tvl']);
		expect(parsed.id).toBe('Arbitrum Nova');
	});

	it('404s an unknown family, metric, or path shape — never a 402 for a non-resource', () => {
		expectThrow(() => parseDatapointPath(['weather', 'nyc', 'temp']), {
			status: 404,
			code: 'unknown_family',
		});
		expectThrow(() => parseDatapointPath(['coin', 'bitcoin', 'vibes']), {
			status: 404,
			code: 'unknown_metric',
		});
		expectThrow(() => parseDatapointPath(['coin', 'bitcoin']), { status: 404, code: 'bad_path' });
		expectThrow(() => parseDatapointPath(['global', 'x', 'btc-dominance']), {
			status: 404,
			code: 'bad_path',
		});
	});

	it('422s a malformed id per family', () => {
		expectThrow(() => parseDatapointPath(['coin', 'NOT A SLUG!', 'price']), {
			status: 422,
			code: 'invalid_id',
		});
		expectThrow(() => parseDatapointPath(['pool', 'not-a-uuid', 'apy']), {
			status: 422,
			code: 'invalid_id',
		});
		expectThrow(() => parseDatapointPath(['protocol', 'Bad Slug', 'tvl']), {
			status: 422,
			code: 'invalid_id',
		});
	});
});

// ── Extractors against real-shaped rows ─────────────────────────────────────
describe('metric extractors', () => {
	it('coin metrics read the buildCoinDetail shape', () => {
		const coin = {
			rank: 1,
			market: {
				price: 64346, market_cap: 1.2e12, fdv: 1.3e12, volume_24h: 3.8e10,
				change_pct: { h24: 1.42, d7: 4.87, d30: 9.1, y1: 55.2 },
				ath: 126789, ath_change_pct: -49.2, atl: 67.81,
				high_24h: 65000, low_24h: 63000,
				circulating: 19_700_000, total: 21_000_000, max: 21_000_000,
				mcap_fdv_ratio: 0.94,
			},
			sentiment: { up_pct: 82.5, watchlist_users: 1_600_000 },
		};
		const metrics = DATAPOINT_FAMILIES.coin.metrics;
		expect(metrics.price.extract(coin)).toBe(64346);
		expect(metrics['change-7d'].extract(coin)).toBe(4.87);
		expect(metrics['max-supply'].extract(coin)).toBe(21_000_000);
		expect(metrics['sentiment-up'].extract(coin)).toBe(82.5);
	});

	it('stablecoin peg deviation converts price to basis points', () => {
		const metrics = DATAPOINT_FAMILIES.stablecoin.metrics;
		expect(metrics['peg-deviation-bps'].extract({ price: 0.9992 })).toBe(-8);
		expect(metrics['peg-deviation-bps'].extract({ price: 1.0031 })).toBe(31);
		expect(metrics['peg-deviation-bps'].extract({ price: null })).toBeNull();
	});

	it('gas metrics read the buildGasReport tier order', () => {
		const gas = {
			base_fee_gwei: 0.077,
			eth_price_usd: 3251.7,
			tiers: [
				{ key: 'slow', gas_price_gwei: 0.08 },
				{ key: 'standard', gas_price_gwei: 0.1 },
				{ key: 'fast', gas_price_gwei: 0.15 },
			],
		};
		const metrics = DATAPOINT_FAMILIES.gas.metrics;
		expect(metrics.slow.extract(gas)).toBe(0.08);
		expect(metrics.standard.extract(gas)).toBe(0.1);
		expect(metrics.fast.extract(gas)).toBe(0.15);
		expect(metrics['eth-price'].extract(gas)).toBe(3251.7);
	});

	it('global dominance metrics read the failover shape', () => {
		const g = {
			market_cap_usd: 3.9e12, volume_24h_usd: 1.5e11,
			market_cap_change_pct_24h: 0.7, active_coins: 17505,
			dominance: [{ symbol: 'BTC', pct: 56.2 }, { symbol: 'ETH', pct: 12.1 }],
		};
		const metrics = DATAPOINT_FAMILIES.global.metrics;
		expect(metrics['btc-dominance'].extract(g)).toBe(56.2);
		expect(metrics['eth-dominance'].extract(g)).toBe(12.1);
		expect(metrics['active-coins'].extract(g)).toBe(17505);
	});
});

// ── New families: per-contract token, security, and the list families ───────
describe('token / security / list families', () => {
	const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

	it('token accepts Solana mints and EVM 0x addresses, rejects garbage', () => {
		expect(parseDatapointPath(['token', THREE, 'price']).family).toBe('token');
		expect(parseDatapointPath(['token', '0x' + 'a'.repeat(40), 'price']).id).toBe('0x' + 'a'.repeat(40));
		expectThrow(() => parseDatapointPath(['token', 'not an address', 'price']), {
			status: 422,
			code: 'invalid_id',
		});
	});

	it('token-security is Solana-only', () => {
		expect(parseDatapointPath(['token-security', THREE, 'risk-level']).metric).toBe('risk-level');
		expectThrow(() => parseDatapointPath(['token-security', '0x' + 'a'.repeat(40), 'risk-level']), {
			status: 422,
			code: 'invalid_id',
		});
	});

	it('token metrics read the composeTokenSnapshot shape', () => {
		const snap = {
			priceUsd: 0.0017, change24h: -4.2, marketCapUsd: 1_700_000, fdvUsd: 2_000_000,
			liquidityUsd: 212_000, volume24hUsd: 90_000, name: 'Three', symbol: 'THREE',
			chain: 'solana', dexId: 'pumpswap',
		};
		const mx = DATAPOINT_FAMILIES.token.metrics;
		expect(mx.price.extract(snap)).toBe(0.0017);
		expect(mx.liquidity.extract(snap)).toBe(212_000);
		expect(mx.symbol.extract(snap)).toBe('THREE');
		expect(mx.dex.extract(snap)).toBe('pumpswap');
	});

	it('token-security metrics read the composeTokenSecurity shape', () => {
		const row = {
			riskLevel: 'medium',
			checks: {
				mintAuthorityRevoked: true, freezeAuthorityRevoked: false, metadataMutable: true,
				liquidityUsd: 8_000, topHolderPctFlag: true,
			},
		};
		const mx = DATAPOINT_FAMILIES['token-security'].metrics;
		expect(mx['risk-level'].extract(row)).toBe('medium');
		expect(mx['mint-authority-revoked'].extract(row)).toBe(true);
		expect(mx['freeze-authority-revoked'].extract(row)).toBe(false);
		expect(mx['liquidity-usd'].extract(row)).toBe(8_000);
		expect(mx['holders-concentrated'].extract(row)).toBe(true);
	});

	it('list-family extractors read their builder shapes', () => {
		expect(DATAPOINT_FAMILIES.category.metrics['market-cap'].extract({ market_cap: 1e12 })).toBe(1e12);
		expect(DATAPOINT_FAMILIES.dex.metrics['volume-24h'].extract({ total24h: 5e9 })).toBe(5e9);
		expect(DATAPOINT_FAMILIES.fees.metrics['revenue-24h'].extract({ revenue: { total24h: 68_630 } })).toBe(68_630);
		expect(DATAPOINT_FAMILIES.fees.metrics['revenue-24h'].extract({ revenue: null })).toBeNull();
		expect(
			DATAPOINT_FAMILIES['derivative-exchange'].metrics['open-interest-btc'].extract({ open_interest_btc: 369_801 }),
		).toBe(369_801);
	});
});

// ── Live 402 boundary on the dynamic route ──────────────────────────────────
function fakeRes() {
	return {
		statusCode: 0,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(body) {
			this.body = body;
			this.writableEnded = true;
		},
	};
}

const route = (await import('../api/x402/d/[...path].js')).default;

async function drive(url) {
	const res = fakeRes();
	await route({ method: 'GET', url, headers: { host: 'three.ws' } }, res);
	return res;
}

describe('dynamic datapoint route', () => {
	it('issues a 402 whose resource URL is the concrete datapoint', async () => {
		const res = await drive('/api/x402/d/global/btc-dominance');
		expect(res.statusCode).toBe(402);
		const body = JSON.parse(res.body);
		expect(body.resource.url).toBe('https://three.ws/api/x402/d/global/btc-dominance');
		const usdc = body.accepts.filter((a) =>
			[process.env.X402_ASSET_MINT_SOLANA, process.env.X402_ASSET_ADDRESS_BASE].includes(a.asset),
		);
		expect(usdc.length).toBeGreaterThan(0);
		expect(usdc.every((a) => (a.amount ?? a.maxAmountRequired) === DATAPOINT_DEFAULT_ATOMICS)).toBe(true);
	});

	it('two ids of one (family, metric) advertise their own resource URLs', async () => {
		const a = JSON.parse((await drive('/api/x402/d/coin/bitcoin/price')).body);
		const b = JSON.parse((await drive('/api/x402/d/coin/ethereum/price')).body);
		expect(a.resource.url).toContain('/coin/bitcoin/price');
		expect(b.resource.url).toContain('/coin/ethereum/price');
	});

	it('404s garbage paths without issuing a payment challenge', async () => {
		const res = await drive('/api/x402/d/weather/nyc/temp');
		expect(res.statusCode).toBe(404);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('unknown_family');
		expect(body.catalog).toBe('/api/x402/d');
	});

	it('422s a malformed id before payment', async () => {
		const res = await drive('/api/x402/d/pool/not-a-uuid/apy');
		expect(res.statusCode).toBe(422);
		expect(JSON.parse(res.body).error).toBe('invalid_id');
	});
});
