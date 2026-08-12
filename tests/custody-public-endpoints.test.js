// The two public, no-auth Proof-of-Custody reads:
//   GET /api/custody/integrity  (api/custody/integrity.js)
//   GET /api/custody/anchor     (api/custody/anchor.js)
//
// Both are the outward face of "our custody is provable", so they are exercised
// here at the handler boundary: the success path shapes real epoch rows, and the
// failure paths (bad epoch input, unknown epoch, DB fault) answer a JSON error
// with the right status instead of leaking a stack or 500-ing on client input.
//
// The prover beneath them is covered by tests/custody-proof-epoch.test.js; here
// custody-proof.js is mocked at the module seam so no DB or RPC is touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const EPOCH_7 = {
	epoch: 7,
	network: 'mainnet',
	anchor_network: 'devnet',
	merkle_root: 'a'.repeat(64),
	wallet_count: 3,
	total_lamports: '1500000000',
	total_sol: 1.5,
	anchor_sig: 'sig7',
	anchor_explorer: 'https://explorer.solana.com/tx/sig7?cluster=devnet',
	anchor_status: 'anchored',
	created_at: '2026-08-12T00:00:00Z',
	anchored_at: '2026-08-12T00:00:05Z',
};

const getPublicIntegrity = vi.fn(async () => ({
	latest: EPOCH_7,
	epochs_total: 7,
	epochs_anchored: 7,
	since: '2026-06-23T00:00:00Z',
	recent: [EPOCH_7],
}));
const getAnchorRef = vi.fn(async (epoch) => (Number(epoch) === 7 ? EPOCH_7 : null));
const getLatestAnchorRef = vi.fn(async () => EPOCH_7);

vi.mock('../api/_lib/custody-proof.js', () => ({
	getPublicIntegrity: (...a) => getPublicIntegrity(...a),
	getAnchorRef: (...a) => getAnchorRef(...a),
	getLatestAnchorRef: (...a) => getLatestAnchorRef(...a),
}));

import integrityHandler from '../api/custody/integrity.js';
import anchorHandler from '../api/custody/anchor.js';

function fakeRes() {
	const headers = {};
	return {
		statusCode: 200,
		headersSent: false,
		writableEnded: false,
		body: null,
		headers,
		setHeader(k, v) { headers[k.toLowerCase()] = v; },
		getHeader(k) { return headers[k.toLowerCase()]; },
		end(payload) {
			this.writableEnded = true;
			this.body = payload ? JSON.parse(payload) : null;
		},
	};
}

const req = (url) => ({ method: 'GET', url, headers: {} });

beforeEach(() => {
	getPublicIntegrity.mockClear();
	getAnchorRef.mockClear();
	getLatestAnchorRef.mockClear();
});

describe('GET /api/custody/integrity', () => {
	it('returns the public aggregate and marks it CDN-cacheable', async () => {
		const res = fakeRes();
		await integrityHandler(req('/api/custody/integrity'), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.data.latest).toMatchObject({ epoch: 7, wallet_count: 3, anchor_status: 'anchored' });
		expect(res.body.data.epochs_total).toBe(7);
		expect(res.headers['cache-control']).toContain('s-maxage=60');
	});

	it('answers a DB fault with a sanitized 5xx envelope, never a stack', async () => {
		getPublicIntegrity.mockRejectedValueOnce(new Error('relation "custody_attestation_epochs" does not exist'));
		const res = fakeRes();
		await integrityHandler(req('/api/custody/integrity'), res);

		expect(res.statusCode).toBe(500);
		expect(res.body.error).toBe('integrity_failed');
		expect(res.body.ref).toMatch(/^[0-9a-f]{16}$/);
		expect(JSON.stringify(res.body)).not.toContain('custody_attestation_epochs');
		expect(res.headers['cache-control']).toBe('no-store');
	});

	it('rejects a non-GET method with 405 + Allow', async () => {
		const res = fakeRes();
		await integrityHandler({ method: 'POST', url: '/api/custody/integrity', headers: {} }, res);

		expect(res.statusCode).toBe(405);
		expect(res.headers.allow).toBe('GET, HEAD');
		expect(getPublicIntegrity).not.toHaveBeenCalled();
	});
});

describe('GET /api/custody/anchor', () => {
	it('resolves one epoch by number', async () => {
		const res = fakeRes();
		await anchorHandler(req('/api/custody/anchor?epoch=7'), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.data.merkle_root).toBe('a'.repeat(64));
		expect(getAnchorRef).toHaveBeenCalledWith(7);
	});

	it('treats a missing, empty, or "latest" epoch as the newest one via a single-row read', async () => {
		for (const url of ['/api/custody/anchor', '/api/custody/anchor?epoch=', '/api/custody/anchor?epoch=latest']) {
			const res = fakeRes();
			await anchorHandler(req(url), res);
			expect(res.statusCode).toBe(200);
			expect(res.body.data.epoch).toBe(7);
		}
		// The full aggregate (extra count + 12-row recent list) is never fetched here.
		expect(getLatestAnchorRef).toHaveBeenCalledTimes(3);
		expect(getPublicIntegrity).not.toHaveBeenCalled();
	});

	it('404s an epoch that does not exist yet', async () => {
		const res = fakeRes();
		await anchorHandler(req('/api/custody/anchor?epoch=999999'), res);

		expect(res.statusCode).toBe(404);
		expect(res.body.error).toBe('not_found');
		expect(res.headers['cache-control']).toBe('no-store');
	});

	it.each(['abc', '-1', '1.5', '0', '99999999999999999999999999', '1%20OR%201=1'])(
		'400s the malformed epoch %s without querying the database',
		async (raw) => {
			const res = fakeRes();
			await anchorHandler(req(`/api/custody/anchor?epoch=${raw}`), res);

			expect(res.statusCode).toBe(400);
			expect(res.body.error).toBe('bad_request');
			expect(getAnchorRef).not.toHaveBeenCalled();
			expect(getLatestAnchorRef).not.toHaveBeenCalled();
		},
	);

	it('answers a lookup fault with a sanitized 5xx envelope', async () => {
		getAnchorRef.mockRejectedValueOnce(new Error('connection to neon.tech failed'));
		const res = fakeRes();
		await anchorHandler(req('/api/custody/anchor?epoch=7'), res);

		expect(res.statusCode).toBe(500);
		expect(res.body.error).toBe('anchor_lookup_failed');
		expect(JSON.stringify(res.body)).not.toContain('neon.tech');
	});
});
