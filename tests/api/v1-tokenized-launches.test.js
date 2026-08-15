// GET /api/v1/tokenized/launches - the free, paginated directory of 3D assets
// minted as Metaplex Core NFTs THROUGH three.ws (the NFT analogue of
// /api/v1/pump/launches).
//
// The SQL lives in api/_lib/tokenized-launches.js `queryTokenizedLaunches` and
// is shared with api/creations-leaderboard.js, so it is mocked at the module
// boundary here: these tests pin the handler's OWN contract, which is the part
// a caller sees. Namely that it clamps and normalizes pagination before the
// query ever runs (a scripted crawler cannot ask for 9999 rows or a negative
// offset), rejects a malformed agent_id with a 400 instead of handing a junk
// value to Postgres, enforces the per-IP quota, and surfaces a database outage
// as an honest 503 rather than an empty-looking "no launches yet" page.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

let quotaOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1: async () => ({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }),
		publicIp: async () =>
			quotaOk
				? { success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }
				: { success: false, limit: 60, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.21',
}));

let queryImpl = async () => ({ launches: [], has_more: false });
const queryCalls = [];
vi.mock('../../api/_lib/tokenized-launches.js', () => ({
	queryTokenizedLaunches: (args) => {
		queryCalls.push(args);
		return queryImpl(args);
	},
}));

// One row in the shape queryTokenizedLaunches actually returns (mint, network,
// glb/image/viewer urls, royalty terms, provenance, and the creating agent).
const ROW = {
	mint: 'AhTQ4rN9k9c7iqDs3Vb3T8kqz1oV3Q1oQ4L5s7pWmR2t',
	network: 'mainnet',
	name: 'Knight Avatar',
	glb_url: 'https://three.ws/api/asset/knight.glb',
	image_url: 'https://three.ws/api/asset/knight.png',
	viewer_url: 'https://three.ws/viewer?mint=AhTQ4rN9k9c7iqDs3Vb3T8kqz1oV3Q1oQ4L5s7pWmR2t',
	royalty_bps: 500,
	royalty_recipient: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
	parent_mint: null,
	provenance: 'forge',
	remix_royalty: null,
	created_at: '2026-08-01T12:00:00.000Z',
	agent_id: '3f1c8a52-6b6f-4b4a-9a0a-1f2d3c4b5a60',
	agent_name: 'Knight',
	agent_solana_address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
};

beforeEach(() => {
	quotaOk = true;
	queryCalls.length = 0;
	queryImpl = async () => ({ launches: [], has_more: false });
});
afterEach(() => {
	vi.restoreAllMocks();
});

function makeReq({ url, host = 'three.ws' } = {}) {
	const stream = Readable.from([]);
	stream.method = 'GET';
	stream.url = url;
	stream.headers = { host };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

async function dispatch(url) {
	const mod = await import('../../api/v1/tokenized/launches.js');
	const res = makeRes();
	await mod.default(makeReq({ url }), res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

describe('GET /api/v1/tokenized/launches', () => {
	it('returns the minted-asset feed with its pagination echo', async () => {
		queryImpl = async () => ({ launches: [ROW], has_more: true });
		const { res, body } = await dispatch('/api/v1/tokenized/launches?limit=1');
		expect(res.statusCode).toBe(200);
		expect(body.data.launches).toHaveLength(1);
		expect(body.data.launches[0].mint).toBe(ROW.mint);
		expect(body.data.has_more).toBe(true);
		expect(body.data.limit).toBe(1);
		expect(body.data.offset).toBe(0);
		expect(body.data.network).toBe('mainnet');
		expect(res.getHeader('cache-control')).toMatch(/max-age=15/);
	});

	it('clamps limit and offset before they reach the query', async () => {
		await dispatch('/api/v1/tokenized/launches?limit=9999&offset=-5');
		expect(queryCalls[0]).toMatchObject({ limit: 100, offset: 0 });
		await dispatch('/api/v1/tokenized/launches?limit=abc&offset=abc');
		expect(queryCalls[1]).toMatchObject({ limit: 24, offset: 0 });
		await dispatch('/api/v1/tokenized/launches?limit=0');
		expect(queryCalls[2]).toMatchObject({ limit: 1 });
	});

	it('accepts devnet and treats every other network value as mainnet', async () => {
		await dispatch('/api/v1/tokenized/launches?network=devnet');
		expect(queryCalls[0].network).toBe('devnet');
		const { body } = await dispatch('/api/v1/tokenized/launches?network=testnet');
		expect(queryCalls[1].network).toBe('mainnet');
		expect(body.data.network).toBe('mainnet');
	});

	it('passes a valid agent_id through and rejects a malformed one with 400', async () => {
		await dispatch(`/api/v1/tokenized/launches?agent_id=${ROW.agent_id}`);
		expect(queryCalls[0].agentId).toBe(ROW.agent_id);

		const { res, body } = await dispatch('/api/v1/tokenized/launches?agent_id=not-a-uuid');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		// The bad request never reached the database.
		expect(queryCalls).toHaveLength(1);
	});

	it('surfaces a database outage as 503, never as an empty feed', async () => {
		queryImpl = async () => {
			throw new Error('Missing required env var: DATABASE_URL');
		};
		const { res, body } = await dispatch('/api/v1/tokenized/launches');
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('service_unavailable');
		expect(body.data).toBeUndefined();
	});

	it('returns 429 when the per-IP quota is exhausted', async () => {
		quotaOk = false;
		const { res, body } = await dispatch('/api/v1/tokenized/launches');
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(queryCalls).toHaveLength(0);
	});

	it('is registered in the /api/v1 catalog as a free public GET', async () => {
		const { CATALOG } = await import('../../api/v1/_catalog.js');
		const entry = CATALOG.find((e) => e.id === 'v1.tokenized.launches');
		expect(entry, 'v1.tokenized.launches missing from catalog').toBeTruthy();
		expect(entry.method).toBe('GET');
		expect(entry.auth).toBe('public');
	});
});
