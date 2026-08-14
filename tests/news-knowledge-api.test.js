// Coverage for api/news/knowledge.js: the read side of the crypto knowledge
// base the 3D agents ground on.
//
// The guarantee under test: every row served carries real extracted body text.
// The corpus already holds headline-only rows from stories no extraction rung
// could read (paywalls, bot walls, links that were never articles), and those
// are exactly the shape a drive-by write leaves behind. They ground nothing, so
// the endpoint filters them out on the way out rather than waiting for the
// corpus to be rewritten.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: () => true,
	rateLimited: (res) => {
		res._json = { status: 429, body: { error: 'rate_limited' } };
		return res;
	},
	json: (res, status, body, headers = {}) => {
		res._json = { status, body, headers };
		return res;
	},
	error: (res, status, code, message) => {
		res._json = { status, body: { error: code, message } };
		return res;
	},
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { marketFeedIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));

const getExtraction = vi.fn(async () => null);
const queryKnowledge = vi.fn(async () => []);
const knowledgeStats = vi.fn(async () => ({ total: 2, full_text: 1, enabled: true }));
vi.mock('../api/_lib/news-knowledge-store.js', () => ({
	getExtraction: (...a) => getExtraction(...a),
	queryKnowledge: (...a) => queryKnowledge(...a),
	knowledgeStats: (...a) => knowledgeStats(...a),
}));

const { default: handler } = await import('../api/news/knowledge.js');

function call(url = '/api/news/knowledge') {
	const res = { setHeader() {}, end() {}, statusCode: 200 };
	return handler({ method: 'GET', url, headers: {} }, res).then(() => res._json);
}

const SUBSTANTIVE = {
	id: '1111111111111111',
	url: 'https://publisher.example/real-story',
	title: 'Regulated exchanges gain ground as oversight tightens',
	source: 'The Block',
	extraction: 'page',
	content_chars: 4200,
	summary: 'Oversight tightened and regulated venues took share.',
	tickers: ['BTC'],
	paragraphs: ['Regulated venues took share as oversight tightened across the region.'],
};

const HOLLOW = {
	id: '2222222222222222',
	url: 'https://publisher.example/blocked-story',
	title: 'Three Airports Plan to Ditch T.S.A.',
	source: 'Some Wire',
	extraction: 'preview',
	content_chars: 0,
	summary: 'Three Airports Plan to Ditch T.S.A.',
	tickers: [],
};

beforeEach(() => {
	getExtraction.mockReset().mockResolvedValue(null);
	queryKnowledge.mockReset().mockResolvedValue([]);
	knowledgeStats.mockReset().mockResolvedValue({ total: 2, full_text: 1, enabled: true });
});
afterEach(() => vi.clearAllMocks());

describe('input validation', () => {
	it('rejects an id that is not a 16-hex article id', async () => {
		const out = await call('/api/news/knowledge?id=zzz');
		expect(out.status).toBe(400);
		expect(out.body.error).toBe('bad_id');
		expect(getExtraction).not.toHaveBeenCalled();
	});

	it('rejects a ticker that is not a symbol', async () => {
		const out = await call('/api/news/knowledge?ticker=not%20a%20symbol');
		expect(out.status).toBe(400);
		expect(out.body.error).toBe('bad_ticker');
	});

	it('rejects an over-long free-text query', async () => {
		const out = await call(`/api/news/knowledge?q=${'a'.repeat(200)}`);
		expect(out.status).toBe(400);
		expect(out.body.error).toBe('bad_query');
	});
});

describe('body-text guarantee', () => {
	it('serves a record that carries extracted body text', async () => {
		getExtraction.mockResolvedValue(SUBSTANTIVE);
		const out = await call(`/api/news/knowledge?id=${SUBSTANTIVE.id}`);
		expect(out.status).toBe(200);
		expect(out.body.id).toBe(SUBSTANTIVE.id);
		expect(out.body.full_text_url).toBe(SUBSTANTIVE.url);
	});

	it('answers 404 for a stored row with no extracted body', async () => {
		getExtraction.mockResolvedValue(HOLLOW);
		const out = await call(`/api/news/knowledge?id=${HOLLOW.id}`);
		expect(out.status).toBe(404);
		expect(out.body.error).toBe('not_found');
	});

	it('drops zero-content rows from the listing', async () => {
		queryKnowledge.mockResolvedValue([SUBSTANTIVE, HOLLOW]);
		const out = await call('/api/news/knowledge?limit=10');
		expect(out.status).toBe(200);
		expect(out.body.articles.map((a) => a.id)).toEqual([SUBSTANTIVE.id]);
	});

	it('drops zero-content rows from a ticker query too', async () => {
		queryKnowledge.mockResolvedValue([HOLLOW, HOLLOW]);
		const out = await call('/api/news/knowledge?ticker=BTC');
		expect(out.status).toBe(200);
		expect(out.body.articles).toEqual([]);
		expect(out.body.query.ticker).toBe('BTC');
	});
});
