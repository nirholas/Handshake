// GET /api/agents/:id/memory/:cid: the pinned-memory IPFS read-through proxy.
//
// Two things this route has to get right, and one it used to get wrong.
//
// Right: the CID must be bound to THIS agent's own pin set. Owning the agent is
// not enough, or the route is a general-purpose authenticated IPFS fetch proxy
// for any CID anyone can name.
//
// Wrong, until the fix these tests lock in: when every public gateway refused,
// the helper threw. If a gateway had thrown first, the caller saw that network
// error as a bare 500; if all three merely answered with a non-ok status,
// nothing was ever assigned to `lastErr` and the code threw a synthesized error
// with no cause at all. Either way somebody else's gateway outage was reported
// as a three.ws internal error, and the ops alert that a 5xx raises fired on it.
// It is an upstream failure: 502.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const AGENT_ID = '00000000-0000-4000-8000-0000000000c1';
const OWNER_ID = 'user-owner';
const CID = 'bafkreiauditprobecid';

let agentRow = null;
let pinRow = null;

const sqlMock = vi.fn((strings) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/from agent_identities/i.test(q)) return Promise.resolve(agentRow ? [agentRow] : []);
	if (/from agent_memory_pins/i.test(q)) return Promise.resolve(pinRow ? [pinRow] : []);
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authedReadIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000, limit: 60, remaining: 59 })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: handler } = await import('../../api/agents/_id/memory/[cid].js');

function gatewayOk(bytes) {
	return {
		ok: true,
		status: 200,
		headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
		arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	};
}
function gatewayStatus(status) {
	return { ok: false, status, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
}

async function get(cid = CID, id = AGENT_ID) {
	const req = makeReq({ method: 'GET', url: `/api/agents/${id}/memory/${cid}` });
	const res = makeRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	sessionUser = { id: OWNER_ID };
	agentRow = { id: AGENT_ID };
	pinRow = { cid: CID };
	vi.restoreAllMocks();
});

describe('GET /api/agents/:id/memory/:cid', () => {
	it('streams the pinned file back from the first gateway that serves it', async () => {
		const payload = Buffer.from('encrypted-memory-bytes');
		globalThis.fetch = vi.fn(async () => gatewayOk(payload));
		const res = await get();
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('application/octet-stream');
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('walks to the next gateway when the first refuses', async () => {
		const payload = Buffer.from('encrypted-memory-bytes');
		let n = 0;
		globalThis.fetch = vi.fn(async () => (++n === 1 ? gatewayStatus(504) : gatewayOk(payload)));
		const res = await get();
		expect(res.statusCode).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('502s (never 500) when every gateway answers with a non-ok status', async () => {
		globalThis.fetch = vi.fn(async () => gatewayStatus(404));
		const res = await get();
		expect(res.statusCode).toBe(502);
		expect(JSON.parse(res.body).error).toBe('upstream_error');
	});

	it('502s when every gateway is unreachable', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('ECONNRESET');
		});
		const res = await get();
		expect(res.statusCode).toBe(502);
		expect(JSON.parse(res.body).error).toBe('upstream_error');
	});

	it('bounds each gateway attempt with a deadline so one hang cannot eat the request', async () => {
		const payload = Buffer.from('x');
		globalThis.fetch = vi.fn(async (_url, init) => {
			expect(init?.signal).toBeDefined();
			return gatewayOk(payload);
		});
		const res = await get();
		expect(res.statusCode).toBe(200);
	});

	it('refuses a CID this agent has not pinned, so the route is not a generic proxy', async () => {
		pinRow = null;
		globalThis.fetch = vi.fn();
		const res = await get();
		expect(res.statusCode).toBe(404);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('401s an anonymous caller', async () => {
		sessionUser = null;
		globalThis.fetch = vi.fn();
		const res = await get();
		expect(res.statusCode).toBe(401);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('404s when the caller does not own the agent', async () => {
		agentRow = null;
		globalThis.fetch = vi.fn();
		const res = await get();
		expect(res.statusCode).toBe(404);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('413s on an over-cap file even when the gateway understates its length', async () => {
		const huge = Buffer.alloc(512 * 1024 + 1, 1);
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: { get: () => '10' }, // a lying Content-Length
			arrayBuffer: async () => huge.buffer.slice(huge.byteOffset, huge.byteOffset + huge.byteLength),
		}));
		const res = await get();
		expect(res.statusCode).toBe(413);
		expect(JSON.parse(res.body).error).toBe('payload_too_large');
	});
});
