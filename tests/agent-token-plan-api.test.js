// The HTTP contract of the agent-token plan and the launch binding it closes
// (api/agents/tokens/[action].js).
//
// Two properties are load-bearing here:
//
//   1. A draft plan is the owner's private workbench. Before this surface
//      existed nothing on an agent could carry an unlaunched ticker at all, and
//      the moment one can, a visitor must not be able to read it off the profile
//      of an agent they do not own.
//
//   2. A confirmed launch must land in the platform's launch directory. Coins
//      launched from the user's own wallet through this path used to write only
//      agent_identities.meta.token, so they were invisible to /launches, to the
//      agent profile's launch history, and to GET /api/v1/pump/launches. The
//      pump_agent_mints insert here is what makes an agent token show up as one.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const STRANGER_ID = '55555555-5555-4555-8555-555555555555';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
// A clearly-synthetic mint placeholder: never a real third-party address.
const PLACEHOLDER_MINT = 'THREEsynthetic1111111111111111111111111111';

const authState = { session: null };
const sqlState = { queue: [], calls: [] };

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	isSameSiteOrigin: vi.fn(() => true),
}));

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ text: strings.join('?'), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true })),
		authedReadIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// A confirmed, successful on-chain launch. The handler only reads the account
// keys and the error field, so this is the whole surface it touches.
const parsedTx = {
	meta: { err: null },
	transaction: { message: { accountKeys: [{ pubkey: PLACEHOLDER_MINT }, { pubkey: WALLET }] } },
};
vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaConnection: vi.fn(() => ({ getParsedTransaction: vi.fn(async () => parsedTx) })),
}));

vi.mock('../api/_lib/r2.js', () => ({
	r2: { send: vi.fn(async () => ({})) },
	publicUrl: vi.fn((k) => `https://cdn.test/${k}`),
}));

const handler = (await import('../api/agents/tokens/[action].js')).default;

function call(action, { method = 'GET', url, body } = {}) {
	const raw = body === undefined ? Buffer.from('') : Buffer.from(JSON.stringify(body));
	const req = Readable.from([raw]);
	req.method = method;
	req.url = url || `/api/agents/tokens/${action}`;
	req.headers = { host: 'localhost', 'content-type': 'application/json' };
	req.query = { action };
	const res = {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
	return handler(req, res).then(() => ({
		status: res.statusCode,
		headers: res.headers,
		payload: res.body ? JSON.parse(res.body) : null,
	}));
}

const agentRow = () => [{
	id: AGENT_ID, name: 'Ada', user_id: OWNER_ID, wallet_address: WALLET,
	meta: { onchain: { family: 'solana', wallet: WALLET } },
}];

const planRow = (over = {}) => ({
	id: 'plan-1', agent_id: AGENT_ID, network: 'mainnet',
	name: 'Ada Ledger', symbol: 'ADA', description: 'ledger of a working agent',
	image_url: null, website: null, twitter: null, telegram: null,
	coin_type: 'agent', quote_currency: 'sol', buyback_bps: 2500,
	sol_buy_in: '0.500000000', usdc_buy_in: '0.000000', status: 'ready',
	mint: null, launched_at: null, last_dry_run: null, last_dry_run_at: null,
	...over,
});

beforeEach(() => {
	authState.session = null;
	sqlState.queue = [];
	sqlState.calls = [];
});

describe('GET /api/agents/tokens/plan', () => {
	it('shows a ready plan to a signed-out visitor', async () => {
		authState.session = null;
		sqlState.queue.push(agentRow(), [planRow()]);
		const { status, payload } = await call('plan', { url: `/api/agents/tokens/plan?agent_id=${AGENT_ID}` });
		expect(status).toBe(200);
		expect(payload.is_owner).toBe(false);
		expect(payload.plan.symbol).toBe('ADA');
		// A visitor never learns the wallet that would sign the launch.
		expect(payload.launch_wallet).toBeNull();
	});

	it('hides a draft plan from anyone but the owner', async () => {
		authState.session = { id: STRANGER_ID };
		sqlState.queue.push(agentRow(), [planRow({ status: 'draft', symbol: 'SECRET' })]);
		const { status, payload } = await call('plan', { url: `/api/agents/tokens/plan?agent_id=${AGENT_ID}` });
		expect(status).toBe(200);
		expect(payload.plan).toBeNull();
	});

	it('shows the owner their own draft, with the launch wallet', async () => {
		authState.session = { id: OWNER_ID };
		sqlState.queue.push(agentRow(), [planRow({ status: 'draft', symbol: 'SECRET' })]);
		const { status, payload } = await call('plan', { url: `/api/agents/tokens/plan?agent_id=${AGENT_ID}` });
		expect(status).toBe(200);
		expect(payload.is_owner).toBe(true);
		expect(payload.plan.symbol).toBe('SECRET');
		expect(payload.launch_wallet).toBe(WALLET);
	});

	it('never lets a shared cache hold the answer, since ownership changes it', async () => {
		authState.session = { id: OWNER_ID };
		sqlState.queue.push(agentRow(), [planRow()]);
		const { headers } = await call('plan', { url: `/api/agents/tokens/plan?agent_id=${AGENT_ID}` });
		expect(headers['cache-control']).toMatch(/private|no-store/);
	});

	it('404s an agent that does not exist', async () => {
		sqlState.queue.push([]);
		const { status } = await call('plan', { url: `/api/agents/tokens/plan?agent_id=${AGENT_ID}` });
		expect(status).toBe(404);
	});
});

describe('PUT /api/agents/tokens/plan', () => {
	const saveBody = { agent_id: AGENT_ID, network: 'mainnet', name: 'Ada Ledger', symbol: 'ada', coin_type: 'agent', buyback_bps: 2500 };

	it('refuses a caller who does not own the agent', async () => {
		authState.session = { id: STRANGER_ID };
		sqlState.queue.push(agentRow());
		const { status, payload } = await call('plan', { method: 'PUT', body: saveBody });
		expect(status).toBe(403);
		expect(payload.error).toBe('forbidden');
		// The rejection happened before any write.
		expect(sqlState.calls).toHaveLength(1);
	});

	it('saves the owner an upper-cased ticker and reports readiness', async () => {
		authState.session = { id: OWNER_ID };
		sqlState.queue.push(agentRow(), [], [planRow()]);
		const { status, payload } = await call('plan', { method: 'PUT', body: saveBody });
		expect(status).toBe(200);
		expect(payload.plan.symbol).toBe('ADA');
		expect(payload.plan.readiness.ready).toBe(true);
		expect(sqlState.calls.some((c) => /insert into agent_token_plans/.test(c.text))).toBe(true);
	});

	it('401s a signed-out caller', async () => {
		authState.session = null;
		const { status } = await call('plan', { method: 'PUT', body: saveBody });
		expect(status).toBe(401);
	});
});

describe('POST /api/agents/tokens/launch-confirm', () => {
	const confirmBody = { prep_id: 'prep-abc-123', tx_signature: 'a'.repeat(64), wallet_address: WALLET };
	const prep = {
		id: 'prep-abc-123', agent_id: AGENT_ID, mint: PLACEHOLDER_MINT,
		metadata_uri: 'https://cdn.test/tm/abc.json', cluster: 'devnet',
		payload: { name: 'Ada Ledger', symbol: 'ADA', description: '', image: '', wallet_address: WALLET, initial_buy_sol: 0 },
	};

	it('registers the coin in the launch directory and marks the plan launched', async () => {
		authState.session = { id: OWNER_ID };
		sqlState.queue.push(
			[prep],                                                     // prep lookup
			[{ id: AGENT_ID, meta: {} }],                               // agent re-check
			[],                                                         // pump_agent_mints insert
			[planRow({ status: 'launched', mint: PLACEHOLDER_MINT })],  // markPlanLaunched
			[{ id: AGENT_ID, name: 'Ada', meta: {} }],                  // agent meta update
			[],                                                         // prep delete
		);

		const { status, payload } = await call('launch-confirm', { method: 'POST', body: confirmBody });
		expect(status).toBe(201);

		const insert = sqlState.calls.find((c) => /insert into[\s\S]*pump_agent_mints/.test(c.text));
		expect(insert).toBeTruthy();
		expect(insert.values).toContain(PLACEHOLDER_MINT);
		expect(insert.values).toContain('devnet');
		// This path creates no on-chain pump agent, so it must not claim a buyback.
		expect(insert.values).toContain(0);

		expect(payload.plan.status).toBe('launched');
		expect(payload.plan.mint).toBe(PLACEHOLDER_MINT);
	});

	it('registers the launch before flipping the agent record, so a retry stays possible', async () => {
		authState.session = { id: OWNER_ID };
		sqlState.queue.push(
			[prep],
			[{ id: AGENT_ID, meta: {} }],
			[],
			[],
			[{ id: AGENT_ID, name: 'Ada', meta: {} }],
			[],
		);
		await call('launch-confirm', { method: 'POST', body: confirmBody });

		const insertAt = sqlState.calls.findIndex((c) => /insert into[\s\S]*pump_agent_mints/.test(c.text));
		const metaUpdateAt = sqlState.calls.findIndex((c) => /update agent_identities/.test(c.text));
		expect(insertAt).toBeGreaterThan(-1);
		expect(metaUpdateAt).toBeGreaterThan(insertAt);
	});
});
