// Tests for GET /api/forge-gallery — the personal gallery vs the public
// community showcase ("Fresh from the Forge" on /forge).
//
// Pins the contract the showcase module depends on:
//   • ?scope=community serves cross-client rows from listShowcase and never
//     touches the per-client path (no x-forge-client required, no hashClient),
//   • community responses are CDN-cacheable (s-maxage) — the default personal
//     scope must NOT be, it's keyed to a client header,
//   • a deployment without a durable store answers { enabled: false } for
//     both scopes instead of erroring,
//   • the ?limit param reaches the store for both scopes.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const storeEnabledMock = vi.fn(() => true);
const listCreationsMock = vi.fn(async () => []);
const listShowcaseMock = vi.fn(async () => []);
const hashClientMock = vi.fn(() => 'hashed-client');
vi.mock('../../api/_lib/forge-store.js', () => ({
	forgeStoreEnabled: (...a) => storeEnabledMock(...a),
	listCreations: (...a) => listCreationsMock(...a),
	listShowcase: (...a) => listShowcaseMock(...a),
	hashClient: (...a) => hashClientMock(...a),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcp3dStatus: vi.fn(async () => ({ success: true })),
		publicIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const handler = (await import('../../api/forge-gallery.js')).default;

function mkReq(url, headers = {}) {
	return { method: 'GET', url, headers, on() {}, destroy() {} };
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			this.writableEnded = true;
		},
	};
}

function parsed(res) {
	return JSON.parse(res.body);
}

beforeEach(() => {
	storeEnabledMock.mockReturnValue(true);
	listCreationsMock.mockResolvedValue([]);
	listShowcaseMock.mockResolvedValue([]);
	hashClientMock.mockClear();
	listCreationsMock.mockClear();
	listShowcaseMock.mockClear();
});

describe('GET /api/forge-gallery?scope=community', () => {
	it('serves cross-client showcase rows without touching the per-client path', async () => {
		const rows = [
			{ id: 'c1', prompt: 'a glazed ceramic teapot', glb_url: 'https://cdn/x.glb', preview_image_url: 'https://cdn/x.png', vote_count: 0, voted: false },
		];
		listShowcaseMock.mockResolvedValue(rows);

		const res = mkRes();
		// Deliberately no x-forge-client header — community (fresh) must not need one.
		await handler(mkReq('/api/forge-gallery?scope=community&limit=12'), res);

		expect(res.statusCode).toBe(200);
		expect(parsed(res)).toEqual({ enabled: true, creations: rows, sort: 'fresh', window: 'all' });
		// Anonymous read → no voter key resolved, default fresh/all ordering.
		expect(listShowcaseMock).toHaveBeenCalledWith({ limit: 12, sort: 'fresh', window: 'all', voterKey: null });
		expect(listCreationsMock).not.toHaveBeenCalled();
		expect(hashClientMock).not.toHaveBeenCalled();
	});

	it('serves the Forge-Off board on sort=top&window=week', async () => {
		const rows = [{ id: 'c2', prompt: 'a low-poly red fox', glb_url: 'https://cdn/f.glb', vote_count: 5, voted: false }];
		listShowcaseMock.mockResolvedValue(rows);

		const res = mkRes();
		await handler(mkReq('/api/forge-gallery?scope=community&sort=top&window=week&limit=24'), res);

		expect(res.statusCode).toBe(200);
		expect(parsed(res)).toEqual({ enabled: true, creations: rows, sort: 'top', window: 'week' });
		expect(listShowcaseMock).toHaveBeenCalledWith({ limit: 24, sort: 'top', window: 'week', voterKey: null });
	});

	it('resolves the caller voted-state when a forge id is sent, and is not CDN-cacheable then', async () => {
		const rows = [{ id: 'c3', prompt: 'a sci-fi helmet', glb_url: 'https://cdn/h.glb', vote_count: 3, voted: true }];
		listShowcaseMock.mockResolvedValue(rows);

		const res = mkRes();
		await handler(mkReq('/api/forge-gallery?scope=community&sort=top', { 'x-forge-client': 'browser-9' }), res);

		expect(hashClientMock).toHaveBeenCalledWith('browser-9');
		expect(listShowcaseMock).toHaveBeenCalledWith({ limit: 24, sort: 'top', window: 'all', voterKey: 'hashed-client' });
		// A per-voter read is private — it can't be shared across browsers.
		expect(res.getHeader('cache-control') || '').toMatch(/private|no-store/);
	});

	it('is CDN-cacheable for an anonymous read — the feed only changes when a generation finishes', async () => {
		const res = mkRes();
		await handler(mkReq('/api/forge-gallery?scope=community'), res);
		expect(res.getHeader('cache-control')).toMatch(/s-maxage=\d+/);
	});

	it('answers enabled:false when the deployment has no durable store', async () => {
		storeEnabledMock.mockReturnValue(false);
		const res = mkRes();
		await handler(mkReq('/api/forge-gallery?scope=community'), res);
		expect(parsed(res)).toEqual({ enabled: false, creations: [] });
		expect(listShowcaseMock).not.toHaveBeenCalled();
	});
});

describe('GET /api/forge-gallery (personal scope)', () => {
	it('stays keyed to the client header and is not CDN-cacheable', async () => {
		const rows = [{ id: 'mine', prompt: 'a vintage film camera', glb_url: 'https://cdn/m.glb' }];
		listCreationsMock.mockResolvedValue(rows);

		const res = mkRes();
		await handler(mkReq('/api/forge-gallery?limit=8', { 'x-forge-client': 'anon-123' }), res);

		expect(parsed(res)).toEqual({ enabled: true, creations: rows });
		expect(hashClientMock).toHaveBeenCalledWith('anon-123');
		expect(listCreationsMock).toHaveBeenCalledWith({ clientKey: 'hashed-client', limit: 8 });
		expect(listShowcaseMock).not.toHaveBeenCalled();
		expect(res.getHeader('cache-control') || '').not.toMatch(/s-maxage/);
	});
});
