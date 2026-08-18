import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Mocks ─────────────────────────────────────────────────────────────────
// All external deps are mocked so the handler is exercised in pure-unit mode.

const authState = {
	session: null,
	bearer: null,
};

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
}));

// Agent creation is CSRF-gated for cookie sessions (like the other mutations);
// the gate itself is covered in security-csrf-gates.test.js.
vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

// `sql` is a tagged-template function. The mock returns whatever
// `sqlState.nextResult` is set to (or the next in a queue).
const sqlState = {
	queue: [],
	calls: [],
};

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		// Supports both `sql\`...\`` tagged-template form and `sql(text, params)` form.
		if (typeof strings === 'string') {
			sqlState.calls.push({ query: strings, values: values[0] ?? [] });
		} else {
			sqlState.calls.push({ query: strings.join('?'), values });
		}
		if (sqlState.queue.length === 0) return [];
		return sqlState.queue.shift();
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/agent-wallet.js', () => ({
	generateAgentWallet: vi.fn(async () => ({
		address: '0xabc0000000000000000000000000000000000001',
		encrypted_key: 'enc-key-stub',
	})),
	generateSolanaAgentWallet: vi.fn(async () => ({
		address: 'SolAddr111111111111111111111111111111111111',
		encrypted_secret: 'enc-sol-secret-stub',
	})),
	recoverSolanaAgentKeypair: vi.fn(async () => ({
		publicKey: { toBase58: () => 'SolAddr111111111111111111111111111111111111' },
		secretKey: new Uint8Array(64),
	})),
}));

// Import the handler AFTER mocks are declared.
const { default: handler } = await import('../../api/agents.js');

// ── Test helpers ──────────────────────────────────────────────────────────

function makeReq({ method = 'GET', url = '/api/agents', headers = {}, body = null } = {}) {
	const base = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = method;
	base.url = url;
	base.headers = {
		host: 'localhost',
		...(body ? { 'content-type': 'application/json' } : {}),
		...headers,
	};
	return base;
}

function makeRes() {
	const res = {
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
	return res;
}

async function invoke(reqOpts) {
	const req = makeReq(reqOpts);
	const res = makeRes();
	await handler(req, res);
	const payload = res.body ? JSON.parse(res.body) : null;
	return { res, status: res.statusCode, body: payload };
}

// ── Reset between tests ───────────────────────────────────────────────────

beforeEach(() => {
	authState.session = null;
	authState.bearer = null;
	sqlState.queue = [];
	sqlState.calls = [];
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('GET /api/agents — list', () => {
	it('returns 401 when unauthenticated', async () => {
		const { status, body } = await invoke({ method: 'GET', url: '/api/agents' });
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('returns caller agents when authenticated via session', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue.push([
			{
				id: 'agent-1',
				user_id: 'user-1',
				name: 'Alpha',
				description: 'first',
				avatar_id: null,
				home_url: null,
				skills: ['greet'],
				meta: { encrypted_wallet_key: 'SECRET' },
				wallet_address: '0xabc',
				chain_id: 1,
				erc8004_agent_id: null,
				erc8004_registry: null,
				registration_cid: null,
				created_at: '2024-01-01T00:00:00Z',
			},
		]);

		const { status, body } = await invoke({ method: 'GET', url: '/api/agents' });

		expect(status).toBe(200);
		expect(body.agents).toHaveLength(1);
		expect(body.agents[0].id).toBe('agent-1');
		expect(body.agents[0].name).toBe('Alpha');
		expect(body.agents[0].home_url).toBe('/agents/agent-1');
		// decorate() must strip encrypted_wallet_key from meta
		expect(body.agents[0].meta.encrypted_wallet_key).toBeUndefined();
		// Owner sees their own wallet_address
		expect(body.agents[0].wallet_address).toBe('0xabc');
	});

	it('accepts bearer token as auth source', async () => {
		authState.bearer = { userId: 'user-2' };
		sqlState.queue.push([]);
		const { status, body } = await invoke({ method: 'GET', url: '/api/agents' });
		expect(status).toBe(200);
		expect(body.agents).toEqual([]);
	});

	it('exposes walletReady + public solana_address (never the secret)', async () => {
		authState.session = { id: 'user-1' };
		const SOL = 'So11111111111111111111111111111111111111112';
		sqlState.queue.push([
			{
				id: 'agent-w',
				user_id: 'user-1',
				name: 'Walleted',
				skills: [],
				meta: { solana_address: SOL, encrypted_solana_secret: 'ZW5jcnlwdGVk' },
				created_at: '2024-01-01T00:00:00Z',
			},
		]);

		const { status, body } = await invoke({ method: 'GET', url: '/api/agents' });
		expect(status).toBe(200);
		const a = body.agents[0];
		expect(a.solana_address).toBe(SOL);
		expect(a.walletReady).toBe(true);
		expect(a.wallet_ready).toBe(true);
		// The encrypted secret must never reach the client.
		expect(a.meta.encrypted_solana_secret).toBeUndefined();
		expect(JSON.stringify(a)).not.toMatch(/encrypted_solana_secret/);
	});

	it('reports walletReady=false and null solana_address for a legacy wallet-less agent', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue.push([
			{
				id: 'agent-legacy',
				user_id: 'user-1',
				name: 'Legacy',
				skills: [],
				meta: {},
				created_at: '2024-01-01T00:00:00Z',
			},
		]);

		const { status, body } = await invoke({ method: 'GET', url: '/api/agents' });
		expect(status).toBe(200);
		const a = body.agents[0];
		expect(a.solana_address).toBeNull();
		expect(a.walletReady).toBe(false);
	});

	it('reports walletReady=false when the address is present but the secret is missing', async () => {
		authState.session = { id: 'user-1' };
		const SOL = 'So11111111111111111111111111111111111111112';
		sqlState.queue.push([
			{
				id: 'agent-half',
				user_id: 'user-1',
				name: 'Half',
				skills: [],
				meta: { solana_address: SOL }, // no encrypted_solana_secret
				created_at: '2024-01-01T00:00:00Z',
			},
		]);

		const { status, body } = await invoke({ method: 'GET', url: '/api/agents' });
		expect(status).toBe(200);
		const a = body.agents[0];
		expect(a.solana_address).toBe(SOL);
		expect(a.walletReady).toBe(false);
	});
});

describe('GET /api/agents/me — identity bootstrap', () => {
	it('returns agent: null (200) for anonymous callers instead of 401', async () => {
		const { status, body } = await invoke({ method: 'GET', url: '/api/agents/me' });
		expect(status).toBe(200);
		expect(body).toEqual({ agent: null });
	});

	it('returns existing default agent for authenticated caller', async () => {
		authState.session = { id: 'user-3' };
		sqlState.queue.push([
			{
				id: 'agent-3',
				user_id: 'user-3',
				name: 'Agent',
				skills: [],
				meta: {},
				created_at: '2024-01-01T00:00:00Z',
			},
		]);

		const { status, body } = await invoke({ method: 'GET', url: '/api/agents/me' });
		expect(status).toBe(200);
		expect(body.agent.id).toBe('agent-3');
	});

	it('auto-creates a default agent when none exists', async () => {
		authState.session = { id: 'user-4' };
		// First SELECT → empty; INSERT → empty; Re-SELECT → the new row.
		sqlState.queue.push([]); // first lookup
		sqlState.queue.push([]); // insert result
		sqlState.queue.push([
			{
				id: 'agent-4',
				user_id: 'user-4',
				name: 'Agent',
				skills: ['greet'],
				meta: {},
				wallet_address: '0xabc0000000000000000000000000000000000001',
				created_at: '2024-01-01T00:00:00Z',
			},
		]);

		const { status, body } = await invoke({ method: 'GET', url: '/api/agents/me' });
		expect(status).toBe(200);
		expect(body.agent.id).toBe('agent-4');
		expect(body.agent.wallet_address).toBe('0xabc0000000000000000000000000000000000001');
		// Three sql calls: select, insert, select
		expect(sqlState.calls).toHaveLength(3);
	});

	it('returns { agent: null, warning } when the agents table is missing', async () => {
		authState.session = { id: 'user-5' };
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const dbErr = Object.assign(new Error('relation "agent_identities" does not exist'), {
			code: '42P01',
		});
		sqlState.queue.push(Promise.reject(dbErr));

		const { status, body } = await invoke({ method: 'GET', url: '/api/agents/me' });
		expect(status).toBe(200);
		expect(body.agent).toBeNull();
		expect(body.warning).toBe('agents_table_missing');
		errSpy.mockRestore();
	});
});

describe('POST /api/agents — create', () => {
	it('returns 401 when unauthenticated', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			url: '/api/agents',
			body: { name: 'New' },
		});
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('returns 400 when name trims to empty', async () => {
		authState.session = { id: 'user-6' };
		const { status, body } = await invoke({
			method: 'POST',
			url: '/api/agents',
			body: { name: '   ' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('creates and returns a new agent on happy path', async () => {
		authState.session = { id: 'user-7' };
		sqlState.queue.push([
			{
				id: 'agent-7',
				user_id: 'user-7',
				name: 'Scout',
				description: 'desc',
				skills: ['greet'],
				wallet_address: '0xabc0000000000000000000000000000000000001',
				meta: { encrypted_wallet_key: 'SECRET', foo: 'bar' },
				created_at: '2024-01-01T00:00:00Z',
			},
		]);

		const { status, body } = await invoke({
			method: 'POST',
			url: '/api/agents',
			body: { name: 'Scout', description: 'desc', meta: { foo: 'bar' } },
		});

		expect(status).toBe(201);
		expect(body.agent.id).toBe('agent-7');
		expect(body.agent.name).toBe('Scout');
		// encrypted_wallet_key must never leak to the client
		expect(body.agent.meta.encrypted_wallet_key).toBeUndefined();
		expect(body.agent.meta.foo).toBe('bar');
	});
});

describe('method routing', () => {
	it('rejects PUT on /api/agents with 405', async () => {
		const { status, body } = await invoke({ method: 'PUT', url: '/api/agents' });
		expect(status).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});

	it('short-circuits OPTIONS (CORS preflight) with 204', async () => {
		const { status } = await invoke({
			method: 'OPTIONS',
			url: '/api/agents',
			headers: { origin: 'http://localhost:3000' },
		});
		expect(status).toBe(204);
	});
});
