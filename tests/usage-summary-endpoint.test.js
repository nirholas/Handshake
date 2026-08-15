import { describe, it, expect, beforeEach, vi } from 'vitest';

// GET /api/usage/summary runs through the REAL api/_lib/http.js (wrap/cors/
// method/error/json), so these tests assert the exact status codes and JSON
// envelope a dashboard client receives. Only the leaf dependencies are stubbed:
// the database and the two auth paths (session cookie, bearer token).
//
// The load-bearing assertions are the ones the /dashboard/settings "LLM usage"
// panel depends on: an `llm` block with calls_month / tokens_month / by_model,
// and plan quotas as JSON numbers rather than the strings Postgres returns for
// bigint columns.

/** Rows each awaited `sql` template resolves to, in call order. */
let queued = [];
/** One entry per awaited query: { text, params }. */
let executed = [];

function queue(...rowSets) {
	queued.push(...rowSets);
}

vi.mock('../api/_lib/db.js', () => {
	const flatten = (strings, values) => {
		let text = '';
		const params = [];
		for (let i = 0; i < strings.length; i++) {
			text += strings[i];
			if (i < values.length) {
				params.push(values[i]);
				text += '$' + params.length;
			}
		}
		return { text: text.replace(/\s+/g, ' ').trim(), params };
	};

	const run = (strings, values) => {
		const { text, params } = flatten(strings, values);
		executed.push({ text, params });
		if (!queued.length) throw new Error(`unexpected query: ${text}`);
		return Promise.resolve(queued.shift());
	};

	const sql = (strings, ...values) => ({
		then: (ok, no) => run(strings, values).then(ok, no),
		catch: (no) => run(strings, values).catch(no),
		finally: (fn) => run(strings, values).finally(fn),
	});

	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

const sessionUser = vi.fn(async () => null);
const bearerAuth = vi.fn(async () => null);
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => sessionUser(...a),
	authenticateBearer: (...a) => bearerAuth(...a),
	extractBearer: (req) => {
		const h = req.headers?.authorization || '';
		return h.startsWith('Bearer ') ? h.slice(7) : null;
	},
	hasScope: (granted, want) => String(granted || '').split(/\s+/).includes(want),
}));

const { default: handler } = await import('../api/usage/summary.js');

const USER_ID = 'ab2aabd2-39f7-493b-8191-c9f174af62ab';

function mkReq({ method = 'GET', headers = {} } = {}) {
	return { method, url: '/api/usage/summary', query: {}, headers, socket: { remoteAddress: '203.0.113.7' } };
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

// Postgres hands bigint columns back as strings through the Neon driver; these
// fixtures reproduce that so the numeric coercion is actually under test.
function queueQuotaAndModels({ models = [] } = {}) {
	queue(
		[
			{
				plan: 'free',
				max_avatars: 10,
				max_bytes_per_avatar: '26214400',
				max_total_bytes: '262144000',
				mcp_calls_per_day: 1000,
				updated_at: '2026-06-27T23:07:47.119Z',
				avatars: '1',
				bytes: '1234540',
				mcp_calls_24h: '0',
				events_30d: '45',
			},
		],
		models,
	);
}

beforeEach(() => {
	queued = [];
	executed = [];
	sessionUser.mockReset().mockResolvedValue(null);
	bearerAuth.mockReset().mockResolvedValue(null);
});

describe('GET /api/usage/summary', () => {
	it('returns plan quotas, counts, and the LLM roll-up for a session user', async () => {
		sessionUser.mockResolvedValue({ id: USER_ID });
		queueQuotaAndModels({
			models: [
				{ model: 'gemini-3.1-flash-lite', calls: '5', tokens: '4490', cost_micro_usd: '0' },
				{ model: 'claude-opus-5', calls: '2', tokens: '1200', cost_micro_usd: '31000' },
			],
		});

		const res = mkRes();
		await handler(mkReq(), res);

		expect(res.statusCode).toBe(200);
		const body = parse(res);

		// bigint columns arrive as strings; the client does arithmetic on them.
		expect(body.plan).toEqual({
			plan: 'free',
			max_avatars: 10,
			max_bytes_per_avatar: 26214400,
			max_total_bytes: 262144000,
			mcp_calls_per_day: 1000,
			updated_at: '2026-06-27T23:07:47.119Z',
		});
		expect(body.counts).toEqual({ avatars: 1, bytes: 1234540, mcp_calls_24h: 0, events_30d: 45 });

		// Totals are summed over every model group, not just the first.
		expect(body.llm.calls_month).toBe(7);
		expect(body.llm.tokens_month).toBe(5690);
		expect(body.llm.cost_micro_usd_month).toBe(31000);
		expect(body.llm.by_model).toEqual([
			{ model: 'gemini-3.1-flash-lite', calls: 5, tokens: 4490, cost_micro_usd: 0 },
			{ model: 'claude-opus-5', calls: 2, tokens: 1200, cost_micro_usd: 31000 },
		]);

		// The model roll-up is scoped to this user, kind='llm', and this month.
		const modelQuery = executed[1];
		expect(modelQuery.params).toEqual([USER_ID]);
		expect(modelQuery.text).toContain("kind = 'llm'");
		expect(modelQuery.text).toContain("date_trunc('month', now())");
	});

	it('reports zeroes rather than nulls when the account has no LLM usage', async () => {
		sessionUser.mockResolvedValue({ id: USER_ID });
		queueQuotaAndModels({ models: [] });

		const res = mkRes();
		await handler(mkReq(), res);

		expect(res.statusCode).toBe(200);
		expect(parse(res).llm).toEqual({
			calls_month: 0,
			tokens_month: 0,
			cost_micro_usd_month: 0,
			by_model: [],
		});
	});

	it('accepts a bearer token that carries the profile scope', async () => {
		bearerAuth.mockResolvedValue({ userId: USER_ID, scope: 'profile avatars:read' });
		queueQuotaAndModels();

		const res = mkRes();
		await handler(mkReq({ headers: { authorization: 'Bearer sk_test_valid' } }), res);

		expect(res.statusCode).toBe(200);
		expect(parse(res).plan.plan).toBe('free');
	});

	it('rejects a bearer token without the profile scope', async () => {
		bearerAuth.mockResolvedValue({ userId: USER_ID, scope: 'avatars:read' });

		const res = mkRes();
		await handler(mkReq({ headers: { authorization: 'Bearer sk_test_wrong_scope' } }), res);

		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
		expect(executed).toHaveLength(0);
	});

	it('rejects an unauthenticated request before touching the database', async () => {
		const res = mkRes();
		await handler(mkReq(), res);

		expect(res.statusCode).toBe(401);
		expect(parse(res)).toEqual({ error: 'unauthorized', error_description: 'authentication required' });
		expect(executed).toHaveLength(0);
	});

	it('rejects a non-GET method with a JSON envelope, not a stack trace', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'POST' }), res);

		expect(res.statusCode).toBe(405);
		expect(parse(res).error).toBe('method_not_allowed');
		expect(executed).toHaveLength(0);
	});

	it('surfaces a clear error when the plan has no quota row', async () => {
		sessionUser.mockResolvedValue({ id: USER_ID });
		queue([], []);

		const res = mkRes();
		await handler(mkReq(), res);

		expect(res.statusCode).toBe(500);
		expect(parse(res).error).toBe('internal');
	});
});
