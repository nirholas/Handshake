// Route-handler tests for api/agents/wallet-intents.js (dispatched from
// api/agents/[id].js as /api/agents/:id/intents).
//
// The engine's pure validation lives in tests/wallet-intents.test.js. What is
// covered HERE is the HTTP boundary that engine never sees:
//
//   1. Ownership: a stranger can neither read nor arm an intent, and an
//      unknown agent is a 404 rather than a leak of "exists but forbidden".
//   2. Body handling: readJson resolves any valid JSON, including `null`, a
//      bare string, and a number. Every write handler then reads a property
//      off it, so a scalar body used to raise a TypeError and surface as an
//      opaque 500 for what is plainly malformed input. It must be a 4xx.
//   3. Compile context: the compiler prompt lists the wallet's REAL tokens so
//      a rule like "sell half my $THREE" can ground against something the
//      agent actually holds. That list was declared and never filled, so every
//      compile told the model the wallet was empty.

import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const INTENT_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = 'owner-1';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
// A clearly-synthetic second mint: these cases only assert pass-through, so a
// real third-party token address would add nothing but a claim we do not mean.
const OTHER_MINT = 'THREEsynthetic1111111111111111111111111111';

const authState = { session: null };
const sqlState = { queue: [] };
const balancesState = { tokens: [], fail: false };
const compileState = { ctx: null, result: null };

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async () => (sqlState.queue.length ? sqlState.queue.shift() : [])),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		walletRead: vi.fn(async () => ({ success: true })),
		chatUser: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/provider-keys.js', () => ({ loadUserProviderKeys: vi.fn(async () => ({})) }));
vi.mock('../api/_lib/agent-trade-guards.js', () => ({
	getSpendLimits: vi.fn(() => ({ per_tx_usd: null, daily_usd: null, frozen: false })),
	getTradeLimits: vi.fn(() => ({})),
}));
vi.mock('../api/_lib/agent-wallet.js', () => ({
	getSolanaAddressBalances: vi.fn(async () => ({ sol: 2.5, usdc: 0 })),
}));
vi.mock('../api/_lib/avatar-wallet.js', () => ({ solUsdPrice: vi.fn(async () => 150) }));
vi.mock('../api/_lib/balances.js', () => ({
	getBalances: vi.fn(async () => {
		if (balancesState.fail) throw new Error('rpc down');
		return { native: { amount: 2.5 }, tokens: balancesState.tokens };
	}),
}));

vi.mock('../api/_lib/wallet-intents.js', () => ({
	listIntents: vi.fn(async () => []),
	getIntent: vi.fn(async () => null),
	createIntent: vi.fn(async () => ({ id: 'intent-1' })),
	updateIntent: vi.fn(async () => null),
	deleteIntent: vi.fn(async () => false),
	runIntentNow: vi.fn(async () => ({ dry_run: true })),
	compileIntentFromText: vi.fn(async (_text, ctx) => {
		compileState.ctx = ctx;
		return compileState.result ?? { ok: false, error: 'clarify', message: 'need more' };
	}),
	normalizeIntent: vi.fn(() => ({ ok: false, error: 'invalid_intent', message: 'no' })),
	describeIntent: vi.fn(() => 'readback'),
}));

const handler = (await import('../api/agents/wallet-intents.js')).default;

// A local request builder rather than the shared monetization helper: these
// cases turn on sending a body that is valid JSON but NOT an object, and the
// shared helper drops a falsy body (and its content-type) entirely.
function makeReq({ method, url, rawBody = null }) {
	const req = Readable.from(rawBody == null ? [] : [Buffer.from(rawBody)]);
	req.method = method;
	req.url = url;
	req.headers = { host: 'localhost', ...(rawBody == null ? {} : { 'content-type': 'application/json' }) };
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
}

async function call(action, { method = 'POST', rawBody = null, query = '' } = {}) {
	const url = `/api/agents/${AGENT_ID}/intents${action ? `/${action}` : ''}${query}`;
	const req = makeReq({ method, url, rawBody });
	const res = makeRes();
	await handler(req, res, AGENT_ID, action);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

// The handler loads the agent row itself before doing anything else, so every
// authorized case has to prime that read.
function primeOwnedAgent(meta = { solana_address: WALLET }) {
	sqlState.queue.push([{ id: AGENT_ID, user_id: OWNER_ID, name: 'Test Agent', meta }]);
}

beforeEach(() => {
	authState.session = { id: OWNER_ID };
	sqlState.queue = [];
	balancesState.tokens = [];
	balancesState.fail = false;
	compileState.ctx = null;
	compileState.result = null;
});

describe('wallet-intents handler: ownership', () => {
	it('refuses a logged-out caller with 401 before touching the agent row', async () => {
		authState.session = null;
		const { status, body } = await call('', { method: 'GET' });
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('refuses a signed-in stranger with 403', async () => {
		sqlState.queue.push([{ id: AGENT_ID, user_id: 'someone-else', name: 'A', meta: {} }]);
		const { status, body } = await call('', { method: 'GET' });
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
	});

	it('404s an unknown agent', async () => {
		sqlState.queue.push([]);
		const { status, body } = await call('', { method: 'GET' });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('404s an unknown intents sub-resource', async () => {
		const { status, body } = await call('not-a-verb-or-uuid', { method: 'GET' });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});
});

describe('wallet-intents handler: a non-object JSON body is a 4xx, never a 500', () => {
	// JSON.parse accepts every one of these; a handler that then reads
	// `body.text` off them raises a TypeError, which wrap() reports as a 500.
	for (const raw of ['null', '"just a string"', '42', 'true']) {
		it(`compile rejects ${raw} with a validation error`, async () => {
			primeOwnedAgent();
			const { status, body } = await call('compile', { rawBody: raw });
			expect(status).toBe(400);
			expect(body.error).toBe('validation_error');
		});

		it(`copilot rejects ${raw} with a validation error`, async () => {
			primeOwnedAgent();
			const { status, body } = await call('copilot', { rawBody: raw });
			expect(status).toBe(400);
			expect(body.error).toBe('validation_error');
		});

		it(`create rejects ${raw} with a validation error`, async () => {
			primeOwnedAgent();
			const { status, body } = await call('', { rawBody: raw });
			expect(status).toBe(400);
			expect(body.error).toBe('validation_error');
		});

		it(`run rejects ${raw} with a validation error`, async () => {
			primeOwnedAgent();
			const { status, body } = await call('run', { rawBody: raw });
			expect(status).toBe(400);
			expect(body.error).toBe('validation_error');
		});
	}

	it('update treats a scalar body as an empty patch rather than throwing', async () => {
		primeOwnedAgent();
		// updateIntent is mocked to report "no such intent"; the point is that the
		// request reached it at all instead of dying on `'enabled' in null`.
		const { status, body } = await call(INTENT_ID, { method: 'PUT', rawBody: 'null' });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('still rejects a body that is not JSON at all', async () => {
		primeOwnedAgent();
		const { status } = await call('compile', { rawBody: '{oops' });
		expect(status).toBe(400);
	});
});

describe('wallet-intents handler: the compiler sees real holdings', () => {
	it('passes the wallet live tokens into the compile context', async () => {
		primeOwnedAgent();
		balancesState.tokens = [
			{ mint: THREE, symbol: 'THREE', amount: 1250.5 },
			{ mint: OTHER_MINT, symbol: 'TEST', amount: 4 },
		];
		const { status } = await call('compile', { rawBody: JSON.stringify({ text: 'sell half my $THREE' }) });
		expect(status).toBe(200);
		expect(compileState.ctx.holdings).toEqual([
			{ mint: THREE, symbol: 'THREE', ui_amount: 1250.5 },
			{ mint: OTHER_MINT, symbol: 'TEST', ui_amount: 4 },
		]);
		expect(compileState.ctx.balanceSol).toBe(2.5);
	});

	it('drops zero-balance dust so the prompt only lists what is actually held', async () => {
		primeOwnedAgent();
		balancesState.tokens = [
			{ mint: THREE, symbol: 'THREE', amount: 0 },
			{ mint: OTHER_MINT, symbol: 'TEST', amount: 0.5 },
		];
		await call('compile', { rawBody: JSON.stringify({ text: 'anything' }) });
		expect(compileState.ctx.holdings).toEqual([{ mint: OTHER_MINT, symbol: 'TEST', ui_amount: 0.5 }]);
	});

	it('still compiles when the balance provider is down', async () => {
		primeOwnedAgent();
		balancesState.fail = true;
		const { status } = await call('compile', { rawBody: JSON.stringify({ text: 'anything' }) });
		expect(status).toBe(200);
		expect(compileState.ctx.holdings).toEqual([]);
	});

	it('skips the mainnet-only holdings read on devnet', async () => {
		primeOwnedAgent();
		balancesState.tokens = [{ mint: THREE, symbol: 'THREE', amount: 10 }];
		const { status } = await call('compile', {
			rawBody: JSON.stringify({ text: 'anything' }),
			query: '?network=devnet',
		});
		expect(status).toBe(200);
		expect(compileState.ctx.network).toBe('devnet');
		expect(compileState.ctx.holdings).toEqual([]);
	});
});
