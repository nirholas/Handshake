import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Mocks ─────────────────────────────────────────────────────────────────

const authState = { session: null, bearer: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
}));

const sqlState = { queue: [], calls: [] };

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		if (sqlState.queue.length === 0) return [];
		return sqlState.queue.shift();
	}),
}));

const rlState = { success: true };

vi.mock('../../api/_lib/rate-limit.js', () => ({
	clientIp: vi.fn(() => '127.0.0.1'),
	limits: { widgetRead: vi.fn(async () => ({ success: rlState.success })) },
}));

const { default: handler } = await import('../../api/agents/[id]/skill-access.js');

const AGENT_ID = 'e74a21aa-5b30-4d3e-989a-485a4aecd498';

function makeReq({ method = 'GET', url, headers = {} } = {}) {
	const req = Readable.from([]);
	req.method = method;
	req.url = url;
	req.headers = { host: 'localhost', ...headers };
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(reqOpts) {
	const req = makeReq(reqOpts);
	const res = makeRes();
	await handler(req, res);
	const body = res.body ? JSON.parse(res.body) : null;
	return { res, status: res.statusCode, body };
}

beforeEach(() => {
	authState.session = null;
	authState.bearer = null;
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.success = true;
});

describe('GET /api/agents/:id/skill-access', () => {
	it('404s on a non-UUID id', async () => {
		const { status, body } = await invoke({ url: '/api/agents/not-a-uuid/skill-access?id=not-a-uuid' });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('404s when the agent does not exist', async () => {
		sqlState.queue.push([]); // agent lookup → empty
		const { status, body } = await invoke({ url: `/api/agents/${AGENT_ID}/skill-access?id=${AGENT_ID}` });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('returns prices with empty purchases for an anonymous viewer of an unpublished agent', async () => {
		sqlState.queue.push([{ id: AGENT_ID }]); // agent exists (publication state irrelevant)
		sqlState.queue.push([
			{ skill: 'translate', currency_mint: 'USDC', chain: 'solana', amount: 1000, mint_decimals: 6, trial_uses: 2, time_pass_hours: null, time_pass_amount: null },
		]);

		const { status, body } = await invoke({ url: `/api/agents/${AGENT_ID}/skill-access?id=${AGENT_ID}` });

		expect(status).toBe(200);
		expect(body.data.purchased_skills).toEqual([]);
		expect(body.data.skill_prices.translate).toMatchObject({
			amount: 1000,
			currency_mint: 'USDC',
			chain: 'solana',
			mint_decimals: 6,
			trial_uses: 2,
		});
	});

	it('includes confirmed purchases for an authenticated caller', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue.push([{ id: AGENT_ID }]);
		sqlState.queue.push([{ skill: 'translate', currency_mint: 'USDC', chain: 'solana', amount: 1000, mint_decimals: 6 }]);
		sqlState.queue.push([{ skill: 'translate' }]);

		const { status, body } = await invoke({ url: `/api/agents/${AGENT_ID}/skill-access?id=${AGENT_ID}` });

		expect(status).toBe(200);
		expect(body.data.purchased_skills).toEqual(['translate']);
	});

	it('429s when rate limited', async () => {
		rlState.success = false;
		const { status, body } = await invoke({ url: `/api/agents/${AGENT_ID}/skill-access?id=${AGENT_ID}` });
		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});
