// Guards the ownership gate on POST /api/agents/tokens/launch-prep
// (api/agents/tokens/[action].js).
//
// The handler builds a real pump.fun create transaction whose `creator` is the
// wallet_address in the request body, so that address MUST be the one the agent
// is actually deployed under. The check was written as an exact comparison
// nested inside a case-INSENSITIVE one, which meant the exact comparison only
// ran when the two already differed case-insensitively: a case-variant address
// skipped the gate entirely. Solana addresses are case-sensitive base58, so
// "AbC…" and "aBc…" are two different accounts and the variant would have
// become the coin's creator.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = 'user-launch-1';
// A real-shaped base58 address with both cases, so a lowercased copy is a
// different (but still syntactically valid) Solana address.
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const WALLET_CASE_VARIANT = '7xkxtg2cw87d97txjsdpbd5jbkhetqa83tzrujosgasu';

const authState = { session: null };
const sqlState = { queue: [] };

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
}));

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async () => (sqlState.queue.length ? sqlState.queue.shift() : [])),
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

// The handler never reaches these in the cases under test; stubbing them keeps
// the import cheap and guarantees a leak past the gate cannot touch the network.
vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaConnection: vi.fn(() => {
		throw new Error('the test reached the Solana path, which means the gate let it through');
	}),
}));
vi.mock('../api/_lib/r2.js', () => ({
	r2: { send: vi.fn(async () => { throw new Error('the test reached R2, which means the gate let it through'); }) },
	publicUrl: vi.fn((k) => `https://cdn.test/${k}`),
}));

const handler = (await import('../api/agents/tokens/[action].js')).default;

function post(body) {
	const raw = Buffer.from(JSON.stringify(body));
	const req = Readable.from([raw]);
	req.method = 'POST';
	req.url = '/api/agents/tokens/launch-prep';
	req.headers = { host: 'localhost', 'content-type': 'application/json' };
	req.query = { action: 'launch-prep' };
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
		payload: res.body ? JSON.parse(res.body) : null,
	}));
}

function agentRow(meta) {
	return [{ id: AGENT_ID, name: 'Launch Agent', user_id: USER_ID, wallet_address: WALLET, meta }];
}

function launchBody(walletAddress) {
	return {
		agent_id: AGENT_ID,
		provider: 'pumpfun',
		cluster: 'mainnet',
		wallet_address: walletAddress,
		name: 'Probe Coin',
		symbol: 'PROBE',
	};
}

beforeEach(() => {
	authState.session = { id: USER_ID };
	sqlState.queue = [];
});

describe('launch-prep ownership gate', () => {
	it('rejects a wallet that differs from the agent only by letter case', async () => {
		sqlState.queue.push(agentRow({ onchain: { family: 'solana', wallet: WALLET } }));
		const { status, payload } = await post(launchBody(WALLET_CASE_VARIANT));
		expect(status).toBe(403);
		expect(payload.error).toBe('forbidden');
	});

	it('rejects an unrelated wallet', async () => {
		sqlState.queue.push(agentRow({ onchain: { family: 'solana', wallet: WALLET } }));
		const { status, payload } = await post(launchBody('9unrelatedWa11etAddressForThisTestOn1yXXXX'));
		expect(status).toBe(403);
		expect(payload.error).toBe('forbidden');
	});

	it('lets the exact wallet through to the next precondition', async () => {
		// Already-launched agent, so the check immediately after the wallet gate
		// answers 409. Reaching it proves the gate accepted the exact match.
		sqlState.queue.push(
			agentRow({ onchain: { family: 'solana', wallet: WALLET }, token: { mint: 'AlreadyLaunchedMint' } }),
		);
		const { status, payload } = await post(launchBody(WALLET));
		expect(status).toBe(409);
		expect(payload.error).toBe('conflict');
	});

	it('refuses an agent that is not deployed on Solana yet', async () => {
		sqlState.queue.push(agentRow({}));
		const { status, payload } = await post(launchBody(WALLET));
		expect(status).toBe(409);
		expect(payload.error).toBe('precondition_failed');
	});

	it('404s an agent the caller does not own', async () => {
		sqlState.queue.push([]);
		const { status, payload } = await post(launchBody(WALLET));
		expect(status).toBe(404);
		expect(payload.error).toBe('not_found');
	});

	it('401s a logged-out caller', async () => {
		authState.session = null;
		const { status, payload } = await post(launchBody(WALLET));
		expect(status).toBe(401);
		expect(payload.error).toBe('unauthorized');
	});
});
