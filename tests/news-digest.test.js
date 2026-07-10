// Coverage for api/news/digest.js — narrative clustering over the live feed.
//
// The load-bearing guarantee: every narrative must cite real articles the
// aggregator actually returned. A model that invents a story, or cites an
// index that doesn't exist, must not reach the response. Both engines (LLM
// and the keyword-clustering fallback) are exercised.

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
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: vi.fn(),
	llmConfigured: vi.fn(() => false),
}));

const recent = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();

function article(over) {
	return {
		id: over.id, title: over.title, link: over.link || `https://x.com/${over.id}`,
		description: over.description ?? 'desc', image: null, source: over.source || 'CoinDesk',
		source_key: (over.source || 'coindesk').toLowerCase(), category: 'general',
		pub_date: over.pub_date || recent(30),
		tickers: over.tickers || [],
		sentiment: over.sentiment || { score: 0, label: 'neutral', confidence: 0.5 },
	};
}

// Two ETF stories (should cluster), one hack story, one stale story.
const ARTICLES = [
	article({ id: 'a1', title: 'Bitcoin ETF inflows hit record high', tickers: ['BTC'], source: 'CoinDesk', sentiment: { score: 0.6, label: 'very_positive' } }),
	article({ id: 'a2', title: 'Record ETF inflows push Bitcoin to new high', tickers: ['BTC'], source: 'Decrypt', sentiment: { score: 0.5, label: 'positive' } }),
	article({ id: 'a3', title: 'Exchange hacked, forty million stolen', tickers: [], source: 'Protos', sentiment: { score: -0.6, label: 'very_negative' } }),
	article({ id: 'a4', title: 'Solana upgrade improves throughput', tickers: ['SOL'], source: 'The Block' }),
	article({ id: 'a5', title: 'Ancient news from last week', pub_date: recent(60 * 24 * 7) }),
];

vi.mock('../api/_lib/news.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		getNews: vi.fn(async () => ({ articles: ARTICLES, total: ARTICLES.length, sources_ok: 37, sources_total: 38 })),
	};
});

const { default: handler, _internal } = await import('../api/news/digest.js');
const { llmComplete, llmConfigured } = await import('../api/_lib/llm.js');

function call(url = '/api/news/digest?refresh=1') {
	const res = { setHeader() {}, end() {}, statusCode: 200 };
	return handler({ method: 'GET', url, headers: {} }, res).then(() => res);
}

beforeEach(() => {
	llmConfigured.mockReturnValue(false);
	llmComplete.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('clustering math', () => {
	it('jaccard scores overlapping token sets above disjoint ones', () => {
		const a = _internal.tokens('Bitcoin ETF inflows hit record high');
		const b = _internal.tokens('Record ETF inflows push Bitcoin to new high');
		const c = _internal.tokens('Solana upgrade improves throughput');
		expect(_internal.jaccard(a, b)).toBeGreaterThan(_internal.jaccard(a, c));
	});

	it('stanceFrom averages lexicon scores into a stance', () => {
		expect(_internal.stanceFrom([{ sentiment: { score: 0.6 } }, { sentiment: { score: 0.4 } }])).toBe('bullish');
		expect(_internal.stanceFrom([{ sentiment: { score: -0.6 } }])).toBe('bearish');
		expect(_internal.stanceFrom([{ sentiment: { score: 0 } }])).toBe('neutral');
	});

	it('groups the two ETF headlines together and keeps the hack separate', () => {
		const clusters = _internal.heuristicClusters(ARTICLES.slice(0, 4), 8);
		const etf = clusters.find((c) => c.articles.some((a) => a.id === 'a1'));
		expect(etf.articles.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
		expect(etf.stance).toBe('bullish');
		expect(etf.tickers).toContain('BTC');
		const hack = clusters.find((c) => c.articles.some((a) => a.id === 'a3'));
		expect(hack.articles).toHaveLength(1);
		expect(hack.stance).toBe('bearish');
	});
});

describe('GET /api/news/digest', () => {
	it('uses the heuristic engine when no LLM provider is configured', async () => {
		const res = await call();
		expect(res._json.status).toBe(200);
		expect(res._json.body.engine).toBe('heuristic');
		expect(res._json.body.provider).toBeNull();
		expect(res._json.body.narratives.length).toBeGreaterThan(0);
		expect(llmComplete).not.toHaveBeenCalled();
	});

	it('excludes articles outside the time window', async () => {
		const res = await call('/api/news/digest?hours=24&refresh=1');
		// a5 is a week old
		expect(res._json.body.articles_considered).toBe(4);
		const cited = res._json.body.narratives.flatMap((n) => n.articles.map((a) => a.id));
		expect(cited).not.toContain('a5');
	});

	it('uses the LLM engine and resolves indices to real articles', async () => {
		llmConfigured.mockReturnValue(true);
		llmComplete.mockResolvedValue({
			text: '```json\n{"narratives":[{"title":"ETF inflows break records","summary":"Two outlets report record inflows.","stance":"bullish","indices":[0,1]}]}\n```',
			provider: 'groq',
		});
		const res = await call();
		expect(res._json.body.engine).toBe('llm');
		expect(res._json.body.provider).toBe('groq');
		const [n] = res._json.body.narratives;
		expect(n.title).toBe('ETF inflows break records');
		expect(n.coverage).toBe(2);
		expect(n.articles.map((a) => a.id)).toEqual(['a1', 'a2']);
		expect(n.articles.every((a) => a.link.startsWith('https://'))).toBe(true);
	});

	it('drops narratives citing indices that do not exist — never fabricates', async () => {
		llmConfigured.mockReturnValue(true);
		llmComplete.mockResolvedValue({
			text: JSON.stringify({
				narratives: [
					{ title: 'Real story', summary: 's', stance: 'neutral', indices: [0] },
					{ title: 'Hallucinated story', summary: 's', stance: 'bullish', indices: [99, 400] },
				],
			}),
			provider: 'groq',
		});
		const res = await call();
		const titles = res._json.body.narratives.map((n) => n.title);
		expect(titles).toContain('Real story');
		expect(titles).not.toContain('Hallucinated story');
		expect(res._json.body.narratives.every((n) => n.articles.length > 0)).toBe(true);
	});

	it('falls back to the heuristic engine when the LLM chain fails', async () => {
		llmConfigured.mockReturnValue(true);
		llmComplete.mockRejectedValue(new Error('all providers down'));
		const res = await call();
		expect(res._json.status).toBe(200);
		expect(res._json.body.engine).toBe('heuristic');
		expect(res._json.body.narratives.length).toBeGreaterThan(0);
	});

	it('falls back when every model narrative cites nothing real', async () => {
		llmConfigured.mockReturnValue(true);
		llmComplete.mockResolvedValue({
			text: JSON.stringify({ narratives: [{ title: 'Ghost', summary: 's', stance: 'bullish', indices: [42] }] }),
			provider: 'groq',
		});
		const res = await call();
		expect(res._json.body.engine).toBe('heuristic');
	});

	it('503s when the window has too little coverage', async () => {
		const { getNews } = await import('../api/_lib/news.js');
		getNews.mockResolvedValueOnce({ articles: [ARTICLES[4]], total: 1, sources_ok: 1, sources_total: 38 });
		const res = await call('/api/news/digest?hours=1&refresh=1');
		expect(res._json.status).toBe(503);
		expect(res._json.body.error).toBe('insufficient_coverage');
	});

	it('serves a cached digest on the second call and honors ?refresh=1', async () => {
		const { getNews } = await import('../api/_lib/news.js');
		await call('/api/news/digest?hours=12'); // populate
		const before = getNews.mock.calls.length;
		const cached = await call('/api/news/digest?hours=12');
		expect(cached._json.body.cached).toBe(true);
		expect(getNews.mock.calls.length).toBe(before); // no upstream re-read
		const fresh = await call('/api/news/digest?hours=12&refresh=1');
		expect(fresh._json.body.cached).toBe(false);
		expect(getNews.mock.calls.length).toBeGreaterThan(before);
	});
});
