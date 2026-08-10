import { describe, it, expect, beforeEach, vi } from 'vitest';

// Both handlers run through the REAL api/_lib/http.js (wrap/cors/method/error/
// json), so these tests assert the status codes and JSON envelopes a client
// actually receives. Only the leaf dependencies are stubbed: the database, the
// session lookup, the rate limiter, and R2 URL building.

/** Rows each awaited `sql` template resolves to, in call order. */
let queued = [];
/** One entry per awaited query: { text, params }. */
let executed = [];

function queue(...rowSets) {
	queued.push(...rowSets);
}

vi.mock('../api/_lib/db.js', () => {
	const FRAGMENT = Symbol('testFragment');
	const isFragment = (v) => v != null && typeof v === 'object' && v[FRAGMENT] === true;

	// Mirrors api/_lib/db.js: nested fragments splice into the parent query, and
	// a fragment that is never awaited never runs. That is what lets these tests
	// prove the agent_id filter reaches Postgres only when it should.
	const flatten = (strings, values) => {
		let text = '';
		const params = [];
		const walk = (strs, vals) => {
			for (let i = 0; i < strs.length; i++) {
				text += strs[i];
				if (i < vals.length) {
					const v = vals[i];
					if (isFragment(v)) walk(v.strings, v.values);
					else {
						params.push(v);
						text += '$' + params.length;
					}
				}
			}
		};
		walk(strings, values);
		return { text: text.replace(/\s+/g, ' ').trim(), params };
	};

	const run = (strings, values) => {
		const { text, params } = flatten(strings, values);
		executed.push({ text, params });
		if (!queued.length) throw new Error(`unexpected query: ${text}`);
		return Promise.resolve(queued.shift());
	};

	const sql = (strings, ...values) => ({
		[FRAGMENT]: true,
		strings,
		values,
		then: (ok, no) => run(strings, values).then(ok, no),
		catch: (no) => run(strings, values).catch(no),
		finally: (fn) => run(strings, values).finally(fn),
	});

	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/r2.js', () => ({
	publicUrl: (key) => (key ? `https://r2.test/${key}` : null),
	thumbnailUrl: (key) => (key ? `https://r2.test/thumb/${key}` : null),
}));

const sessionUser = vi.fn(async () => null);
vi.mock('../api/_lib/auth.js', () => ({ getSessionUser: (...a) => sessionUser(...a) }));

const publicIp = vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: 0 }));
const authedReadIp = vi.fn(async () => ({ success: true, limit: 300, remaining: 299, reset: 0 }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '203.0.113.7',
	limits: {
		publicIp: (...a) => publicIp(...a),
		authedReadIp: (...a) => authedReadIp(...a),
	},
}));

const { default: creatorHandler } = await import('../api/creators/[id].js');
const { default: analyticsHandler } = await import('../api/creators/skill-analytics.js');

function mkReq({ method = 'GET', url = '/', query = {}, headers = {} } = {}) {
	return { method, url, query, headers, socket: { remoteAddress: '203.0.113.7' } };
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		headersSent: false,
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		removeHeader(k) {
			delete this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

const USER_ID = '86985f55-ad3d-4a06-a8c7-056704645dc0';
const AGENT_ID = '753649c5-18f1-4417-b5ea-0c2a53ff8806';

beforeEach(() => {
	queued = [];
	executed = [];
	sessionUser.mockReset().mockResolvedValue(null);
	publicIp.mockClear();
	authedReadIp.mockClear();
});

describe('GET /api/creators/:id', () => {
	function queueProfile({ username = null } = {}) {
		queue(
			[
				{
					id: USER_ID,
					display_name: 'Seed User',
					username,
					avatar_url: null,
					created_at: '2026-04-17T08:44:16.068Z',
				},
			],
			[
				{
					id: AGENT_ID,
					name: 'Demo Agent',
					description: 'Seed agent',
					category: 'utility',
					tags: ['demo'],
					avatar_id: 'a1',
					forks_count: 3,
					views_count: 91,
					published_at: '2026-05-01T00:00:00.000Z',
					created_at: '2026-04-20T00:00:00.000Z',
					skills: ['walk'],
					thumbnail_key: 'thumb-key.png',
					onchain: { network: 'solana' },
					has_paid_skills: true,
				},
			],
			[
				{
					id: 'av-1',
					slug: 'demo-avatar',
					name: 'Demo Avatar',
					description: 'A demo',
					storage_key: 'u/demo.glb',
					thumbnail_key: 'demo.png',
					tags: [],
					created_at: '2026-04-21T00:00:00.000Z',
				},
			],
			[{ agents_total: 21, avatars_total: 23, forks_total: 59, views_total: 2208 }],
		);
	}

	it('returns the creator, their published agents, and their public avatars', async () => {
		queueProfile({ username: 'seeduser' });
		const res = mkRes();
		await creatorHandler(mkReq({ url: `/api/creators/${USER_ID}`, query: { id: USER_ID } }), res);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('cache-control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
		const { data } = parse(res);
		expect(data.creator).toMatchObject({
			id: USER_ID,
			display_name: 'Seed User',
			username: 'seeduser',
			profile_url: '/@seeduser',
			totals: { agents: 21, avatars: 23, forks: 59, views: 2208 },
		});
		expect(data.agents).toHaveLength(1);
		expect(data.agents[0]).toMatchObject({
			id: AGENT_ID,
			thumbnail_url: 'https://r2.test/thumb/thumb-key.png',
			has_paid_skills: true,
			onchain: { network: 'solana' },
		});
		expect(data.avatars[0]).toMatchObject({
			glb_url: 'https://r2.test/u/demo.glb',
			thumbnail_url: 'https://r2.test/thumb/demo.png',
		});
	});

	it('omits profile_url when the creator has no username, rather than linking to a 404', async () => {
		// There is no /creators/:id page route, so the only real profile page is
		// /@handle. A handle-less creator must get null, not a dead link.
		queueProfile({ username: null });
		const res = mkRes();
		await creatorHandler(mkReq({ url: `/api/creators/${USER_ID}`, query: { id: USER_ID } }), res);

		expect(res.statusCode).toBe(200);
		expect(parse(res).data.creator.profile_url).toBeNull();
	});

	it('404s a malformed id without touching the database', async () => {
		const res = mkRes();
		await creatorHandler(mkReq({ url: '/api/creators/not-a-uuid', query: { id: 'not-a-uuid' } }), res);

		expect(res.statusCode).toBe(404);
		expect(parse(res)).toEqual({ error: 'not_found', error_description: 'creator not found' });
		expect(executed).toHaveLength(0);
	});

	it('404s a well-formed id with no matching user', async () => {
		queue([]);
		const res = mkRes();
		const id = '11111111-1111-4111-8111-111111111111';
		await creatorHandler(mkReq({ url: `/api/creators/${id}`, query: { id } }), res);

		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('not_found');
	});

	it('rejects non-GET methods', async () => {
		const res = mkRes();
		await creatorHandler(
			mkReq({ method: 'POST', url: `/api/creators/${USER_ID}`, query: { id: USER_ID } }),
			res,
		);
		expect(res.statusCode).toBe(405);
	});

	it('answers 429 when the public IP limiter trips', async () => {
		publicIp.mockResolvedValueOnce({ success: false, limit: 60, remaining: 0, reset: Date.now() + 1000 });
		const res = mkRes();
		await creatorHandler(mkReq({ url: `/api/creators/${USER_ID}`, query: { id: USER_ID } }), res);

		expect(res.statusCode).toBe(429);
		expect(executed).toHaveLength(0);
	});
});

describe('GET /api/creators/skill-analytics', () => {
	const SESSION = { id: USER_ID, email: 'creator@three.ws' };

	function queueAnalytics() {
		queue(
			[
				{
					agent_id: AGENT_ID,
					agent_name: 'Demo Agent',
					skill_name: 'walk',
					total_calls: 42,
					unique_users: 9,
					successes: 40,
					failures: 2,
					avg_execution_ms: 118,
					success_rate_pct: 95.2,
				},
			],
			[{ total_calls: 42, unique_users: 9, successes: 40 }],
			[{ date: '2026-08-09', calls: 12 }],
		);
	}

	it('401s an anonymous caller', async () => {
		const res = mkRes();
		await analyticsHandler(mkReq({ url: '/api/creators/skill-analytics' }), res);

		expect(res.statusCode).toBe(401);
		expect(parse(res)).toEqual({ error: 'unauthorized', error_description: 'sign in required' });
		expect(executed).toHaveLength(0);
	});

	it('returns per-skill totals, a summary, and the daily series', async () => {
		sessionUser.mockResolvedValue(SESSION);
		queueAnalytics();
		const res = mkRes();
		await analyticsHandler(mkReq({ url: '/api/creators/skill-analytics' }), res);

		expect(res.statusCode).toBe(200);
		const { data } = parse(res);
		expect(data.period_days).toBe(30);
		expect(data.summary).toEqual({ total_calls: 42, unique_users: 9, successes: 40 });
		expect(data.by_skill[0]).toMatchObject({ skill_name: 'walk', total_calls: 42, success_rate_pct: 95.2 });
		expect(data.daily).toEqual([{ date: '2026-08-09', calls: 12 }]);
		// No agent filter: the optional fragment must not reach the query text.
		expect(executed.every((q) => !q.text.includes('AND sul.agent_id'))).toBe(true);
	});

	it('400s a non-UUID agent_id instead of failing the uuid cast in Postgres', async () => {
		sessionUser.mockResolvedValue(SESSION);
		const res = mkRes();
		await analyticsHandler(
			mkReq({ url: '/api/creators/skill-analytics?agent_id=not-a-uuid', query: { agent_id: 'not-a-uuid' } }),
			res,
		);

		expect(res.statusCode).toBe(400);
		expect(parse(res)).toEqual({
			error: 'invalid_agent_id',
			error_description: 'agent_id must be a UUID',
		});
		expect(executed).toHaveLength(0);
	});

	it('400s a repeated agent_id param, which arrives as an array', async () => {
		sessionUser.mockResolvedValue(SESSION);
		const res = mkRes();
		await analyticsHandler(
			mkReq({ url: '/api/creators/skill-analytics', query: { agent_id: ['x', 'y'] } }),
			res,
		);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_agent_id');
		expect(executed).toHaveLength(0);
	});

	it('403s an agent the caller does not own', async () => {
		sessionUser.mockResolvedValue(SESSION);
		queue([]);
		const res = mkRes();
		await analyticsHandler(
			mkReq({ url: '/api/creators/skill-analytics', query: { agent_id: AGENT_ID } }),
			res,
		);

		expect(res.statusCode).toBe(403);
		expect(parse(res)).toEqual({ error: 'forbidden', error_description: 'not your agent' });
		expect(executed).toHaveLength(1);
	});

	it('splices the agent filter into every aggregate once ownership checks out', async () => {
		sessionUser.mockResolvedValue(SESSION);
		queue([{ id: AGENT_ID }]);
		queueAnalytics();
		const res = mkRes();
		await analyticsHandler(
			mkReq({ url: '/api/creators/skill-analytics', query: { agent_id: AGENT_ID } }),
			res,
		);

		expect(res.statusCode).toBe(200);
		const aggregates = executed.slice(1);
		expect(aggregates).toHaveLength(3);
		for (const q of aggregates) {
			expect(q.text).toContain('AND sul.agent_id =');
			expect(q.params).toContain(AGENT_ID);
		}
	});

	it('clamps the lookback window to 1..365 days and falls back to 30 on junk', async () => {
		sessionUser.mockResolvedValue(SESSION);
		const windowFor = async (query) => {
			queueAnalytics();
			const res = mkRes();
			await analyticsHandler(mkReq({ url: '/api/creators/skill-analytics', query }), res);
			expect(res.statusCode).toBe(200);
			return parse(res).data.period_days;
		};

		expect(await windowFor({ days: '7' })).toBe(7);
		expect(await windowFor({ days: '99999' })).toBe(365);
		expect(await windowFor({ days: 'abc' })).toBe(30);
		expect(await windowFor({})).toBe(30);
		// A negative window used to push `since` into the future, so every panel
		// rendered permanently empty behind a 200.
		expect(await windowFor({ days: '-5' })).toBe(30);
		expect(await windowFor({ days: '0' })).toBe(30);
		// Repeated key: req.query hands over an array; the first value wins.
		expect(await windowFor({ days: ['7', '9'] })).toBe(7);
	});

	it('answers 429 when the authed read limiter trips, before any query runs', async () => {
		sessionUser.mockResolvedValue(SESSION);
		authedReadIp.mockResolvedValueOnce({ success: false, limit: 300, remaining: 0, reset: Date.now() + 1000 });
		const res = mkRes();
		await analyticsHandler(mkReq({ url: '/api/creators/skill-analytics' }), res);

		expect(res.statusCode).toBe(429);
		expect(executed).toHaveLength(0);
	});

	it('rejects non-GET methods', async () => {
		const res = mkRes();
		await analyticsHandler(mkReq({ method: 'POST', url: '/api/creators/skill-analytics' }), res);
		expect(res.statusCode).toBe(405);
	});
});
