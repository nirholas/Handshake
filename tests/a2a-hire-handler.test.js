// POST /api/agents/a2a-hire - the handler itself.
//
// The hire visualizer's pure phase/cap helpers had tests (a2a-hire-phases,
// a2a-hire-visualizer) but the endpoint that calls them had none, so a shadowed
// binding went unnoticed: a `const limits = getSpendLimits(...)` declared in the
// handler body shadowed the `limits` rate-limiter imported at module scope, which
// put the earlier `await limits.mcpAgentPay(...)` in a temporal dead zone. Every
// authenticated hire 500'd with "Cannot access 'limits' before initialization":
// the whole agent-to-agent hire path was dead, while unauthenticated probes
// (which return 401 before that line) looked perfectly healthy.
//
// These tests walk the handler past that line on every entry path, so any future
// shadowing or reordering fails here instead of in production.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const rateLimitCalls = [];

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => ({ id: 'owner-1' })),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpAgentPay: vi.fn(async (key) => {
			rateLimitCalls.push(key);
			return { success: true };
		}),
	},
	clientIp: () => '127.0.0.1',
}));

const dbState = { hirer: null };
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings) => {
		const q = (typeof strings === 'string' ? strings : strings.join('?')).toLowerCase();
		if (/from agent_identities/.test(q)) return dbState.hirer ? [dbState.hirer] : [];
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const offerState = { offer: null };
vi.mock('../api/_lib/agent-economy.js', () => ({
	atomicsToUsdc: (a) => Number(a) / 1e6,
	getOfferBySlug: vi.fn(async () => offerState.offer),
	recordHire: vi.fn(async () => ({ row: { id: 'hire-1', status: 'pending' }, existing: false })),
	updateHire: vi.fn(async () => ({ id: 'hire-1', status: 'failed' })),
}));

// Spend policy, screen frames, and the payment rails: the hire never reaches the
// settlement leg in these tests, but every import still has to resolve.
vi.mock('../api/_lib/agent-trade-guards.js', () => ({
	SpendLimitError: class SpendLimitError extends Error {},
	reserveSpendUsd: vi.fn(async () => ({ reservationId: 'res-1', dailySpentUsd: 0 })),
	releaseSpendReservation: vi.fn(async () => {}),
	updateCustodyEvent: vi.fn(async () => {}),
	recordCustodyEvent: vi.fn(async () => {}),
	getSpendLimits: vi.fn(() => ({ per_tx_usd: 5, daily_usd: 25 })),
}));

vi.mock('../api/_lib/agent-screen-frame.js', () => ({ writeScreenFrame: vi.fn(async () => {}) }));
vi.mock('../api/_lib/x402-user-payer.js', () => ({
	payExternalX402: vi.fn(async () => { throw Object.assign(new Error('not reached'), { code: 'payment_failed' }); }),
	resolveSpendEnabled: vi.fn(() => true),
}));
vi.mock('../api/_lib/agent-paid-services.js', () => ({ serviceResourceUrl: (slug) => `https://three.ws/api/x402/service/${slug}` }));
vi.mock('../api/_lib/agent-wallet.js', () => ({ recoverSolanaAgentKeypair: vi.fn(async () => ({})) }));
vi.mock('../api/_lib/agent-invocation-onchain.js', () => ({ recordInvocationReceipt: vi.fn(async () => ({ signature: 'sig' })) }));

const { default: handler } = await import('../api/agents/a2a-hire.js');

const HIRER_ID = '22222222-2222-4222-8222-222222222222';
const WALLET = 'So11111111111111111111111111111111111111112';

function makeReq(body) {
	return {
		method: 'POST',
		url: '/api/agents/a2a-hire',
		headers: { 'content-type': 'application/json', origin: 'https://three.ws', 'x-csrf-token': 't' },
		body,
	};
}

function makeRes() {
	return {
		statusCode: 0,
		payload: null,
		headers: {},
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
		writeHead(code) { this.statusCode = code; return this; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		end(chunk) {
			if (chunk) { try { this.payload = JSON.parse(String(chunk)); } catch { this.payload = String(chunk); } }
			return this;
		},
	};
}

async function post(body) {
	const res = makeRes();
	await handler(makeReq(body), res);
	return res;
}

function ownedHirer() {
	return { id: HIRER_ID, user_id: 'owner-1', name: 'Mine', meta: { solana_address: WALLET, encrypted_solana_secret: 'ENC' } };
}

beforeEach(() => {
	rateLimitCalls.length = 0;
	dbState.hirer = null;
	offerState.offer = null;
	vi.clearAllMocks();
});

describe('POST /api/agents/a2a-hire', () => {
	it('rate-limits the authenticated caller instead of crashing on a shadowed binding', async () => {
		const res = await post({});
		expect(res.statusCode).toBe(400);
		expect(res.payload.error).toBe('validation_error');
		// The temporal-dead-zone crash happened on this exact call. A 500 here, or an
		// empty list, means the shadowing is back.
		expect(rateLimitCalls).toEqual(['owner-1']);
	});

	it('requires a serviceSlug', async () => {
		const res = await post({ hirerAgentId: HIRER_ID });
		expect(res.statusCode).toBe(400);
		expect(res.payload.error_description).toMatch(/serviceSlug/);
	});

	it('404s when the hiring agent does not exist', async () => {
		const res = await post({ hirerAgentId: HIRER_ID, serviceSlug: 'inspect-glb' });
		expect(res.statusCode).toBe(404);
		expect(res.payload.error).toBe('not_found');
	});

	it('403s when the caller does not own the hiring agent', async () => {
		dbState.hirer = { id: HIRER_ID, user_id: 'someone-else', name: 'Theirs', meta: {} };
		const res = await post({ hirerAgentId: HIRER_ID, serviceSlug: 'inspect-glb' });
		expect(res.statusCode).toBe(403);
		expect(res.payload.error).toBe('forbidden');
	});

	it('409s when the hiring agent has no wallet to pay from', async () => {
		dbState.hirer = { id: HIRER_ID, user_id: 'owner-1', name: 'Mine', meta: {} };
		const res = await post({ hirerAgentId: HIRER_ID, serviceSlug: 'inspect-glb' });
		expect(res.statusCode).toBe(409);
		expect(res.payload.error).toBe('no_wallet');
	});

	// Past the spend-policy read at the top of the wallet-bearing path: that read is
	// the statement that shadowed the rate limiter, so it has to be exercised too.
	it('reads the agent spend policy and reports an unknown offer as 404', async () => {
		dbState.hirer = ownedHirer();
		const res = await post({ hirerAgentId: HIRER_ID, serviceSlug: 'no-such-offer' });
		expect(res.statusCode).toBe(404);
		expect(res.payload.error).toBe('offer_not_found');

		const { getSpendLimits } = await import('../api/_lib/agent-trade-guards.js');
		expect(getSpendLimits).toHaveBeenCalled();
	});

	it('refuses an agent hiring its own service before any spend is reserved', async () => {
		dbState.hirer = ownedHirer();
		offerState.offer = {
			slug: 'self', name: 'Self skill', service_id: 's1', price_atomics: '1000',
			network: 'solana', method: 'POST',
			provider: { id: HIRER_ID, name: 'Mine', is_public: true, solana_address: WALLET },
		};
		const res = await post({ hirerAgentId: HIRER_ID, serviceSlug: 'self' });
		expect(res.statusCode).toBe(400);
		expect(res.payload.error).toBe('self_hire');

		const { reserveSpendUsd } = await import('../api/_lib/agent-trade-guards.js');
		expect(reserveSpendUsd).not.toHaveBeenCalled();
	});

	it('rejects a hire priced above the caller-supplied per-call ceiling', async () => {
		dbState.hirer = ownedHirer();
		offerState.offer = {
			slug: 'pricey', name: 'Pricey skill', service_id: 's2', price_atomics: '5000000',
			network: 'solana', method: 'POST',
			provider: { id: 'provider-1', name: 'Them', is_public: true, solana_address: WALLET },
		};
		const res = await post({ hirerAgentId: HIRER_ID, serviceSlug: 'pricey', maxUsd: 0.5 });
		expect(res.statusCode).toBe(402);
		expect(res.payload.error).toBe('over_cap');

		const { reserveSpendUsd } = await import('../api/_lib/agent-trade-guards.js');
		expect(reserveSpendUsd).not.toHaveBeenCalled();
	});

	it('401s an unauthenticated caller', async () => {
		const auth = await import('../api/_lib/auth.js');
		auth.getSessionUser.mockResolvedValueOnce(null);
		auth.authenticateBearer.mockResolvedValueOnce(null);
		const res = await post({});
		expect(res.statusCode).toBe(401);
		expect(res.payload.error).toBe('unauthorized');
	});
});
