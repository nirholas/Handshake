// POST /api/erc8004/register-confirm: the step that turns a just-broadcast
// Identity Registry mint into an indexed three.ws agent.
//
// Two shipped bugs are pinned here:
//
//  1. The receipt was read over `chain.rpcUrls` directly. That list is only the
//     KEYLESS TAIL of the platform failover chain (api/_lib/evm/rpc.js), so the
//     operator's RPC_URL_<chainId> override and Alchemy were skipped entirely
//     and confirmation raced the slowest tier: a tx that WAS mined came back as
//     `tx_not_mined` whenever a public node lagged.
//  2. When every endpoint failed, the raw fetch error bubbled to wrap() and the
//     caller got an opaque 500 `internal_error`, which reads as a bug in the
//     registration rather than an upstream outage it should retry.
//
// The receipt itself is a real ERC-8004 `Registered(uint256,string,address)` log
// shape; only the transport and the database are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { id as keccakId } from 'ethers';

const CHAIN_ID = 8453;
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const OVERRIDE_RPC = 'https://operator-node.test/rpc';
const TX_HASH = '0x' + 'ab'.repeat(32);
const AGENT_ID = '7';
// Synthetic EVM owner; nothing is ever sent to it.
const OWNER = '0x00000000000000000000000000000000000000a1';

process.env.RPC_URL_8453 = OVERRIDE_RPC;

const statements = [];
function sqlMock(strings, ...values) {
	const text = strings.join('?');
	statements.push({ text, values });
	if (text.includes('SELECT id, meta FROM agent_identities')) return Promise.resolve([]);
	return Promise.resolve([]);
}
vi.mock('../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

vi.mock('../api/_lib/auth.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, getSessionUser: async () => ({ id: 'user-1' }) };
});

vi.mock('../api/_lib/rate-limit.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		clientIp: () => '203.0.113.9',
		limits: { ...actual.limits, registerIp: async () => ({ success: true }) },
	};
});

// enrichMetadata's manifest fetch: always a miss, so the tests stay on the
// receipt-verification path this file is about.
vi.mock('../api/_lib/ssrf-guard.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, fetchSafePublicUrlPinned: async () => ({ ok: false, status: 404 }) };
});

const handler = (await import('../api/erc8004/register-confirm.js')).default;

const REGISTERED_TOPIC = keccakId('Registered(uint256,string,address)');

function receipt({ agentId = AGENT_ID, owner = OWNER, status = '0x1', address = REGISTRY } = {}) {
	return {
		status,
		blockNumber: '0x1e240',
		logs: [
			{
				address,
				topics: [
					REGISTERED_TOPIC,
					'0x' + BigInt(agentId).toString(16).padStart(64, '0'),
					'0x' + owner.slice(2).padStart(64, '0'),
				],
			},
		],
	};
}

// Per-URL transport script: each entry is a function of the endpoint URL.
let transport = () => {
	throw new Error('unscripted RPC call');
};
const calledUrls = [];

beforeEach(() => {
	statements.length = 0;
	calledUrls.length = 0;
	vi.stubGlobal('fetch', async (url) => {
		calledUrls.push(String(url));
		return transport(String(url));
	});
});

function rpcOk(result) {
	return () => ({
		ok: true,
		status: 200,
		json: async () => ({ jsonrpc: '2.0', id: 1, result }),
	});
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		removeHeader(k) {
			delete this.headers[k.toLowerCase()];
		},
		writeHead(code) {
			this.statusCode = code;
			return this;
		},
		end(payload) {
			if (payload !== undefined && this.body === null) this.body = payload;
			this.finished = true;
			return this;
		},
	};
}

async function confirm(overrides = {}) {
	const res = makeRes();
	await handler(
		{
			method: 'POST',
			url: '/api/erc8004/register-confirm',
			headers: { 'content-type': 'application/json' },
			query: {},
			body: {
				chainId: CHAIN_ID,
				txHash: TX_HASH,
				agentId: AGENT_ID,
				metadataUri: 'ipfs://bafyagentmanifest',
				ownerAddress: OWNER,
				...overrides,
			},
		},
		res,
	);
	let parsed = null;
	try {
		parsed = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
	} catch {
		parsed = res.body;
	}
	return { status: res.statusCode, body: parsed };
}

describe('POST /api/erc8004/register-confirm', () => {
	it('reads the receipt from the operator RPC override before any public node', async () => {
		transport = rpcOk(receipt());
		const { status, body } = await confirm();
		expect(status).toBe(200);
		expect(body).toMatchObject({ success: true, agentId: AGENT_ID, chainId: CHAIN_ID });
		// The override is tried FIRST; the keyless public list is only a fallback.
		expect(calledUrls[0]).toBe(OVERRIDE_RPC);
		expect(statements.some((s) => s.text.includes('INSERT INTO erc8004_agents_index'))).toBe(true);
	});

	it('fails over to the next endpoint when the first one is down', async () => {
		let first = true;
		transport = (url) => {
			if (first) {
				first = false;
				throw new Error(`connect ECONNREFUSED ${url}`);
			}
			return rpcOk(receipt())();
		};
		const { status } = await confirm();
		expect(status).toBe(200);
		expect(calledUrls.length).toBeGreaterThan(1);
	});

	it('answers 503 rpc_unavailable when every endpoint fails', async () => {
		transport = (url) => {
			throw new Error(`connect ECONNREFUSED ${url}`);
		};
		const { status, body } = await confirm();
		expect(status).toBe(503);
		expect(body.error).toBe('rpc_unavailable');
		expect(body.error_description).toContain('retry shortly');
		// More than one endpoint was attempted before giving up.
		expect(calledUrls.length).toBeGreaterThan(1);
		expect(statements.some((s) => s.text.includes('INSERT INTO erc8004_agents_index'))).toBe(false);
	});

	it('reports an unmined tx as 422 rather than indexing nothing silently', async () => {
		transport = rpcOk(null);
		const { status, body } = await confirm();
		expect(status).toBe(422);
		expect(body.error).toBe('tx_not_mined');
	});

	it('rejects a reverted tx', async () => {
		transport = rpcOk(receipt({ status: '0x0' }));
		const { status, body } = await confirm();
		expect(status).toBe(422);
		expect(body.error).toBe('tx_failed');
	});

	it('rejects a receipt whose Registered log came from another contract', async () => {
		transport = rpcOk(receipt({ address: '0x00000000000000000000000000000000000000ff' }));
		const { status, body } = await confirm();
		expect(status).toBe(422);
		expect(body.error).toBe('event_not_found');
	});

	it('rejects a claimed agentId the event does not match', async () => {
		transport = rpcOk(receipt({ agentId: '99' }));
		const { status, body } = await confirm();
		expect(status).toBe(422);
		expect(body.error).toBe('mismatch');
	});

	it('rejects a claimed owner the event does not match', async () => {
		transport = rpcOk(receipt({ owner: '0x00000000000000000000000000000000000000b2' }));
		const { status, body } = await confirm();
		expect(status).toBe(422);
		expect(body.error).toBe('mismatch');
	});

	it('rejects an unsupported chain before any RPC call', async () => {
		const { status, body } = await confirm({ chainId: 999_999 });
		expect(status).toBe(400);
		expect(body.error_description).toContain('unsupported chain');
		expect(calledUrls).toHaveLength(0);
	});

	it('rejects an oversized metadataUri instead of writing it to the index', async () => {
		const { status } = await confirm({ metadataUri: 'ipfs://' + 'a'.repeat(2100) });
		expect(status).toBe(400);
		expect(calledUrls).toHaveLength(0);
	});
});
