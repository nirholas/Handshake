// GET /api/ca2x402/resolve: the free resolver behind the CA to x402 tool.
//
// The load-bearing property here is that `service.endpoint` (and therefore every
// copy-paste snippet a visitor is invited to run and PAY for) is anchored on
// env.APP_ORIGIN, never on the caller-controlled `host` / `x-forwarded-host`
// headers. Before this was pinned, `curl -H 'x-forwarded-host: evil.example.com'`
// came back advertising an attacker-owned 402 challenge, and because the 200 is
// CDN-cacheable that poisoned copy could be served on to other visitors.
//
// DexScreener is the only upstream, stubbed here so the suite stays offline and
// deterministic. The validation paths below never reach it at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// One deepest-liquidity Solana pair, shaped exactly like a DexScreener
// /latest/dex/tokens/<addr> response.
const DEX_PAIR = {
	chainId: 'solana',
	dexId: 'pumpswap',
	url: 'https://dexscreener.com/solana/5byl7mzolabynwmpzkpkjf4mgkz7febzranos19pre2z',
	pairAddress: '5byl7mzolabynwmpzkpkjf4mgkz7febzranos19pre2z',
	baseToken: { address: MINT, symbol: 'three', name: 'three.ws' },
	quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Wrapped SOL' },
	info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/j22gRd6Z2GowwOvM' },
	priceUsd: '0.001517',
	priceChange: { m5: 0.09, h1: 1.31, h6: -5.68, h24: -13.61 },
	marketCap: 1516533,
	fdv: 1516533,
	liquidity: { usd: 213949.3 },
	volume: { h24: 113187.16 },
	pairCreatedAt: 1_760_000_000_000,
	txns: { h24: { buys: 720, sells: 280 } },
};

let dexBody = { pairs: [DEX_PAIR] };
let dexOk = true;

vi.stubGlobal('fetch', (url) => {
	const u = String(url);
	if (u.startsWith('https://api.dexscreener.com/')) {
		return Promise.resolve({ ok: dexOk, status: dexOk ? 200 : 502, json: async () => dexBody });
	}
	throw new Error(`Unexpected upstream fetch: ${u}`);
});

const { default: handler } = await import('../../api/ca2x402/resolve.js');
const { env } = await import('../../api/_lib/env.js');

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		headersSent: false,
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

let ip = 0;

async function call({ method = 'GET', query = '', headers = {} } = {}) {
	const res = mkRes();
	// A fresh client IP per call so the public rate limiter never colours a case.
	ip += 1;
	await handler(
		{
			method,
			url: `/api/ca2x402/resolve${query}`,
			headers: { 'x-forwarded-for': `203.0.113.${ip % 254}`, ...headers },
			socket: { remoteAddress: `203.0.113.${ip % 254}` },
		},
		res,
	);
	return res;
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

beforeEach(() => {
	dexBody = { pairs: [DEX_PAIR] };
	dexOk = true;
});

describe('GET /api/ca2x402/resolve', () => {
	it('resolves a live token into its identity plus the generated x402 service', async () => {
		const res = await call({ query: `?mint=${MINT}` });
		expect(res.statusCode).toBe(200);

		const body = parse(res);
		expect(body.ok).toBe(true);
		expect(body.token.mint).toBe(MINT);
		expect(body.token.symbol).toBe('three');
		expect(body.token.chain).toBe('solana');
		expect(body.token.price_usd).toBe(0.001517);
		expect(body.token.signal).toBeTruthy();
		expect(body.token.risk.level).toBeTruthy();

		expect(body.service.method).toBe('GET');
		expect(body.service.asset).toBe('USDC');
		expect(body.service.networks).toEqual(['solana', 'base']);
		expect(body.service.price_usd).toBeGreaterThan(0);
		expect(body.service.output_schema).toBeTruthy();
		expect(res.headers['cache-control']).toContain('max-age=20');
	});

	it('anchors the advertised endpoint and every paid snippet on APP_ORIGIN, not on the request host', async () => {
		const res = await call({
			query: `?mint=${MINT}`,
			headers: { host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'http' },
		});
		expect(res.statusCode).toBe(200);

		const { service } = parse(res);
		const expected = `${env.APP_ORIGIN}/api/x402/token-intel?mint=${MINT}`;
		expect(service.endpoint).toBe(expected);

		for (const snippet of Object.values(service.snippets)) {
			expect(snippet).toContain(expected);
			expect(snippet).not.toContain('evil.example.com');
		}
	});

	it('answers a well-formed address with no market with a designed, uncacheable 404', async () => {
		dexBody = { pairs: [] };
		const res = await call({ query: '?mint=THREEsynthetic1111111111111111111111111111' });
		expect(res.statusCode).toBe(404);

		const body = parse(res);
		expect(body.ok).toBe(false);
		expect(body.error).toBe('token_not_found');
		expect(body.chain).toBe('solana');
		expect(res.headers['cache-control']).toBe('no-store');
	});

	it('keeps answering from the remembered payload when DexScreener itself is failing', async () => {
		// A throttled DexScreener used to make a live token read as "not found"
		// here, which 503'd the paid token-intel service downstream. The market
		// read now falls back to the last payload it saw for this mint, so a blip
		// costs a few minutes of staleness instead of denying a real token.
		const warm = await call({ query: `?mint=${MINT}` });
		expect(warm.statusCode).toBe(200);
		dexOk = false;
		const res = await call({ query: `?mint=${MINT}` });
		expect(res.statusCode).toBe(200);
		expect(parse(res).ok).toBe(true);
	});

	it('says the indexer is unreachable, not "not found", for a mint it has never seen', async () => {
		// Nothing remembered for this mint and the indexer is down, so there is no
		// honest answer at all. Reporting the designed 404 here would tell someone
		// their real token does not exist, which is exactly the claim the
		// remembered-payload tier was added to stop making: it only ever helped a
		// warm instance, and a cold one denied every token.
		dexOk = false;
		const res = await call({ query: '?mint=THREEsyntheticNeverSeen11111111111111111111' });
		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('market_unavailable');
		expect(res.headers['retry-after']).toBeTruthy();
	});

	it('keeps the designed 404 when the indexer answers and the token genuinely has no market', async () => {
		// The other half of the distinction: a reachable indexer reporting no
		// pairs is a real answer about the caller's address, not an outage.
		dexBody = { pairs: [] };
		const res = await call({ query: '?mint=THREEsyntheticNeverSeen22222222222222222222' });
		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('token_not_found');
	});

	it('rejects a missing mint with 400 and a malformed one with 422', async () => {
		const missing = await call();
		expect(missing.statusCode).toBe(400);
		expect(parse(missing).error).toBe('missing_mint');

		const blank = await call({ query: '?mint=' });
		expect(blank.statusCode).toBe(400);

		const bad = await call({ query: '?mint=notanaddress' });
		expect(bad.statusCode).toBe(422);
		expect(parse(bad).error).toBe('invalid_mint');
	});

	it('rejects writes with 405 and short-circuits a CORS preflight', async () => {
		const post = await call({ method: 'POST' });
		expect(post.statusCode).toBe(405);
		expect(parse(post).error).toBe('method_not_allowed');

		const preflight = await call({ method: 'OPTIONS', headers: { origin: 'https://example.com' } });
		expect(preflight.statusCode).toBe(204);
		expect(preflight.headers['access-control-allow-origin']).toBe('*');
		expect(preflight.headers['access-control-allow-methods']).toBe('GET,OPTIONS');
	});
});
