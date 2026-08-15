// Input-boundary tests for the pump read endpoints that answer a caller mistake
// with the wrong thing.
//
//   GET /api/pump/intel        a typo'd mint / view / minQuality used to come back
//                              as `degraded: true` or as a silently-substituted
//                              feed, i.e. the dashboard blamed the engine for the
//                              caller's typo and the caller never learned.
//   GET /api/pump/dashboard    a non-UUID agent_id reached a uuid-typed column and
//                              Postgres 500'd on it.
//   GET /api/pump/helius-stats a probe against a non-Helius RPC was labelled
//                              `endpoint: 'helius-rpc'`, and a failed probe was
//                              reported as a bare `slot: null` with no reason.
//
// The DB and the RPC are the seams these handlers own, so those are stubbed. All
// the validation, labelling, and error-boundary logic runs for real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	sqlValues: () => '',
	isDbUnavailableError: () => false,
}));

const getSessionUserMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
}));

vi.mock('../api/_lib/pumpfun-ws-feed.js', () => ({ recentBuffered: () => [] }));
vi.mock('../api/_lib/sol-price.js', () => ({
	solPriceUsd: async () => 76,
	solPriceInfo: () => ({ stale: false }),
	solChange24hPct: async () => 0.5,
}));

const { default: intelHandler } = await import('../api/pump/intel.js');
const { default: dashboardHandler } = await import('../api/pump/dashboard.js');
const { default: heliusHandler, resolveProbeTarget, _resetHeliusCache } =
	await import('../api/pump/helius-stats.js');

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function mkReq({ method = 'GET', url = '/', headers = {} } = {}) {
	return { method, url, headers: { host: 'three.ws', ...headers }, socket: {}, on() {}, destroy() {} };
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const read = (res) => (res.body ? JSON.parse(res.body) : undefined);

async function callIntel(query) {
	const res = mkRes();
	await intelHandler(mkReq({ url: `/api/pump/intel${query}` }), res);
	return { res, body: read(res) };
}

beforeEach(() => {
	sqlMock.mockReset();
	getSessionUserMock.mockReset();
	vi.unstubAllGlobals();
});

describe('GET /api/pump/intel input boundaries', () => {
	it('400s a malformed mint instead of reporting "no such coin"', async () => {
		const { res, body } = await callIntel('?mint=notbase58');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_mint');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('400s a non-integer minQuality instead of blaming the engine', async () => {
		// The old path forwarded NaN into `${minQuality}::int`, Postgres threw, and
		// the catch-all answered 200 `degraded: true` — an outage report for a typo.
		const { res, body } = await callIntel('?view=feed&minQuality=abc');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_min_quality');
		expect(body.degraded).toBeUndefined();
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('400s a minQuality outside the 0..100 score range', async () => {
		expect((await callIntel('?view=feed&minQuality=-1')).res.statusCode).toBe(400);
		expect((await callIntel('?view=feed&minQuality=101')).res.statusCode).toBe(400);
	});

	it('400s an unknown view rather than quietly serving the feed under its name', async () => {
		const { res, body } = await callIntel('?view=bogusview');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_view');
		expect(body.view).toBeUndefined(); // the caller's string is not echoed back
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('still serves the default feed, a known view, and a valid minQuality', async () => {
		sqlMock.mockResolvedValue([]);
		for (const q of ['', '?view=feed', '?view=learning', '?view=traders', '?view=feed&minQuality=70']) {
			const { res } = await callIntel(q);
			expect(res.statusCode, `view query ${q || '(none)'}`).toBe(200);
		}
	});

	it('still degrades to 200 when the engine tables are genuinely missing', async () => {
		sqlMock.mockRejectedValue(new Error('relation "pump_coin_intel" does not exist'));
		const { res, body } = await callIntel('?view=feed');
		expect(res.statusCode).toBe(200);
		expect(body.degraded).toBe(true);
		expect(body.reason).toBe('engine_tables_pending');
	});
});

describe('GET /api/pump/dashboard input boundaries', () => {
	it('400s a non-UUID agent_id instead of 500ing on the uuid column', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		const res = mkRes();
		await dashboardHandler(mkReq({ url: '/api/pump/dashboard?agent_id=not-a-uuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(read(res).error).toBe('invalid_agent_id');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('still 401s before it ever looks at the query', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = mkRes();
		await dashboardHandler(mkReq({ url: '/api/pump/dashboard?agent_id=not-a-uuid' }), res);
		expect(res.statusCode).toBe(401);
	});

	it('still 404s a well-formed id that is not the caller\'s agent', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlMock.mockResolvedValue([]);
		const res = mkRes();
		await dashboardHandler(
			mkReq({ url: '/api/pump/dashboard?agent_id=00000000-0000-4000-8000-000000000000' }),
			res,
		);
		expect(res.statusCode).toBe(404);
		expect(read(res).error).toBe('not_found');
	});
});

describe('helius-stats probe target', () => {
	it('probes the configured RPC when it really is Helius', () => {
		const t = resolveProbeTarget({ SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=k' });
		expect(t.url).toContain('helius-rpc.com');
		expect(t.endpoint).toBe('helius-rpc');
	});

	it('probes Helius itself when the key is set but SOLANA_RPC_URL points elsewhere', () => {
		// Production runs exactly this shape. Labelling the other provider
		// "helius-rpc" is what made a third-party 403 read as a quiet chain.
		const t = resolveProbeTarget({
			HELIUS_API_KEY: 'abc',
			SOLANA_RPC_URL: 'https://rpc.example-provider.app/mainnet',
		});
		expect(t.url).toBe('https://mainnet.helius-rpc.com/?api-key=abc');
		expect(t.endpoint).toBe('helius-rpc');
	});

	it('claims no Helius endpoint when there is no key and no Helius URL', () => {
		expect(resolveProbeTarget({ SOLANA_RPC_URL: 'https://rpc.example-provider.app/mainnet' }))
			.toEqual({ url: '', endpoint: null });
		expect(resolveProbeTarget({})).toEqual({ url: '', endpoint: null });
	});
});

describe('GET /api/pump/helius-stats probe reporting', () => {
	const call = async () => {
		_resetHeliusCache(); // the 4s probe cache would otherwise answer the next case
		const res = mkRes();
		await heliusHandler(mkReq({ url: '/api/pump/helius-stats' }), res);
		return read(res);
	};

	it('names the HTTP status when the RPC rejects the key', async () => {
		// A rejected key answers with a plain-text body, so r.json() throws and the
		// failure used to be filed as a generic "unreachable".
		vi.stubEnv('HELIUS_API_KEY', 'dead-key');
		vi.stubEnv('SOLANA_RPC_URL', '');
		vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));
		const body = await call();
		expect(body.helius.error).toBe('http_401');
		expect(body.helius.slot).toBeNull();
	});

	it('surfaces a JSON-RPC error body rather than a bare null slot', async () => {
		vi.stubEnv('HELIUS_API_KEY', 'k2');
		vi.stubEnv('SOLANA_RPC_URL', '');
		vi.stubGlobal('fetch', vi.fn(async () => new Response(
			JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 403, message: 'IP blocked' } }),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)));
		const body = await call();
		expect(body.helius.error).toBe('IP blocked');
		expect(body.helius.slot).toBeNull();
	});

	it('reports the live slot with no error when the probe succeeds', async () => {
		vi.stubEnv('HELIUS_API_KEY', 'k3');
		vi.stubEnv('SOLANA_RPC_URL', '');
		vi.stubGlobal('fetch', vi.fn(async () => new Response(
			JSON.stringify({ jsonrpc: '2.0', id: 1, result: 372_004_112 }),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)));
		const body = await call();
		expect(body.helius).toMatchObject({ enabled: true, slot: 372_004_112, endpoint: 'helius-rpc' });
		expect(body.helius.error).toBeUndefined();
	});

	it('reports helius disabled, and never a stale slot, with nothing configured', async () => {
		vi.stubEnv('HELIUS_API_KEY', '');
		vi.stubEnv('SOLANA_RPC_URL', '');
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const body = await call();
		expect(body.helius).toEqual({ enabled: false });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(body.sol_price).toBe(76);
	});
});

describe('GET /api/pump/intel?view=feed filters reach past page one', () => {
	// A row shaped so deriveVerdict() lands on `key`. quality_score alone decides
	// it once risk_flags is empty.
	const coinRow = (i, quality) => ({
		mint: `M${i}`, network: 'mainnet', symbol: `S${i}`, name: `name ${i}`,
		quality_score: quality, risk_flags: [], signals: {},
		first_seen_at: '2026-08-01T00:00:00.000Z',
	});

	it('scans deeper than the page when verdict (a JS-derived filter) is set', async () => {
		// 79 "avoid" rows followed by 12 "strong" ones. Scanning only the requested
		// 10 would answer with zero strong coins while 12 sit just past the cursor,
		// which reads as "the engine found nothing".
		const rows = [
			...Array.from({ length: 79 }, (_, i) => coinRow(i, 10)),
			...Array.from({ length: 12 }, (_, i) => coinRow(100 + i, 90)),
		];
		let sqlParams = null;
		sqlMock.mockImplementation((_statics, ...params) => {
			sqlParams = params;
			return Promise.resolve(rows);
		});
		const { res, body } = await callIntel('?view=feed&verdict=strong&limit=10');
		expect(res.statusCode).toBe(200);
		// limit is the last bound param: 8x the page when a JS filter is active.
		expect(sqlParams.at(-1)).toBe(80);
		// …and the page the caller asked for is still the page they get back.
		expect(body.coins).toHaveLength(10);
		expect(body.coins.every((c) => c.verdict.key === 'strong')).toBe(true);
	});

	it('scans exactly one page when no JS-derived filter is set', async () => {
		let sqlParams = null;
		sqlMock.mockImplementation((_statics, ...params) => {
			sqlParams = params;
			return Promise.resolve([]);
		});
		await callIntel('?view=feed&limit=10');
		expect(sqlParams.at(-1)).toBe(10);
	});

	it('pushes the text search into SQL instead of filtering the newest page', async () => {
		// The JS post-filter searched only the rows already fetched, so a coin that
		// matched but sat past the cursor was invisible to search.
		let sqlText = '';
		let sqlParams = null;
		sqlMock.mockImplementation((statics, ...params) => {
			sqlText = statics.join('?');
			sqlParams = params;
			return Promise.resolve([coinRow(1, 60)]);
		});
		const { body } = await callIntel('?view=feed&q=wolf&limit=25');
		expect(sqlText).toContain('ilike');
		expect(sqlParams).toContain('%wolf%');
		expect(sqlParams.at(-1)).toBe(25); // no over-fetch: ilike is a real WHERE
		// The row the DB returned is served as-is; nothing re-filters it in JS.
		expect(body.coins).toHaveLength(1);
	});

	it('escapes LIKE metacharacters so "100%" and "a_b" stay literal', async () => {
		let sqlParams = null;
		sqlMock.mockImplementation((_statics, ...params) => {
			sqlParams = params;
			return Promise.resolve([]);
		});
		await callIntel('?view=feed&q=100%25');
		expect(sqlParams).toContain('%100\\%%');
		await callIntel('?view=feed&q=a_b');
		expect(sqlParams).toContain('%a\\_b%');
	});
});

describe('/api/pump/intel still reads real intel rows', () => {
	it('shapes a coin row into the documented record, verdict included', async () => {
		sqlMock.mockImplementation((statics) => {
			const text = Array.isArray(statics) ? statics.join(' ') : String(statics);
			if (text.includes('pump_coin_intel')) {
				return Promise.resolve([{
					mint: MINT, network: 'mainnet', symbol: 'THREE', name: 'three.ws',
					quality_score: 80, risk_flags: [], organic_score: 0.9, signals: {},
					first_seen_at: '2026-08-01T00:00:00.000Z',
				}]);
			}
			return Promise.resolve([]);
		});
		const { res, body } = await callIntel(`?mint=${MINT}`);
		expect(res.statusCode).toBe(200);
		expect(body.found).toBe(true);
		expect(body.coin.symbol).toBe('THREE');
		expect(body.coin.verdict.key).toBe('strong');
	});
});
