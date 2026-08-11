// GET /api/agents/public?avatar=1 must return only agents whose avatar GLB is
// publicly readable. Surfaces that render or export the model itself (the Claude
// artifact builder at /artifact, embeds) offer these agents as one-click picks,
// and an agent with no avatar, or with a private one, can only ever fail there.
//
// The filter is a bound boolean inside the WHERE clause, so this test renders the
// tagged-template query with its bound values interleaved and asserts both halves
// of the contract: the predicate is in the SQL, and the flag flips with the param.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: async () => ({ success: true }) },
	clientIp: () => '127.0.0.1',
}));
vi.mock('../../api/_lib/r2.js', () => ({
	thumbnailUrl: (key) => `https://cdn.example/${key}`,
	publicUrl: (key) => `https://cdn.example/${key}`,
}));

const calls = [];
const ROWS = [
	{
		id: '27a0f649-3b59-4552-bb0b-faf616ac448b',
		name: 'Axis Signal Lab',
		description: null,
		skills: [],
		home_url: null,
		chat_count: 0,
		created_at: '2026-07-01T00:00:00.000Z',
		meta: {},
		erc8004_agent_id: null,
		chain_id: null,
		avatar_thumbnail_key: 'u/1/thumb.png',
		avatar_visibility: 'public',
	},
];

vi.mock('../../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		calls.push({ strings, values });
		return Promise.resolve(ROWS);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

function makeReq(qs) {
	return { url: `/api/agents/public${qs}`, method: 'GET', headers: { host: 'three.ws' } };
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(body) {
			this._body = body;
			this.writableEnded = true;
		},
	};
}

// Interleave the bound values back into the template so a predicate can be read
// together with the flag that gates it.
function render(call) {
	return call.strings.reduce(
		(acc, part, i) => acc + part + (i < call.values.length ? `<<${String(call.values[i])}>>` : ''),
		'',
	);
}

const FILTER_ON =
	/and \(<<false>> or \(\s*a\.storage_key is not null\s*and a\.visibility in \('public', 'unlisted'\)/i;
const FILTER_OFF = /and \(<<true>> or \(\s*a\.storage_key is not null/i;

function agentQuery() {
	return calls.map(render).find((q) => /a\.storage_key is not null/i.test(q));
}

let handler;

beforeEach(async () => {
	calls.length = 0;
	vi.resetModules();
	const mod = await import('../../api/agents/public.js');
	handler = mod.default;
});

describe('GET /api/agents/public?avatar=1', () => {
	it('leaves the filter off when avatar is not requested', async () => {
		const res = makeRes();
		await handler(makeReq('?sort=popular&limit=5'), res);
		expect(res.statusCode).toBe(200);
		expect(agentQuery()).toMatch(FILTER_OFF);
	});

	it('turns the filter on for avatar=1', async () => {
		const res = makeRes();
		await handler(makeReq('?sort=popular&limit=5&avatar=1'), res);
		expect(res.statusCode).toBe(200);
		expect(agentQuery()).toMatch(FILTER_ON);
	});

	it('accepts avatar=true as well', async () => {
		const res = makeRes();
		await handler(makeReq('?sort=popular&avatar=true'), res);
		expect(agentQuery()).toMatch(FILTER_ON);
	});

	it('applies the same filter to the live wall', async () => {
		const res = makeRes();
		await handler(makeReq('?sort=live&avatar=1'), res);
		expect(res.statusCode).toBe(200);
		expect(agentQuery()).toMatch(FILTER_ON);
	});

	it('still returns mapped agents with the filter on', async () => {
		const res = makeRes();
		await handler(makeReq('?sort=popular&avatar=1'), res);
		const agents = JSON.parse(res._body).agents;
		expect(agents).toHaveLength(1);
		expect(agents[0].id).toBe('27a0f649-3b59-4552-bb0b-faf616ac448b');
		expect(agents[0].avatar_thumbnail).toBe('https://cdn.example/u/1/thumb.png');
	});
});
