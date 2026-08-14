// HTTP-level tests for /api/play/builds, the featured-builds surface of the
// /play coin worlds.
//
// The mint a caller sends is not just an identifier: builds-store.js turns it
// straight into the Redis key a coin's builds live under. So the handler has to
// reject anything that is not a real coin-world address BEFORE the store sees
// it, on the unauthenticated POST as well as the public GET. These tests pin
// that boundary: real Solana mints and EVM coin worlds get through, malformed
// strings of a plausible length do not.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const SOLANA_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const EVM_WORLD = '0x1234567890abcdef1234567890ABCDEF12345678';
const THUMB = 'data:image/jpeg;base64,' + 'A'.repeat(64);

// The store is stubbed so these tests exercise the handler's validation, not
// Redis. Every call it does receive is recorded, which is how the rejection
// cases prove the store was never reached rather than merely that a 400 came
// back for some other reason.
const listBuilds = vi.fn(async () => []);
const publishBuild = vi.fn(async () => ({ id: 'b_test' }));
vi.mock('../api/_lib/builds-store.js', () => ({
	listBuilds: (...a) => listBuilds(...a),
	publishBuild: (...a) => publishBuild(...a),
}));

const { default: handler } = await import('../api/play/builds.js');

function mockRes() {
	return {
		statusCode: 200, _headers: {}, _body: '', _ended: false,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; this._ended = true; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}

function mockReq({ method = 'GET', url = '/api/play/builds', query = {}, body = null } = {}) {
	const r = Readable.from(body != null ? [Buffer.from(JSON.stringify(body))] : []);
	r.method = method;
	r.url = url;
	r.query = query;
	r.headers = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
	return r;
}

const get = async (mint) => {
	const res = mockRes();
	await handler(mockReq({ method: 'GET', query: { mint } }), res);
	return res;
};

const post = async (mint) => {
	const res = mockRes();
	await handler(mockReq({ method: 'POST', body: { mint, blocks: 12, thumb: THUMB, title: 'test', author: 'test' } }), res);
	return res;
};

beforeEach(() => {
	listBuilds.mockClear();
	publishBuild.mockClear();
});

// Strings that are the right LENGTH for a mint but are not addresses. Before the
// format check, every one of these reached the store and minted a Redis key.
const MALFORMED = {
	'a path traversal': '../../evil-key-000OIl-aaaaaaaaaaaaaaaa',
	'characters outside the base58 alphabet': '0'.repeat(40),
	'embedded spaces': 'a b c d e f g h i j k l m n o p q',
	'an EVM address with a bad hex digit': '0xZZZ4567890abcdef1234567890ABCDEF12345678',
};

describe('GET /api/play/builds', () => {
	it('lists a Solana coin world', async () => {
		const res = await get(SOLANA_MINT);
		expect(res.statusCode).toBe(200);
		expect(res.json).toEqual({ builds: [] });
		expect(listBuilds).toHaveBeenCalledWith(SOLANA_MINT);
	});

	it('lists an EVM coin world', async () => {
		const res = await get(EVM_WORLD);
		expect(res.statusCode).toBe(200);
		expect(listBuilds).toHaveBeenCalledWith(EVM_WORLD);
	});

	for (const [what, mint] of Object.entries(MALFORMED)) {
		it(`refuses ${what} without reading the store`, async () => {
			const res = await get(mint);
			expect(res.statusCode).toBe(400);
			expect(res.json.error).toBe('bad_mint');
			expect(listBuilds).not.toHaveBeenCalled();
		});
	}

	it('refuses a missing mint', async () => {
		const res = await get('');
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('bad_mint');
		expect(listBuilds).not.toHaveBeenCalled();
	});
});

describe('POST /api/play/builds', () => {
	it('publishes to a Solana coin world', async () => {
		const res = await post(SOLANA_MINT);
		expect(res.statusCode).toBe(201);
		expect(res.json.ok).toBe(true);
		expect(publishBuild).toHaveBeenCalledWith(SOLANA_MINT, expect.objectContaining({ blocks: 12, thumb: THUMB }));
	});

	it('publishes to an EVM coin world', async () => {
		const res = await post(EVM_WORLD);
		expect(res.statusCode).toBe(201);
		expect(publishBuild).toHaveBeenCalledWith(EVM_WORLD, expect.anything());
	});

	for (const [what, mint] of Object.entries(MALFORMED)) {
		it(`refuses ${what} without writing to the store`, async () => {
			const res = await post(mint);
			expect(res.statusCode).toBe(400);
			expect(res.json.error).toBe('validation_error');
			expect(publishBuild).not.toHaveBeenCalled();
		});
	}

	it('answers 503, not 500, when persistence is unavailable', async () => {
		publishBuild.mockRejectedValueOnce(new Error('persistence_unavailable'));
		const res = await post(SOLANA_MINT);
		expect(res.statusCode).toBe(503);
		expect(res.json.error).toBe('unavailable');
	});

	it('refuses a screenshot past the size cap with a 413', async () => {
		const res = mockRes();
		await handler(mockReq({
			method: 'POST',
			body: { mint: SOLANA_MINT, blocks: 1, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(300_000) },
		}), res);
		expect(res.statusCode).toBe(413);
		expect(res.json.error).toBe('thumb_too_large');
		expect(publishBuild).not.toHaveBeenCalled();
	});

	it('refuses a block count past the world cap', async () => {
		const res = mockRes();
		await handler(mockReq({ method: 'POST', body: { mint: SOLANA_MINT, blocks: 99_999, thumb: THUMB } }), res);
		expect(res.statusCode).toBe(400);
		expect(publishBuild).not.toHaveBeenCalled();
	});
});

describe('/api/play/builds method handling', () => {
	it('refuses a verb the surface does not serve', async () => {
		const res = mockRes();
		await handler(mockReq({ method: 'PUT' }), res);
		expect(res.statusCode).toBe(405);
	});
});
