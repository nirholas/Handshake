/**
 * Boundary behaviour for the plan-checkout payment lanes.
 *
 * POST /api/payments/solana/confirm
 *   The checkout schema refuses devnet in production because devnet USDC is
 *   free from a faucet. Confirm picks the RPC it queries AND the USDC mint it
 *   accepts from its own `network` field, and the intent row stores no cluster,
 *   so a devnet-tolerant confirm handed out free plans regardless of what
 *   checkout allowed: create a mainnet intent, pay its nonce with faucet USDC
 *   on devnet, confirm with network=devnet. Both schemas now share one enum.
 *
 * POST /api/payments/evm/confirm
 *   Scoped to chain_type='evm': the Solana lane writes into the same table, so
 *   an unscoped lookup let an EVM confirm read and expire a Solana intent.
 *   And confirming needs 12 blocks of depth, so a transfer broadcast near the
 *   end of the session could never be confirmed before it lapsed; a bounded
 *   grace window keeps those already-on-chain funds claimable.
 *
 * POST /api/payments/intent
 *   agent_id is a uuid column. An unvalidated value reached the driver as
 *   SQLSTATE 22P02, which the wrapper turned into a 500 plus an ops alert.
 *
 * NODE_ENV is forced to production for the whole file (restored afterwards) so
 * the production-only network gate is what is under test. DB, session, rate
 * limit, RPC, price feeds, and email are mocked; the HTTP envelope helpers and
 * the zod schemas run for real, so status codes and JSON bodies are genuine.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const envState = vi.hoisted(() => {
	const prior = process.env.NODE_ENV;
	process.env.NODE_ENV = 'production';
	return { prior };
});

const USER = { id: '28e98fb2-2a98-4500-b45a-5a9ad7b3f7a8', email: 'buyer@three.ws' };
const INTENT_ID = '2af3ee5e-8b10-40d5-bbf2-f375197dc39f';
const TX_SIG = '5Zx1uWnPZ8kkVYQ9mLXJx3nQ8Yb2c1D4eF5gH6jK7mN8pQ9rS1tU2vW3xY4zA5bC6dE7fG8hJ9kL1mN2pQ3r';
const TX_HASH = `0x${'a'.repeat(64)}`;
const AGENT_ID = '76bca598-103f-4e3a-8c95-b0d64993258a';

const db = vi.hoisted(() => ({ handlers: [], calls: [] }));

vi.mock('../api/_lib/db.js', () => ({
	sql: async (strings, ...values) => {
		const text = strings.join(' $ ').replace(/\s+/g, ' ').trim();
		db.calls.push({ text, values });
		for (const h of db.handlers) {
			if (h.match.test(text)) return h.result(values, text);
		}
		return [];
	},
	// http.js's wrap() classifies thrown errors through these on the 5xx path.
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => USER) }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })) },
	clientIp: () => '127.0.0.1',
}));
vi.mock('../api/_lib/email.js', () => ({ sendSubscriptionConfirmEmail: vi.fn(async () => {}) }));
vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaConnection: vi.fn(() => ({ getParsedTransaction: vi.fn(async () => null) })),
}));
vi.mock('../api/_lib/balances.js', () => ({ solanaMintUsdPrice: vi.fn(async () => 150) }));
vi.mock('../api/_lib/token/price.js', () => ({ getTokenPriceUsd: vi.fn(async () => ({ priceUsd: 0.0023 })) }));
vi.mock('../api/_lib/evm/rpc.js', () => ({ evmTransport: vi.fn(() => () => {}) }));

const evm = vi.hoisted(() => ({ client: { getTransactionReceipt: vi.fn(), getBlockNumber: vi.fn() } }));
vi.mock('viem', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, createPublicClient: vi.fn(() => evm.client) };
});

const { default: solanaHandler } = await import('../api/payments/solana/[action].js');
const { default: evmHandler } = await import('../api/payments/evm/[action].js');
const { default: intentHandler } = await import('../api/payments/intent.js');

afterAll(() => {
	if (envState.prior === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = envState.prior;
});

function makeReq(url, body, query) {
	return {
		method: 'POST',
		url,
		query,
		headers: { origin: 'https://three.ws', 'content-type': 'application/json' },
		body,
		socket: { remoteAddress: '127.0.0.1' },
	};
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, '_s', { get() { return this.statusCode; } });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}
async function call(handler, url, body, query) {
	const res = makeRes();
	await handler(makeReq(url, body, query), res);
	return res;
}

/** A pending intent row, expired `minutesAgo` minutes ago (0 = still live). */
function intentRow({ chainType = 'evm', minutesAgo = -10, status = 'pending' } = {}) {
	return {
		id: INTENT_ID,
		user_id: USER.id,
		plan: 'pro',
		chain_type: chainType,
		chain_id: chainType === 'evm' ? 8453 : null,
		amount_usdc: '49',
		recipient: '0x4022de2d36c334e73c7a108805cea11c0564f402',
		nonce: 'JE_4V8pYCSRoNMMkHngHPA',
		status,
		expires_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
	};
}

beforeEach(() => {
	db.handlers = [];
	db.calls = [];
	evm.client.getTransactionReceipt.mockReset();
	evm.client.getBlockNumber.mockReset();
	vi.clearAllMocks();
});

describe('POST /api/payments/solana/confirm: cluster gate', () => {
	it('refuses a devnet confirm in production without touching the intent', async () => {
		const r = await call(solanaHandler, '/api/payments/solana/confirm', {
			intent_id: INTENT_ID, tx_signature: TX_SIG, network: 'devnet',
		}, { action: 'confirm' });
		expect(r._s).toBe(400);
		expect(r.json().error).toBe('validation_error');
		expect(db.calls.some((c) => /plan_payment_intents/.test(c.text))).toBe(false);
	});

	it('still accepts a mainnet confirm and looks the intent up in its own lane', async () => {
		const r = await call(solanaHandler, '/api/payments/solana/confirm', {
			intent_id: INTENT_ID, tx_signature: TX_SIG, network: 'mainnet',
		}, { action: 'confirm' });
		expect(r._s).toBe(404);
		expect(r.json().error).toBe('not_found');
		const lookup = db.calls.find((c) => /select \* from plan_payment_intents/.test(c.text));
		expect(lookup?.text).toMatch(/chain_type = 'solana'/);
	});

	it('refuses a devnet checkout in production too', async () => {
		const r = await call(solanaHandler, '/api/payments/solana/checkout', {
			plan: 'pro', asset: 'USDC', network: 'devnet',
		}, { action: 'checkout' });
		expect(r._s).toBe(400);
		expect(r.json().error).toBe('validation_error');
	});
});

describe('POST /api/payments/evm/confirm: lane scoping', () => {
	it('scopes the intent lookup to the EVM lane', async () => {
		const r = await call(evmHandler, '/api/payments/evm/confirm', {
			intent_id: INTENT_ID, tx_hash: TX_HASH,
		}, { action: 'confirm' });
		expect(r._s).toBe(404);
		const lookup = db.calls.find((c) => /select \* from plan_payment_intents/.test(c.text));
		expect(lookup?.text).toMatch(/chain_type = 'evm'/);
	});

	it('never writes to an intent it could not claim', async () => {
		await call(evmHandler, '/api/payments/evm/confirm', {
			intent_id: INTENT_ID, tx_hash: TX_HASH,
		}, { action: 'confirm' });
		expect(db.calls.some((c) => /update plan_payment_intents/.test(c.text))).toBe(false);
	});
});

describe('POST /api/payments/evm/confirm: expiry grace window', () => {
	it('still verifies a transfer confirmed minutes after the session lapsed', async () => {
		db.handlers = [{ match: /select \* from plan_payment_intents/, result: () => [intentRow({ minutesAgo: 5 })] }];
		evm.client.getTransactionReceipt.mockRejectedValue(new Error('not found'));
		const r = await call(evmHandler, '/api/payments/evm/confirm', {
			intent_id: INTENT_ID, tx_hash: TX_HASH,
		}, { action: 'confirm' });
		// Past the expiry gate: it reached the chain lookup rather than 410ing.
		expect(r._s).toBe(422);
		expect(r.json().error).toBe('tx_not_found');
		expect(db.calls.some((c) => /update plan_payment_intents/.test(c.text))).toBe(false);
	});

	it('expires an intent left unclaimed past the grace window', async () => {
		db.handlers = [{ match: /select \* from plan_payment_intents/, result: () => [intentRow({ minutesAgo: 180 })] }];
		const r = await call(evmHandler, '/api/payments/evm/confirm', {
			intent_id: INTENT_ID, tx_hash: TX_HASH,
		}, { action: 'confirm' });
		expect(r._s).toBe(410);
		expect(r.json().error).toBe('intent_expired');
		const write = db.calls.find((c) => /update plan_payment_intents/.test(c.text));
		expect(write?.text).toMatch(/status='expired'/);
		// Only a pending row may be marked expired, so this can never stomp a
		// confirmed or failed intent.
		expect(write?.text).toMatch(/status='pending'/);
		expect(evm.client.getTransactionReceipt).not.toHaveBeenCalled();
	});

	it('refuses a failed intent outright', async () => {
		db.handlers = [{ match: /select \* from plan_payment_intents/, result: () => [intentRow({ status: 'failed' })] }];
		const r = await call(evmHandler, '/api/payments/evm/confirm', {
			intent_id: INTENT_ID, tx_hash: TX_HASH,
		}, { action: 'confirm' });
		expect(r._s).toBe(410);
		expect(evm.client.getTransactionReceipt).not.toHaveBeenCalled();
	});
});

describe('POST /api/payments/intent: agent_id shape', () => {
	it('answers 400 on a non-uuid agent_id without querying the price table', async () => {
		const r = await call(intentHandler, '/api/payments/intent', { agent_id: 'not-a-uuid', skill: 'me' });
		expect(r._s).toBe(400);
		expect(r.json().error).toBe('validation_error');
		expect(db.calls.some((c) => /agent_skill_prices/.test(c.text))).toBe(false);
	});

	it('answers 400 on a non-string agent_id', async () => {
		const r = await call(intentHandler, '/api/payments/intent', { agent_id: { id: AGENT_ID }, skill: 'me' });
		expect(r._s).toBe(400);
		expect(db.calls.length).toBe(0);
	});

	it('answers 400 on a blank skill', async () => {
		const r = await call(intentHandler, '/api/payments/intent', { agent_id: AGENT_ID, skill: '   ' });
		expect(r._s).toBe(400);
		expect(db.calls.some((c) => /agent_skill_prices/.test(c.text))).toBe(false);
	});

	it('still reaches the price lookup for a well-formed body', async () => {
		const r = await call(intentHandler, '/api/payments/intent', { agent_id: AGENT_ID, skill: '  me  ' });
		expect(r._s).toBe(404);
		expect(r.json().error).toBe('not_found');
		const lookup = db.calls.find((c) => /agent_skill_prices/.test(c.text));
		expect(lookup).toBeTruthy();
		// The skill is trimmed before it is matched against the price row.
		expect(lookup.values).toContain('me');
	});
});
