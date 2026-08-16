// Tests for the four durable-creation endpoints that had no direct coverage:
// api/forge-creation.js, api/forge-categorize.js, api/forge-feedback.js and
// api/forge-comments.js.
//
// All four are the ownership-scoped half of the /forge flywheel, and each one
// answers on a boundary that is easy to get wrong and impossible to notice from
// the UI: a share-link read that must stay public, a write that must be scoped
// to the browser that forged the row, and a comment thread whose 405 has to tell
// a client which methods it may use. The forge store is stubbed at the module
// boundary so these assert the handlers' own contracts, not Postgres.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const storeEnabled = vi.fn(() => true);
const getPublicCreation = vi.fn(async () => ({ id: 'c1', model_category: 'item', glb_url: 'https://cdn.example/a.glb' }));
const listRelated = vi.fn(async () => [{ id: 'c2' }]);
const recordCreationView = vi.fn(async () => true);
const deleteCreation = vi.fn(async () => 'deleted');
const setForgeCategory = vi.fn(async () => true);
const recordFeedback = vi.fn(async () => true);
const hashClient = vi.fn((raw) => `hashed:${raw ?? 'anon'}`);

vi.mock('../../api/_lib/forge-store.js', () => ({
	MODEL_CATEGORIES: ['avatar', 'accessory', 'item', 'scene', 'creature', 'vehicle', 'other'],
	forgeStoreEnabled: (...a) => storeEnabled(...a),
	getPublicCreation: (...a) => getPublicCreation(...a),
	listRelated: (...a) => listRelated(...a),
	recordCreationView: (...a) => recordCreationView(...a),
	deleteCreation: (...a) => deleteCreation(...a),
	setForgeCategory: (...a) => setForgeCategory(...a),
	recordFeedback: (...a) => recordFeedback(...a),
	hashClient: (...a) => hashClient(...a),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcp3dStatus: vi.fn(async () => ({ success: true })),
		publicIp: vi.fn(async () => ({ success: true })),
		authIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '203.0.113.7'),
}));

// forge-comments talks to Postgres and the session layer directly. Stub both so
// the dispatch + auth contracts are the only thing under test.
vi.mock('../../api/_lib/db.js', () => ({ sql: vi.fn(async () => []) }));
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => null),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));
vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../../api/_lib/feed.js', () => ({ publishUserEvent: vi.fn() }));
vi.mock('../../api/_lib/display-name-safety.js', () => ({ containsHateSlur: vi.fn(() => false) }));

const creationHandler = (await import('../../api/forge-creation.js')).default;
const categorizeHandler = (await import('../../api/forge-categorize.js')).default;
const feedbackHandler = (await import('../../api/forge-feedback.js')).default;
const commentsHandler = (await import('../../api/forge-comments.js')).default;

const UUID = '19a208e7-ad6b-48b0-b7e0-1a752a54f222';

function mkReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
	const payload = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
	const stream = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []);
	stream.method = method;
	stream.url = url;
	stream.headers = { 'content-type': 'application/json', ...headers };
	return stream;
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[String(k).toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			this.writableEnded = true;
		},
	};
}

const parsed = (res) => JSON.parse(res.body || '{}');

beforeEach(() => {
	vi.clearAllMocks();
	storeEnabled.mockReturnValue(true);
	getPublicCreation.mockResolvedValue({ id: 'c1', model_category: 'item', glb_url: 'https://cdn.example/a.glb' });
	deleteCreation.mockResolvedValue('deleted');
	hashClient.mockImplementation((raw) => `hashed:${raw ?? 'anon'}`);
});

describe('GET /api/forge-creation', () => {
	it('serves a stored creation to a share-link visitor who sends no client header', async () => {
		const res = mkRes();
		await creationHandler(mkReq({ url: `/api/forge-creation?id=${UUID}` }), res);
		expect(res.statusCode).toBe(200);
		expect(parsed(res).creation.id).toBe('c1');
		// A share-link recipient forged nothing, so the read must not be voter-scoped.
		expect(getPublicCreation).toHaveBeenCalledWith({ id: UUID, voterKey: null });
	});

	it('resolves the caller voted-state when a forge id is sent', async () => {
		const res = mkRes();
		await creationHandler(mkReq({ url: `/api/forge-creation?id=${UUID}`, headers: { 'x-forge-client': 'cid-1' } }), res);
		expect(getPublicCreation).toHaveBeenCalledWith({ id: UUID, voterKey: 'hashed:cid-1' });
	});

	it('400s on a non-uuid id without touching the store', async () => {
		const res = mkRes();
		await creationHandler(mkReq({ url: '/api/forge-creation?id=not-a-uuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(parsed(res).error).toBe('invalid id');
		expect(getPublicCreation).not.toHaveBeenCalled();
	});

	it('404s an unknown id', async () => {
		getPublicCreation.mockResolvedValueOnce(null);
		const res = mkRes();
		await creationHandler(mkReq({ url: `/api/forge-creation?id=${UUID}` }), res);
		expect(res.statusCode).toBe(404);
		expect(parsed(res).creation).toBeNull();
	});

	it('attaches related models and counts a view only when asked', async () => {
		const res = mkRes();
		await creationHandler(mkReq({ url: `/api/forge-creation?id=${UUID}&related=3&view=1` }), res);
		expect(parsed(res).related).toEqual([{ id: 'c2' }]);
		expect(listRelated).toHaveBeenCalledWith({ id: UUID, category: 'item', limit: 3 });
		expect(recordCreationView).toHaveBeenCalledWith({ id: UUID });

		const plain = mkRes();
		await creationHandler(mkReq({ url: `/api/forge-creation?id=${UUID}` }), plain);
		expect(parsed(plain).related).toBeUndefined();
		expect(recordCreationView).toHaveBeenCalledTimes(1);
	});

	it('degrades to enabled:false when the deployment has no durable store', async () => {
		storeEnabled.mockReturnValue(false);
		const res = mkRes();
		await creationHandler(mkReq({ url: `/api/forge-creation?id=${UUID}` }), res);
		expect(res.statusCode).toBe(200);
		expect(parsed(res)).toEqual({ enabled: false, creation: null });
	});
});

describe('DELETE /api/forge-creation', () => {
	it('refuses a delete with no client header rather than guessing an owner', async () => {
		const res = mkRes();
		await creationHandler(mkReq({ method: 'DELETE', url: `/api/forge-creation?id=${UUID}` }), res);
		expect(res.statusCode).toBe(401);
		expect(parsed(res).error).toBe('missing_client');
		expect(deleteCreation).not.toHaveBeenCalled();
	});

	it('deletes a row owned by the calling browser', async () => {
		const res = mkRes();
		await creationHandler(
			mkReq({ method: 'DELETE', url: `/api/forge-creation?id=${UUID}`, headers: { 'x-forge-client': 'cid-1' } }),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(parsed(res)).toEqual({ deleted: true });
		expect(deleteCreation).toHaveBeenCalledWith({ id: UUID, clientKey: 'hashed:cid-1' });
	});

	it("answers 404 for another client's row so ids cannot be probed for existence", async () => {
		deleteCreation.mockResolvedValueOnce('not_found');
		const res = mkRes();
		await creationHandler(
			mkReq({ method: 'DELETE', url: `/api/forge-creation?id=${UUID}`, headers: { 'x-forge-client': 'cid-2' } }),
			res,
		);
		expect(res.statusCode).toBe(404);
		expect(parsed(res)).toEqual({ deleted: false, error: 'not_found' });
	});

	it('reports a failed delete as 503 and states nothing was removed', async () => {
		deleteCreation.mockResolvedValueOnce('error');
		const res = mkRes();
		await creationHandler(
			mkReq({ method: 'DELETE', url: `/api/forge-creation?id=${UUID}`, headers: { 'x-forge-client': 'cid-1' } }),
			res,
		);
		expect(res.statusCode).toBe(503);
		expect(parsed(res).error).toBe('delete_failed');
	});
});

describe('POST /api/forge-categorize', () => {
	it('stores a valid category against the calling browser', async () => {
		const res = mkRes();
		await categorizeHandler(
			mkReq({
				method: 'POST',
				url: '/api/forge-categorize',
				headers: { 'x-forge-client': 'cid-1' },
				body: { creation_id: UUID, model_category: 'vehicle' },
			}),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(parsed(res)).toEqual({ ok: true, stored: true });
		expect(setForgeCategory).toHaveBeenCalledWith({ id: UUID, clientKey: 'hashed:cid-1', modelCategory: 'vehicle' });
	});

	it('rejects a category outside the allowed set and names the valid ones', async () => {
		const res = mkRes();
		await categorizeHandler(
			mkReq({ method: 'POST', url: '/api/forge-categorize', body: { creation_id: UUID, model_category: 'banana' } }),
			res,
		);
		expect(res.statusCode).toBe(400);
		expect(parsed(res).error).toBe('invalid_category');
		expect(parsed(res).message).toContain('avatar');
		expect(setForgeCategory).not.toHaveBeenCalled();
	});

	it('rejects a non-uuid creation_id', async () => {
		const res = mkRes();
		await categorizeHandler(
			mkReq({ method: 'POST', url: '/api/forge-categorize', body: { creation_id: 'x', model_category: 'item' } }),
			res,
		);
		expect(res.statusCode).toBe(400);
		expect(parsed(res).error).toBe('invalid_creation');
	});

	it('answers stored:false instead of failing when no store is configured', async () => {
		storeEnabled.mockReturnValue(false);
		const res = mkRes();
		await categorizeHandler(
			mkReq({ method: 'POST', url: '/api/forge-categorize', body: { creation_id: UUID, model_category: 'item' } }),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(parsed(res)).toEqual({ ok: false, stored: false, reason: 'persistence_unconfigured' });
	});
});

describe('POST /api/forge-feedback', () => {
	it('records the human verdict against the calling browser', async () => {
		const res = mkRes();
		await feedbackHandler(
			mkReq({
				method: 'POST',
				url: '/api/forge-feedback',
				headers: { 'x-forge-client': 'cid-1' },
				body: { creation_id: UUID, outcome: 'kept', downloaded: true, rating: 5, note: 'clean mesh' },
			}),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(parsed(res)).toEqual({ ok: true, stored: true });
		expect(recordFeedback).toHaveBeenCalledWith({
			id: UUID,
			clientKey: 'hashed:cid-1',
			outcome: 'kept',
			downloaded: true,
			rating: 5,
			note: 'clean mesh',
		});
	});

	it('drops a non-integer rating rather than writing garbage into the label set', async () => {
		const res = mkRes();
		await feedbackHandler(
			mkReq({ method: 'POST', url: '/api/forge-feedback', body: { creation_id: UUID, rating: 'five' } }),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(recordFeedback.mock.calls[0][0].rating).toBeUndefined();
	});

	it('rejects a non-uuid creation_id', async () => {
		const res = mkRes();
		await feedbackHandler(mkReq({ method: 'POST', url: '/api/forge-feedback', body: { creation_id: 'nope' } }), res);
		expect(res.statusCode).toBe(400);
		expect(parsed(res).error).toBe('invalid_creation');
		expect(recordFeedback).not.toHaveBeenCalled();
	});
});

describe('/api/forge-comments dispatch', () => {
	it('advertises the methods it accepts on a 405 so a client can correct itself', async () => {
		const res = mkRes();
		await commentsHandler(mkReq({ method: 'PATCH', url: '/api/forge-comments' }), res);
		expect(res.statusCode).toBe(405);
		expect(String(res.getHeader('allow'))).toContain('DELETE');
		expect(String(res.getHeader('allow'))).toContain('HEAD');
	});

	it('requires a session before it will accept a comment', async () => {
		const res = mkRes();
		await commentsHandler(
			mkReq({ method: 'POST', url: '/api/forge-comments', body: { creation_id: UUID, body: 'hi' } }),
			res,
		);
		expect(res.statusCode).toBe(401);
		expect(parsed(res).error).toBe('unauthorized');
	});

	it('requires a session before it will delete a comment', async () => {
		const res = mkRes();
		await commentsHandler(
			mkReq({ method: 'DELETE', url: '/api/forge-comments', body: { comment_id: UUID } }),
			res,
		);
		expect(res.statusCode).toBe(401);
	});

	it('rejects a list read with no creation_id', async () => {
		const res = mkRes();
		await commentsHandler(mkReq({ method: 'GET', url: '/api/forge-comments' }), res);
		expect(res.statusCode).toBe(400);
		expect(parsed(res).error_description).toBe('creation_id required');
	});
});
