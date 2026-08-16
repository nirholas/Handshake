/**
 * POST /api/social/sentiment and POST /api/social/sentiment-pulse.
 *
 * Both are unauthenticated, IP-rate-limited scoring endpoints over the
 * deterministic lexicon in src/social/sentiment.js. `sentiment` scores texts
 * the caller already has; `sentiment-pulse` fetches a coin's live pump.fun
 * callouts first (the commentary feed that replaced the retired
 * `/replies/:mint` route) and folds in any caller-supplied snippets.
 *
 * The property that matters most here: an upstream outage must never render
 * as a confident neutral reading. With pump.fun down and nothing else to
 * score, the pulse answers 502 rather than "score 0, 100% neutral", which is
 * what a caller (and the paid `sentiment_pulse` MCP tool) would otherwise
 * bank on as real data.
 *
 * Rate limiting is stubbed so the suite never needs Redis; pump.fun is
 * stubbed at the fetch boundary so no test touches the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { mcpIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })) },
	clientIp: () => '127.0.0.1',
}));

const { default: sentimentHandler } = await import('../api/social/sentiment.js');
const { default: pulseHandler, calloutsToPosts } = await import('../api/social/sentiment-pulse.js');

function makeReq(url, body, { method = 'POST', contentType = 'application/json' } = {}) {
	return {
		method,
		url,
		headers: { origin: 'https://three.ws', 'content-type': contentType },
		body,
		socket: { remoteAddress: '127.0.0.1' },
	};
}

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => {
		r._h[k.toLowerCase()] = v;
	};
	r.getHeader = (k) => r._h[k.toLowerCase()];
	r.end = (b) => {
		r._b = b;
	};
	r.json = () => JSON.parse(r._b);
	return r;
}

async function call(handler, path, body, opts) {
	const res = makeRes();
	await handler(makeReq(path, body, opts), res);
	return res;
}

function callout(overrides = {}) {
	return {
		calloutId: 'c-1',
		username: 'trader',
		createdAt: 1_777_912_958_533,
		thesis: 'dev is based, bullish',
		...overrides,
	};
}

function upstream(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => null },
		json: async () => body,
	};
}

beforeEach(() => {
	rl.ok = true;
	vi.restoreAllMocks();
});

describe('POST /api/social/sentiment', () => {
	it('scores a batch of posts', async () => {
		const res = await call(sentimentHandler, '/api/social/sentiment', {
			posts: [
				{ text: 'to the moon, bullish gem' },
				{ text: 'total rug pull scam, rekt' },
				{ text: 'hello there' },
			],
		});
		expect(res.statusCode).toBe(200);
		const out = res.json();
		expect(out.count).toBe(3);
		expect(out.posPct + out.negPct + out.neuPct).toBe(100);
		expect(out.examples.pos.length).toBe(1);
		expect(out.examples.neg.length).toBe(1);
	});

	it('rejects an empty batch with a 400 validation error', async () => {
		const res = await call(sentimentHandler, '/api/social/sentiment', { posts: [] });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
	});

	it('rejects a non-POST method with 405', async () => {
		const res = await call(sentimentHandler, '/api/social/sentiment', undefined, {
			method: 'GET',
		});
		expect(res.statusCode).toBe(405);
	});
});

describe('calloutsToPosts', () => {
	it('maps thesis, handle and timestamp, newest first, capped at the limit', () => {
		const posts = calloutsToPosts(
			[
				callout({ calloutId: 'old', createdAt: 1_000, thesis: 'early' }),
				callout({ calloutId: 'new', createdAt: 9_000, thesis: 'latest' }),
				callout({ calloutId: 'mid', createdAt: 5_000, thesis: 'middle' }),
			],
			2,
		);
		expect(posts.map((p) => p.id)).toEqual(['new', 'mid']);
		expect(posts[0]).toMatchObject({ text: 'latest', author: 'trader' });
		expect(posts[0].ts).toBe(new Date(9_000).toISOString());
		expect(posts[0]).not.toHaveProperty('_at');
	});

	it('drops rows with no thesis instead of counting them neutral', () => {
		const posts = calloutsToPosts(
			[callout({ thesis: '   ' }), callout({ thesis: null }), callout({ thesis: 'real take' })],
			10,
		);
		expect(posts).toHaveLength(1);
		expect(posts[0].text).toBe('real take');
	});

	it('returns an empty list for a non-array body', () => {
		expect(calloutsToPosts(null, 10)).toEqual([]);
		expect(calloutsToPosts({ callouts: [] }, 10)).toEqual([]);
	});
});

describe('POST /api/social/sentiment-pulse', () => {
	it('scores live pump.fun callouts', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				upstream(200, {
					callouts: [
						callout({ calloutId: 'a', thesis: 'moon soon, bullish' }),
						callout({ calloutId: 'b', createdAt: 1_777_000_000_000, thesis: 'rug pull scam' }),
					],
				}),
			);

		const res = await call(pulseHandler, '/api/social/sentiment-pulse', { token: MINT, limit: 50 });
		expect(res.statusCode).toBe(200);
		const out = res.json();
		expect(out.ok).toBe(true);
		expect(out.token).toBe(MINT);
		expect(out.overall.count).toBe(2);
		expect(out.sources.pumpfunStatus).toBe('ok');
		expect(out.sources.pumpfunCount).toBe(2);
		expect(out.breakdown.pumpfun.count).toBe(2);

		const url = fetchMock.mock.calls[0][0];
		expect(url).toContain(`/callout/top/${MINT}`);
		expect(url).toContain('sortBy=TIMESTAMP');
	});

	it('answers 502 when pump.fun fails and the caller supplied nothing to score', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream(404, null));
		const res = await call(pulseHandler, '/api/social/sentiment-pulse', { token: MINT });
		expect(res.statusCode).toBe(502);
		const out = res.json();
		expect(out.error).toBe('upstream_unavailable');
		expect(out.error_description).toContain('404');
		expect(out.source).toBe('pump.fun');
	});

	it('still scores caller-supplied texts when pump.fun is down', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket hang up'));
		const res = await call(pulseHandler, '/api/social/sentiment-pulse', {
			token: MINT,
			extraTexts: ['moon bullish gem', '   ', 'rug pull scam'],
		});
		expect(res.statusCode).toBe(200);
		const out = res.json();
		expect(out.sources.pumpfunStatus).toBe('unavailable');
		expect(out.sources.pumpfun).toBe(null);
		expect(out.sources.extraCount).toBe(2);
		expect(out.overall.count).toBe(2);
		expect(out.breakdown.pumpfun.error).toBeTruthy();
	});

	it('reports a quiet coin as an empty reading, not an outage', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream(200, { callouts: [] }));
		const res = await call(pulseHandler, '/api/social/sentiment-pulse', { token: MINT });
		expect(res.statusCode).toBe(200);
		const out = res.json();
		expect(out.sources.pumpfunStatus).toBe('ok');
		expect(out.overall.count).toBe(0);
	});

	it('rejects a token that is not a base58 mint', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const res = await call(pulseHandler, '/api/social/sentiment-pulse', { token: 'notamint' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a limit above the documented ceiling', async () => {
		const res = await call(pulseHandler, '/api/social/sentiment-pulse', {
			token: MINT,
			limit: 9999,
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
	});
});
