// /api/chat/mcp is the viewer-control MCP server. Two protocol faults made it
// look broken to real clients:
//
//   1. A JSON-RPC *notification* (a message with no `id`) got an error response.
//      Every MCP client sends `notifications/initialized` immediately after
//      initialize, so the very first thing a client saw after a successful
//      handshake was a -32601 for a message it is not allowed to be answered on.
//   2. GET/DELETE answered 401 "method not supported" instead of 405. A client
//      reading that can only conclude its token is bad, and retries auth forever
//      against what was never an auth problem.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const authenticateBearerMock = vi.fn();
vi.mock('../../api/_lib/auth.js', () => ({
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (req) => {
		const h = req.headers.authorization || '';
		return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
	},
}));

vi.mock('../../api/_lib/env.js', () => ({
	env: {
		APP_ORIGIN: 'http://localhost:3000',
		ISSUER: 'http://test',
		MCP_RESOURCE: 'http://test/api/mcp',
	},
}));

const recordEventMock = vi.fn();
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: (...a) => recordEventMock(...a),
	logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({
	instrument: vi.fn(() => null),
	drain: vi.fn(async () => {}),
}));

const { default: handler } = await import('../../api/chat/mcp.js');

function makeReq({ method = 'POST', body = null, headers = {} } = {}) {
	const stream = body === null ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
	stream.method = method;
	stream.url = '/api/chat/mcp';
	stream.headers = {
		host: 'localhost',
		authorization: 'Bearer test-token',
		...(body === null ? {} : { 'content-type': 'application/json' }),
		...headers,
	};
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			this.writableEnded = true;
		},
		write(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
		},
	};
}

async function rpc(body, opts) {
	const res = makeRes();
	await handler(makeReq({ body, ...opts }), res);
	return res;
}

beforeEach(() => {
	authenticateBearerMock.mockReset();
	authenticateBearerMock.mockResolvedValue({ userId: 'u1', apiKeyId: null, clientId: 'c1' });
	recordEventMock.mockReset();
});

describe('POST /api/chat/mcp: JSON-RPC requests', () => {
	it('answers initialize with the protocol version, in body and header', async () => {
		const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
		expect(res.statusCode).toBe(200);
		const out = JSON.parse(res.body);
		expect(out.result.protocolVersion).toBe('2025-06-18');
		expect(res.getHeader('mcp-protocol-version')).toBe('2025-06-18');
	});

	it('lists the viewer tool catalog', async () => {
		const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const tools = JSON.parse(res.body).result.tools;
		expect(tools.map((t) => t.name)).toContain('setWireframe');
		expect(tools.every((t) => t.inputSchema?.type === 'object')).toBe(true);
	});

	it('returns an action intent for a known tool call', async () => {
		const res = await rpc({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'setWireframe', arguments: { value: true } },
		});
		const intent = JSON.parse(res.body).result.structuredContent;
		expect(intent.action).toBe('setWireframe');
		expect(intent.input).toEqual({ value: true });
		expect(intent.actor).toBe('u1');
		expect(recordEventMock).toHaveBeenCalledOnce();
	});

	it('rejects an unknown tool with -32601', async () => {
		const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
		expect(JSON.parse(res.body).error.code).toBe(-32601);
	});
});

describe('POST /api/chat/mcp: notifications are never answered', () => {
	it('accepts notifications/initialized with 202 and an empty body', async () => {
		const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(res.statusCode).toBe(202);
		expect(res.body).toBe('');
	});

	it('stays silent on an unknown notification instead of erroring', async () => {
		const res = await rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} });
		expect(res.statusCode).toBe(202);
		expect(res.body).toBe('');
	});

	it('treats an explicit null id as a notification (MCP forbids a null request id)', async () => {
		const res = await rpc({ jsonrpc: '2.0', id: null, method: 'ping' });
		expect(res.statusCode).toBe(202);
		expect(res.body).toBe('');
	});
});

describe('POST /api/chat/mcp: transport contract', () => {
	it('answers a wrong method with 405 and an Allow header, not 401', async () => {
		for (const method of ['GET', 'DELETE', 'PUT']) {
			const res = await rpc(null, { method });
			expect(res.statusCode).toBe(405);
			expect(res.getHeader('allow')).toContain('POST');
			expect(JSON.parse(res.body).error).toBe('method_not_allowed');
		}
	});

	it('still requires a bearer token, and says so with a challenge', async () => {
		authenticateBearerMock.mockResolvedValue(null);
		const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
		expect(res.statusCode).toBe(401);
		expect(res.getHeader('www-authenticate')).toContain('Bearer realm="three.ws"');
	});

	it('allows any origin, like every other MCP server here', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { origin: 'https://lobehub.com' } }), res);
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
		// No credentials flag: a cross-origin page can spend a token it already
		// holds, but can never ride a signed-in user's cookie session.
		expect(res.getHeader('access-control-allow-credentials')).toBeUndefined();
	});

	it('answers a CORS preflight with 204', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'OPTIONS', headers: { origin: 'https://lobehub.com' } }), res);
		expect(res.statusCode).toBe(204);
		expect(res.getHeader('access-control-allow-methods')).toContain('POST');
	});

	it('rejects a malformed envelope with -32600', async () => {
		const res = await rpc({ jsonrpc: '1.0', id: 9, method: 'ping' });
		expect(JSON.parse(res.body).error.code).toBe(-32600);
	});
});
