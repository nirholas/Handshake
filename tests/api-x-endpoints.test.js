// Endpoint tests for the /api/x/* surface (analytics, draft, post, reviews,
// schedule, status, triggers). Each handler runs for real against a fake req/res
// with the DB, auth, CSRF, rate limiter, LLM chain, and X publish helper mocked,
// so http.js (cors/method/wrap/json/error) genuinely produces the status codes
// and envelopes the dashboard X panel renders against.
//
// Every case here is either the main path or a failure path that used to reach
// Postgres with an uncastable value and 500 on a caller mistake.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tagged-template `sql` that returns whatever the test queued, in order.
const queue = [];
const sqlCalls = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings) => {
		sqlCalls.push(String(strings?.raw ? strings.join('?') : strings));
		return queue.length ? queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

let session = null;
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

let csrfOk = true;
vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => csrfOk),
}));

let rateOk = true;
vi.mock('../api/_lib/rate-limit.js', () => {
	const allow = async () => ({ success: rateOk, limit: 20, remaining: rateOk ? 19 : 0, reset: 1 });
	return {
		limits: { authIp: allow, xDraftIp: allow },
		clientIp: () => '127.0.0.1',
	};
});

// Error classes the handlers branch on with `instanceof`. They are declared
// through vi.hoisted because the module factories below reference them at
// factory-evaluation time, which runs before ordinary top-level declarations.
const { XPostError, LlmUnavailableError } = vi.hoisted(() => {
	class XPostError extends Error {
		constructor(code, message, status = 400, extra = {}) {
			super(message);
			this.code = code;
			this.status = status;
			this.extra = extra;
		}
	}
	class LlmUnavailableError extends Error {
		constructor() {
			super('no provider');
			this.code = 'llm_unavailable';
			this.status = 503;
		}
	}
	return { XPostError, LlmUnavailableError };
});

const publishTweet = vi.fn();
const getUserTier = vi.fn(async () => ({ tier: 'free', quota: 5, min_interval_min: 30 }));
vi.mock('../api/_lib/x-post.js', () => ({
	MAX_TWEET_LEN: 280,
	XPostError,
	publishTweet: (...a) => publishTweet(...a),
	getUserTier: (...a) => getUserTier(...a),
}));

const llmComplete = vi.fn();
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: (...a) => llmComplete(...a),
	LlmUnavailableError,
}));

const revokeAllSeedConsentsForUser = vi.fn(async () => ({ consents: 2, deleted: 7, agents: 1 }));
vi.mock('../api/_lib/x-seed-consent.js', () => ({
	revokeAllSeedConsentsForUser: (...a) => revokeAllSeedConsentsForUser(...a),
}));

import analytics from '../api/x/analytics.js';
import draft from '../api/x/draft.js';
import post from '../api/x/post.js';
import reviews from '../api/x/reviews.js';
import schedule from '../api/x/schedule.js';
import status from '../api/x/status.js';
import triggers from '../api/x/triggers.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const AGENT = '99999999-8888-4777-8666-555555555555';

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(payload) { this.headersSent = true; this.writableEnded = true; this.body = payload ?? null; },
		get json() { return this.body ? JSON.parse(this.body) : null; },
	};
}

function mockReq({ method = 'GET', url = '/', body, headers = {} } = {}) {
	const req = { method, url, headers: { ...headers }, socket: {} };
	if (body !== undefined) {
		req.body = body;
		req.headers['content-type'] = 'application/json';
	}
	return req;
}

async function call(handler, reqInit) {
	const res = mockRes();
	await handler(mockReq(reqInit), res);
	return res;
}

beforeEach(() => {
	queue.length = 0;
	sqlCalls.length = 0;
	session = { id: 'user-1', email: 'qa@three.ws' };
	csrfOk = true;
	rateOk = true;
	vi.clearAllMocks();
	getUserTier.mockResolvedValue({ tier: 'free', quota: 5, min_interval_min: 30 });
	revokeAllSeedConsentsForUser.mockResolvedValue({ consents: 2, deleted: 7, agents: 1 });
});

describe('GET /api/x/analytics', () => {
	it('rolls up engagement totals across the caller posts', async () => {
		queue.push([
			{ id: 'p1', tweet_id: '1', text: 'a', agent_id: AGENT, metrics: { like_count: 3, retweet_count: 1, impression_count: 100 } },
			// jsonb can hand back a count as a string; totals must stay numeric.
			{ id: 'p2', tweet_id: '2', text: 'b', agent_id: AGENT, metrics: { like_count: '4', reply_count: 2, impression_count: '50' } },
		]);
		const res = await call(analytics, { url: '/api/x/analytics' });
		expect(res.statusCode).toBe(200);
		expect(res.json.totals).toEqual({ posts: 2, likes: 7, retweets: 1, replies: 2, quotes: 0, impressions: 150 });
		expect(res.json.posts).toHaveLength(2);
	});

	it('rejects a non-uuid agent_id instead of letting the cast 500', async () => {
		const res = await call(analytics, { url: '/api/x/analytics?agent_id=not-a-uuid' });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('validation_error');
		expect(sqlCalls).toHaveLength(0);
	});

	it('requires a session', async () => {
		session = null;
		const res = await call(analytics, { url: '/api/x/analytics' });
		expect(res.statusCode).toBe(401);
	});
});

describe('POST /api/x/draft', () => {
	it('returns one draft per requested count in the shape the dashboard renders', async () => {
		queue.push([{ name: 'Nova', description: 'a scout agent' }]); // agent_identities hit
		llmComplete
			.mockResolvedValueOnce({ text: '"first idea"' })
			.mockResolvedValueOnce({ text: 'second idea' })
			.mockResolvedValueOnce({ text: 'third idea' });

		const res = await call(draft, {
			method: 'POST',
			url: '/api/x/draft',
			body: { agent_id: AGENT, prompt: 'ship day', tone: 'hype', count: 3 },
		});

		expect(res.statusCode).toBe(200);
		expect(res.json.drafts).toEqual([
			{ text: 'first idea', length: 10 },
			{ text: 'second idea', length: 11 },
			{ text: 'third idea', length: 10 },
		]);
		expect(res.json.tone).toBe('hype');
		expect(llmComplete).toHaveBeenCalledTimes(3);
		// Persona context and the per-user LLM spend cap are both wired.
		expect(llmComplete.mock.calls[0][0].user).toContain('Agent name: Nova');
		expect(llmComplete.mock.calls[0][0].track).toMatchObject({ userId: 'user-1' });
	});

	it('splits a thread completion into thread_parts', async () => {
		queue.push([]); // no agent_identities row
		queue.push([]); // no avatars row
		llmComplete.mockResolvedValueOnce({ text: 'part one\n---\npart two\n---\npart three' });
		const res = await call(draft, { method: 'POST', url: '/api/x/draft', body: { thread: true } });
		expect(res.statusCode).toBe(200);
		expect(res.json.drafts[0].thread_parts).toEqual(['part one', 'part two', 'part three']);
	});

	it('caps a long completion at the tweet limit', async () => {
		llmComplete.mockResolvedValueOnce({ text: 'x'.repeat(400) });
		const res = await call(draft, { method: 'POST', url: '/api/x/draft', body: {} });
		expect(res.json.drafts[0].text).toHaveLength(280);
	});

	it('reports 503 when no LLM provider is available', async () => {
		llmComplete.mockRejectedValue(new LlmUnavailableError());
		const res = await call(draft, { method: 'POST', url: '/api/x/draft', body: {} });
		expect(res.statusCode).toBe(503);
		expect(res.json.error).toBe('llm_unavailable');
	});

	it('rejects an out-of-range count before spending a completion', async () => {
		const res = await call(draft, { method: 'POST', url: '/api/x/draft', body: { count: 9 } });
		expect(res.statusCode).toBe(400);
		expect(llmComplete).not.toHaveBeenCalled();
	});

	it('accepts a full thread pasted into the compose box but bounds what reaches the model', async () => {
		llmComplete.mockResolvedValue({ text: 'ok' });
		const wholeThread = 'x'.repeat(1500);
		expect((await call(draft, { method: 'POST', url: '/api/x/draft', body: { prompt: wholeThread } })).statusCode).toBe(200);
		const tooLong = await call(draft, { method: 'POST', url: '/api/x/draft', body: { prompt: 'x'.repeat(2001) } });
		expect(tooLong.statusCode).toBe(400);
		expect(llmComplete).toHaveBeenCalledTimes(1);
	});

	it('rejects an unknown tone', async () => {
		const res = await call(draft, { method: 'POST', url: '/api/x/draft', body: { tone: 'shakespearean' } });
		expect(res.statusCode).toBe(400);
	});

	it('is gated by CSRF and the draft rate limit', async () => {
		csrfOk = false;
		expect((await call(draft, { method: 'POST', url: '/api/x/draft', body: {} })).body).toBeNull();
		expect(llmComplete).not.toHaveBeenCalled();
		csrfOk = true;
		rateOk = false;
		const limited = await call(draft, { method: 'POST', url: '/api/x/draft', body: {} });
		expect(limited.statusCode).toBe(429);
		expect(llmComplete).not.toHaveBeenCalled();
	});
});

describe('POST /api/x/post', () => {
	it('publishes and returns the tweet envelope', async () => {
		publishTweet.mockResolvedValue({ tweet_id: '5', url: 'https://x.com/a/status/5', posts_used: 1, quota: 5, tier: 'free' });
		const res = await call(post, { method: 'POST', url: '/api/x/post', body: { text: 'hello', agent_id: AGENT } });
		expect(res.statusCode).toBe(200);
		expect(res.json.tweet_id).toBe('5');
		expect(publishTweet).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', text: 'hello' }));
	});

	it('maps an XPostError to its own status and code', async () => {
		publishTweet.mockRejectedValue(new XPostError('quota_exceeded', 'free tier limit reached', 402, { quota: 5 }));
		const res = await call(post, { method: 'POST', url: '/api/x/post', body: { text: 'hello' } });
		expect(res.statusCode).toBe(402);
		expect(res.json).toMatchObject({ error: 'quota_exceeded', quota: 5 });
	});
});

describe('/api/x/reviews', () => {
	it('claims the review before publishing so a concurrent approve cannot double post', async () => {
		queue.push([{ id: UUID, agent_id: AGENT, text: 'queued draft', thread_parts: null }]);
		publishTweet.mockResolvedValue({ tweet_id: '9', url: 'https://x.com/a/status/9' });
		const res = await call(reviews, { method: 'PATCH', url: `/api/x/reviews?id=${UUID}`, body: { action: 'approve' } });
		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({ approved: UUID, tweet_id: '9' });
		// The claim is a conditional UPDATE, not a SELECT.
		expect(sqlCalls[0]).toMatch(/update x_pending_reviews/);
		expect(sqlCalls[0]).toMatch(/status = 'pending'/);
	});

	it('releases the claim back to pending when publishing fails', async () => {
		queue.push([{ id: UUID, agent_id: AGENT, text: 'queued draft', thread_parts: null }]);
		publishTweet.mockRejectedValue(new XPostError('rate_limited', 'wait 3 more min', 429));
		const res = await call(reviews, { method: 'PATCH', url: `/api/x/reviews?id=${UUID}`, body: { action: 'approve' } });
		expect(res.statusCode).toBe(429);
		expect(sqlCalls[1]).toMatch(/status = 'pending'/);
	});

	it('404s an approve on a review that is already resolved', async () => {
		queue.push([]);
		const res = await call(reviews, { method: 'PATCH', url: `/api/x/reviews?id=${UUID}`, body: { action: 'approve' } });
		expect(res.statusCode).toBe(404);
		expect(publishTweet).not.toHaveBeenCalled();
	});

	it('rejects a non-uuid id instead of letting the cast 500', async () => {
		const res = await call(reviews, { method: 'DELETE', url: '/api/x/reviews?id=nope' });
		expect(res.statusCode).toBe(400);
		expect(sqlCalls).toHaveLength(0);
	});

	it('rejects a thread_parts override that is not an array of strings', async () => {
		const res = await call(reviews, {
			method: 'PATCH',
			url: `/api/x/reviews?id=${UUID}`,
			body: { action: 'approve', thread_parts: [1, 2] },
		});
		expect(res.statusCode).toBe(400);
		expect(sqlCalls).toHaveLength(0);
	});
});

describe('/api/x/schedule', () => {
	const future = () => new Date(Date.now() + 3_600_000).toISOString();

	it('queues a post for a connected account', async () => {
		queue.push([{ '?column?': 1 }]);            // social_connections check
		queue.push([{ count: 3 }]);                 // pending count
		queue.push([{ id: UUID, scheduled_at: future() }]);
		const res = await call(schedule, { method: 'POST', url: '/api/x/schedule', body: { text: 'later', scheduled_at: future(), agent_id: AGENT } });
		expect(res.statusCode).toBe(201);
		expect(res.json.id).toBe(UUID);
	});

	it('refuses to queue past the per-account ceiling', async () => {
		queue.push([{ '?column?': 1 }]);
		queue.push([{ count: 100 }]);
		const res = await call(schedule, { method: 'POST', url: '/api/x/schedule', body: { text: 'later', scheduled_at: future() } });
		expect(res.statusCode).toBe(409);
		expect(res.json.error).toBe('limit_reached');
	});

	it('rejects a schedule more than a year out', async () => {
		const res = await call(schedule, {
			method: 'POST',
			url: '/api/x/schedule',
			body: { text: 'later', scheduled_at: new Date(Date.now() + 400 * 86_400_000).toISOString() },
		});
		expect(res.statusCode).toBe(400);
	});

	it('rejects a non-uuid cancel id instead of letting the cast 500', async () => {
		const res = await call(schedule, { method: 'DELETE', url: '/api/x/schedule?id=nope' });
		expect(res.statusCode).toBe(400);
		expect(sqlCalls).toHaveLength(0);
	});
});

describe('/api/x/status', () => {
	it('reports connection, tier, and quota', async () => {
		getUserTier.mockResolvedValue({ tier: 'pro', quota: 100, min_interval_min: 5 });
		queue.push([{
			username: 'threews',
			posts_this_month: 4,
			month_resets_at: new Date(Date.now() + 86_400_000).toISOString(),
			connected_at: '2026-01-01T00:00:00.000Z',
			last_posted_at: null,
		}]);
		const res = await call(status, { url: '/api/x/status' });
		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({ connected: true, username: 'threews', tier: 'pro', quota: 100, posts_used: 4 });
	});

	it('reports a disconnected account without inventing a username', async () => {
		queue.push([]);
		const res = await call(status, { url: '/api/x/status' });
		expect(res.json).toEqual({ connected: false, tier: 'free', quota: 5 });
	});

	it('revokes seed consents on disconnect', async () => {
		const res = await call(status, { method: 'DELETE', url: '/api/x/status' });
		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({ disconnected: true, seed_consents_revoked: 2, seeded_memories_deleted: 7 });
		expect(revokeAllSeedConsentsForUser).toHaveBeenCalledWith('user-1', 'x_disconnected');
	});
});

describe('/api/x/triggers', () => {
	it('creates a trigger', async () => {
		queue.push([{ count: 2 }]);
		queue.push([{ id: UUID, kind: 'daily_persona', config: { hour_utc: 9 }, enabled: true, auto_publish: true }]);
		const res = await call(triggers, {
			method: 'POST',
			url: '/api/x/triggers',
			body: { kind: 'daily_persona', config: { hour_utc: 9 }, agent_id: AGENT },
		});
		expect(res.statusCode).toBe(201);
		expect(res.json.trigger.id).toBe(UUID);
	});

	it('rejects an out-of-range hour without a banned dash in the message', async () => {
		const res = await call(triggers, {
			method: 'POST',
			url: '/api/x/triggers',
			body: { kind: 'daily_persona', config: { hour_utc: 99 } },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json.error_description).toBe('hour_utc must be an integer from 0 to 23');
		// Escapes, not literals: the dash characters themselves are banned in this repo.
		expect(res.json.error_description).not.toMatch(/[\u2013\u2014]/);
	});

	it('refuses to create past the per-account ceiling', async () => {
		queue.push([{ count: 50 }]);
		const res = await call(triggers, {
			method: 'POST',
			url: '/api/x/triggers',
			body: { kind: 'weekly_digest', config: { day_of_week: 1, hour_utc: 9 } },
		});
		expect(res.statusCode).toBe(409);
	});

	it('rejects a non-uuid id instead of letting the cast 500', async () => {
		const res = await call(triggers, { method: 'DELETE', url: '/api/x/triggers?id=nope' });
		expect(res.statusCode).toBe(400);
		expect(sqlCalls).toHaveLength(0);
	});

	it('404s a patch on a trigger that vanished mid-request', async () => {
		queue.push([{ kind: 'daily_persona', config: { hour_utc: 9 } }]); // ownership read
		queue.push([]);                                                    // update matched nothing
		const res = await call(triggers, { method: 'PATCH', url: `/api/x/triggers?id=${UUID}`, body: { enabled: false } });
		expect(res.statusCode).toBe(404);
	});
});
