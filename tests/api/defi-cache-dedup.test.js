// The api/defi/ builders must collapse a burst of concurrent cold requests into
// ONE upstream call.
//
// Every handler under api/defi/ proxies a DeFiLlama feed and caches the shaped
// result in memory. Before this guard, only yields.js de-duplicated concurrent
// misses; the rest checked "is the cache warm?" and, if not, each request fired
// its own fetch. Measured against a local server, 10 concurrent cold requests
// to /api/defi/dex-volumes issued 10 upstream fetches of the same ~2 MB payload
// (the /protocols feed behind /api/defi/protocols and every chain profile is
// ~8 MB). That is the classic cache stampede: it multiplies egress by the
// concurrency, and it arrives in bursts precisely when the entry expires under
// load, which is when the upstream is least willing to absorb it. A refused
// burst surfaces to users as a 502 on a page that has perfectly good data.
//
// The rules under test, per builder:
//   1. N concurrent cold calls issue exactly one upstream fetch and every
//      caller gets the same shaped value.
//   2. A warm cache issues no further fetches.
//   3. A FAILED load is never cached: the next call retries the upstream. A
//      cached rejection would pin an endpoint to a transient outage for the
//      whole TTL.
//
// The upstream HTTP boundary is stubbed here (that is the only external
// dependency); everything below it is the real shipped code path.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFI_DIR = fileURLToPath(new URL('../../api/defi', import.meta.url));

const reply = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Fixture payloads shaped like the real DeFiLlama responses, trimmed to the
// fields each builder reads.
const FIXTURES = {
	protocols: [
		{ name: 'Alpha', slug: 'alpha', tvl: 1_000, category: 'Dexes', chains: ['Solana'], symbol: 'AL' },
		{ name: 'Custody', slug: 'custody', tvl: 9_000_000, category: 'CEX', chains: ['Solana'] },
	],
	chains: [
		{ name: 'Solana', tvl: 500, tokenSymbol: 'SOL', chainId: null },
		{ name: 'Examplechain', tvl: 1_500, tokenSymbol: 'EXC', chainId: 1 },
	],
	dexs: {
		total24h: 42,
		total7d: 99,
		change_7dover7d: 1.5,
		totalDataChart: [[1_700_000_000, 42]],
		protocols: [{ name: 'Alpha', displayName: 'Alpha', slug: 'alpha', total24h: 42, chains: ['Solana'] }],
	},
	fees: {
		total24h: 7,
		total7d: 21,
		total30d: 90,
		change_1d: -1,
		totalDataChart: [[1_700_000_000, 7]],
		protocols: [{ name: 'Alpha', displayName: 'Alpha', slug: 'alpha', total24h: 7, chains: ['Solana'] }],
	},
	stablecoins: {
		peggedAssets: [
			{
				id: 1,
				name: 'Example USD',
				symbol: 'EXUSD',
				pegType: 'peggedUSD',
				pegMechanism: 'fiat-backed',
				price: 1,
				circulating: { peggedUSD: 1_000 },
				chains: ['Solana'],
			},
		],
	},
	hacks: [{ date: 1_700_000_000, name: 'Bridge exploit', amount: 100, bridgeHack: true, chain: ['Solana'] }],
	yields: {
		data: [
			{
				pool: '747c1d2a-c668-4682-b9f9-296708a3dd90',
				chain: 'Solana',
				project: 'alpha',
				symbol: 'SOL-EXUSD',
				tvlUsd: 50_000,
				apy: 5,
			},
		],
	},
};

// Each case names the module, the exported builder, and the payload its single
// upstream call answers with.
const CASES = [
	{ file: 'protocols', build: (m) => m.buildProtocols(), payload: FIXTURES.protocols },
	{ file: 'chains', build: (m) => m.buildChains(), payload: FIXTURES.chains },
	{ file: 'dex-volumes', build: (m) => m.buildDexVolumes(), payload: FIXTURES.dexs },
	{ file: 'fees', build: (m) => m.buildFees('fees'), payload: FIXTURES.fees },
	{ file: 'stablecoins', build: (m) => m.buildStablecoins(), payload: FIXTURES.stablecoins },
	{ file: 'hacks', build: (m) => m.queryHacks({}), payload: FIXTURES.hacks },
	{ file: 'yields', build: (m) => m.queryYieldPools({}), payload: FIXTURES.yields },
];

// Module-scope caches persist for the life of a module instance, so every test
// re-imports its subject to start from a genuinely cold cache. The `.js` stays
// in the static part of the specifier so vite can resolve the candidate set.
async function coldImport(name) {
	vi.resetModules();
	return import(`../../api/defi/${name}.js`);
}

afterEach(() => vi.unstubAllGlobals());

describe('api/defi builders de-duplicate concurrent cold loads', () => {
	for (const { file, build, payload } of CASES) {
		it(`${file}: 10 concurrent cold calls issue one upstream fetch`, async () => {
			const fetchMock = vi.fn(async () => reply(payload));
			vi.stubGlobal('fetch', fetchMock);

			const mod = await coldImport(file);
			const results = await Promise.all(Array.from({ length: 10 }, () => build(mod)));

			expect(fetchMock).toHaveBeenCalledTimes(1);
			// Every caller gets the same resolved value, not a partial or a copy
			// built from a second round trip.
			for (const r of results) expect(r).toEqual(results[0]);
		});

		it(`${file}: a warm cache issues no further fetches`, async () => {
			const fetchMock = vi.fn(async () => reply(payload));
			vi.stubGlobal('fetch', fetchMock);

			const mod = await coldImport(file);
			await build(mod);
			expect(fetchMock).toHaveBeenCalledTimes(1);

			await build(mod);
			await build(mod);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it(`${file}: a failed load is not cached and the next call retries`, async () => {
			// The upstream stays down for the whole call, not just its first round
			// trip: fetchUpstream retries a transient 503 on its own now, so a
			// single blip followed by a good body is a SUCCESS by design and would
			// never reach the caller as an error. What must still hold is that the
			// failure itself is never cached.
			let down = true;
			const fetchMock = vi.fn(async () => (down ? reply({ error: 'upstream down' }, 503) : reply(payload)));
			vi.stubGlobal('fetch', fetchMock);

			const mod = await coldImport(file);
			await expect(build(mod)).rejects.toThrow();
			const afterFailure = fetchMock.mock.calls.length;
			expect(afterFailure).toBeGreaterThan(0);

			// The next call must reach the upstream again rather than replay the
			// failure from cache for the rest of the TTL.
			down = false;
			const recovered = await build(mod);
			expect(recovered).toBeTruthy();
			expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFailure);
		});
	}

	it('fees.js caches the fees and revenue series independently', async () => {
		const seen = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				seen.push(String(input));
				return reply(FIXTURES.fees);
			}),
		);

		const mod = await coldImport('fees');
		const [fees, revenue] = await Promise.all([mod.buildFees('fees'), mod.buildFees('revenue')]);

		expect(seen).toHaveLength(2);
		expect(seen.some((u) => u.includes('dailyFees'))).toBe(true);
		expect(seen.some((u) => u.includes('dailyRevenue'))).toBe(true);
		expect(fees.type).toBe('fees');
		expect(revenue.type).toBe('revenue');

		// An unrecognized type is the fees series, and shares the fees cache slot
		// rather than opening a third one.
		await mod.buildFees('nonsense');
		expect(seen).toHaveLength(2);
	});

	it('chain.js shares one protocols feed across different chain profiles', async () => {
		const seen = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input) => {
				const url = String(input);
				seen.push(url);
				if (url.includes('/v2/chains')) return reply(FIXTURES.chains);
				if (url.endsWith('/protocols')) return reply(FIXTURES.protocols);
				if (url.includes('historicalChainTvl')) return reply([{ date: 1_700_000_000, tvl: 500 }]);
				// The remaining feeds are best-effort; an absent one must not fail the
				// profile, so answer them as upstream does for a chain with no coverage.
				return reply({}, 404);
			}),
		);

		const mod = await coldImport('chain');
		const handler = mod.default;
		await Promise.all([invoke(handler, '/api/defi/chain?name=Solana'), invoke(handler, '/api/defi/chain?name=Examplechain')]);

		// Two distinct chain profiles, but the ~8 MB protocols feed is fetched once.
		const protocolsCalls = seen.filter((u) => u.endsWith('/protocols'));
		expect(protocolsCalls).toHaveLength(1);
	});
});

describe('api/defi pool rows carry a readable symbol', () => {
	it('falls back to a real label when upstream omits the symbol', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				reply({ data: [{ pool: 'b1e5f0a2-0000-4000-8000-000000000001', chain: 'Solana', project: 'alpha', tvlUsd: 1 }] }),
			),
		);

		const mod = await coldImport('yields');
		const { pools } = await mod.queryYieldPools({});

		// This value renders verbatim as the pool's name on /yields, so it must be
		// a word, not a punctuation glyph standing in for one.
		expect(pools[0].symbol).toBe('Unknown');
	});
});

describe('api/defi honors the dash ban', () => {
	// Written as escapes on purpose: spelling the two glyphs literally would put
	// them in this file and make the repo-wide rule check fail on its own guard.
	const BANNED_DASH = new RegExp('[\\u2014\\u2013]');

	it('contains no em-dash or en-dash characters', () => {
		const offenders = [];
		for (const name of readdirSync(DEFI_DIR)) {
			if (!name.endsWith('.js') && !name.endsWith('.md')) continue;
			const src = readFileSync(join(DEFI_DIR, name), 'utf8');
			src.split('\n').forEach((line, i) => {
				if (BANNED_DASH.test(line)) offenders.push(`api/defi/${name}:${i + 1}`);
			});
		}
		expect(offenders).toEqual([]);
	});
});

// Minimal request/response pair for driving a handler's default export, matching
// the node-style (req, res) contract the api/ handlers are written against.
async function invoke(handler, url) {
	const chunks = [];
	const res = {
		statusCode: 200,
		headers: {},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		removeHeader(k) {
			delete this.headers[k.toLowerCase()];
		},
		writeHead(status, headers) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
			return this;
		},
		write(chunk) {
			chunks.push(chunk);
			return true;
		},
		end(chunk) {
			if (chunk) chunks.push(chunk);
			return this;
		},
	};
	await handler({ method: 'GET', url, headers: { host: 'three.ws' }, socket: {} }, res);
	return { status: res.statusCode, body: chunks.join('') };
}
