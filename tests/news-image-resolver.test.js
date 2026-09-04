// Coverage for api/news/image.js, the preview-image resolver behind every news
// card.
//
// About a fifth of the live feed publishes text-only RSS, so "this article has
// no picture" is an ordinary answer, not a failure. The endpoint used to say it
// with a 404, which the browser logs as a failed resource in the reader's
// console on a surface whose bar is a clean console, and which reads as broken
// to anyone watching the network tab. It now answers 204 for that case and
// keeps 404 for the case that IS an error: a link the aggregator never served,
// which is a probe against an endpoint that must never become an open resolver.
//
// Both answers stay cacheable, because the whole point is that one article
// resolves once rather than once per render.

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
	limits: { imgProxyIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));

const findArticle = vi.fn(async () => null);
const extractOgImage = vi.fn(() => null);
vi.mock('../api/_lib/news.js', () => ({
	findArticle: (...a) => findArticle(...a),
	extractOgImage: (...a) => extractOgImage(...a),
}));
vi.mock('../api/_lib/fetch-model.js', () => ({ fetchModel: vi.fn(async () => ({ bytes: Buffer.from('') })) }));

const { default: handler } = await import('../api/news/image.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		ended: false,
		body: undefined,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			this.ended = true;
			this.body = chunk;
		},
	};
}

const req = (link) => ({ url: `/api/news/image?url=${encodeURIComponent(link)}`, method: 'GET', headers: {} });

describe('the preview-image resolver separates "no picture" from "no such article"', () => {
	beforeEach(() => {
		findArticle.mockReset();
		extractOgImage.mockReset();
	});

	it('answers 204 with no body when the article carries no image', async () => {
		findArticle.mockResolvedValue({ link: 'https://pub.example/a', image: null, source: 'Pub' });
		extractOgImage.mockReturnValue(null);
		const res = makeRes();
		await handler(req('https://pub.example/a'), res);
		expect(res.statusCode).toBe(204);
		expect(res.body).toBeUndefined();
		expect(res._json).toBeUndefined();
		// Negative caching is the reason one imageless article costs one
		// resolution rather than one per render.
		expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
	});

	it('still answers 404 for a link the aggregator never served', async () => {
		findArticle.mockResolvedValue(null);
		const res = makeRes();
		await handler(req('https://not-ours.example/x'), res);
		expect(res._json.status).toBe(404);
		expect(res._json.body.error).toBe('unknown_article');
	});

	it('redirects a known image to the same-origin proxy, never to the publisher', async () => {
		findArticle.mockResolvedValue({
			link: 'https://pub.example/b',
			image: 'https://cdn.pub.example/hero.jpg',
			source: 'Pub',
		});
		const res = makeRes();
		await handler(req('https://pub.example/b'), res);
		expect(res.statusCode).toBe(302);
		expect(res.headers.location.startsWith('/api/img?url=')).toBe(true);
		expect(decodeURIComponent(res.headers.location)).toContain('https://cdn.pub.example/hero.jpg');
	});

	it('rejects a request with no url instead of guessing one', async () => {
		const res = makeRes();
		await handler({ url: '/api/news/image', method: 'GET', headers: {} }, res);
		expect(res._json.status).toBe(400);
	});
});
