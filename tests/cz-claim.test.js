// The HTTP contract of the CZ agent claim (api/cz/claim.js).
//
// The endpoint hands ownership of a pre-registered agent to whoever proves
// control of an address, so the whole surface is the signature check. Three
// properties are load-bearing:
//
//   1. The nonce is bound to the address it was issued to. A signature that is
//      valid on its own but was made by another key, or redeemed against a
//      nonce issued to a different address, must not claim the agent.
//   2. A nonce is single-use and short-lived. The status flip is conditional on
//      `pending` so a replay (or two concurrent POSTs) cannot both win, and a
//      nonce older than the TTL is dead even though its row is still `pending`.
//   3. The returned tx payload encodes transferAgent(agentId, signer) for the
//      address that actually signed, never for an address supplied in the body
//      without proof.
//
// The signatures here are real secp256k1 personal_sign signatures produced by
// ethers, the same library the handler verifies with; only the database rows
// and the rate limiter are stubbed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Wallet, Interface } from 'ethers';

const sqlState = { queue: [], calls: [] };
const rateState = { success: true };

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
		czClaimIp: vi.fn(async () =>
			rateState.success
				? { success: true, limit: 10, remaining: 9, reset: Date.now() + 3_600_000 }
				: { success: false, limit: 10, remaining: 0, reset: Date.now() + 3_600_000 },
		),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const handler = (await import('../api/cz/claim.js')).default;

const claimMessage = (nonce) => `Claim CZ Agent\n\nNonce: ${nonce}`;
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function call({ method = 'GET', url = '/api/cz/claim', body } = {}) {
	const raw = body === undefined ? Buffer.from('') : Buffer.from(JSON.stringify(body));
	const req = Readable.from([raw]);
	req.method = method;
	req.url = url;
	req.headers = { host: 'localhost', 'content-type': 'application/json' };
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

const pendingRow = (address, over = {}) => [{
	id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
	address: address.toLowerCase(),
	status: 'pending',
	created_at: new Date().toISOString(),
	...over,
}];

let wallet;
let other;

beforeEach(async () => {
	sqlState.queue = [];
	sqlState.calls = [];
	rateState.success = true;
	wallet = Wallet.createRandom();
	other = Wallet.createRandom();
});

describe('GET /api/cz/claim (nonce issuance)', () => {
	it('issues a hex nonce with its lifetime for a well-formed address', async () => {
		const r = await call({ url: `/api/cz/claim?address=${wallet.address}` });
		expect(r.status).toBe(200);
		expect(r.payload.nonce).toMatch(/^[0-9a-f]{32}$/);
		expect(r.payload.expiresInSeconds).toBe(900);
		// The row is stored lowercased so the POST comparison is case-insensitive.
		expect(sqlState.calls[0].values[0]).toBe(wallet.address.toLowerCase());
		expect(sqlState.calls[0].values[1]).toBe(r.payload.nonce);
	});

	it('rejects a non-address and writes nothing', async () => {
		const r = await call({ url: '/api/cz/claim?address=not-an-address' });
		expect(r.status).toBe(400);
		expect(r.payload.error).toBe('validation_error');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('surfaces the limiter as a 429 with a retry budget', async () => {
		rateState.success = false;
		const r = await call({ url: `/api/cz/claim?address=${wallet.address}` });
		expect(r.status).toBe(429);
		expect(r.payload.error).toBe('rate_limited');
		expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
		expect(sqlState.calls).toHaveLength(0);
	});
});

describe('POST /api/cz/claim (signature redemption)', () => {
	it('claims the agent and returns transferAgent calldata for the signer', async () => {
		sqlState.queue.push(pendingRow(wallet.address), [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }]);
		const signature = await wallet.signMessage(claimMessage(NONCE));

		const r = await call({
			method: 'POST',
			body: { signerAddress: wallet.address, signature, nonce: NONCE },
		});

		expect(r.status).toBe(200);
		expect(r.payload.ok).toBe(true);
		expect(r.payload.agentId).toBe('cz-preview');

		const iface = new Interface(['function transferAgent(string agentId, address newOwner)']);
		const decoded = iface.decodeFunctionData('transferAgent', r.payload.txPayload.data);
		expect(decoded[0]).toBe('cz-preview');
		expect(decoded[1].toLowerCase()).toBe(wallet.address.toLowerCase());
		expect(r.payload.txPayload.value).toBe('0x0');

		// The status flip is guarded on `pending`, which is what makes the nonce
		// single-use under concurrency rather than merely in sequence.
		expect(sqlState.calls[1].text).toContain("status = 'pending'");
	});

	it('refuses a signature produced by a different key', async () => {
		sqlState.queue.push(pendingRow(wallet.address));
		const signature = await other.signMessage(claimMessage(NONCE));

		const r = await call({
			method: 'POST',
			body: { signerAddress: wallet.address, signature, nonce: NONCE },
		});

		expect(r.status).toBe(403);
		expect(r.payload.error).toBe('forbidden');
		// Only the lookup ran: nothing was marked claimed.
		expect(sqlState.calls).toHaveLength(1);
	});

	it('refuses a nonce issued to another address', async () => {
		sqlState.queue.push(pendingRow(other.address));
		const signature = await wallet.signMessage(claimMessage(NONCE));

		const r = await call({
			method: 'POST',
			body: { signerAddress: wallet.address, signature, nonce: NONCE },
		});

		expect(r.status).toBe(403);
		expect(sqlState.calls).toHaveLength(1);
	});

	it('refuses a nonce that has already been redeemed', async () => {
		sqlState.queue.push(pendingRow(wallet.address, { status: 'claimed' }));
		const signature = await wallet.signMessage(claimMessage(NONCE));

		const r = await call({
			method: 'POST',
			body: { signerAddress: wallet.address, signature, nonce: NONCE },
		});

		expect(r.status).toBe(409);
		expect(r.payload.error).toBe('conflict');
	});

	it('loses the race when a concurrent POST flipped the row first', async () => {
		// Row still reads `pending`, but the conditional update matches nothing.
		sqlState.queue.push(pendingRow(wallet.address), []);
		const signature = await wallet.signMessage(claimMessage(NONCE));

		const r = await call({
			method: 'POST',
			body: { signerAddress: wallet.address, signature, nonce: NONCE },
		});

		expect(r.status).toBe(409);
		expect(r.payload.error).toBe('conflict');
	});

	it('refuses a nonce older than its TTL', async () => {
		const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
		sqlState.queue.push(pendingRow(wallet.address, { created_at: stale }));
		const signature = await wallet.signMessage(claimMessage(NONCE));

		const r = await call({
			method: 'POST',
			body: { signerAddress: wallet.address, signature, nonce: NONCE },
		});

		expect(r.status).toBe(400);
		expect(r.payload.error).toBe('nonce_expired');
		expect(sqlState.calls).toHaveLength(1);
	});

	it('reports an unknown nonce without leaking whether one exists', async () => {
		sqlState.queue.push([]);
		const r = await call({
			method: 'POST',
			body: { signerAddress: wallet.address, signature: '0xdead', nonce: NONCE },
		});
		expect(r.status).toBe(400);
		expect(r.payload.error).toBe('invalid_nonce');
	});

	it('rejects unparseable signature bytes as a 400, not a crash', async () => {
		sqlState.queue.push(pendingRow(wallet.address));
		const r = await call({
			method: 'POST',
			body: { signerAddress: wallet.address, signature: '0xdeadbeef', nonce: NONCE },
		});
		expect(r.status).toBe(400);
		expect(r.payload.error).toBe('invalid_signature');
	});

	it('rejects non-string fields instead of coercing them into the query', async () => {
		const r = await call({
			method: 'POST',
			body: { signerAddress: wallet.address, signature: ['0x1'], nonce: { $ne: null } },
		});
		expect(r.status).toBe(400);
		expect(r.payload.error).toBe('validation_error');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('requires every field', async () => {
		const r = await call({ method: 'POST', body: { signerAddress: wallet.address } });
		expect(r.status).toBe(400);
		expect(r.payload.error_description).toContain('required');
	});
});

describe('other methods', () => {
	it('answers an unsupported method with 405 and an allow header', async () => {
		const r = await call({ method: 'PUT' });
		expect(r.status).toBe(405);
		expect(r.headers.allow).toBe('GET, POST, OPTIONS');
	});
});
