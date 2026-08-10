// POST /api/agents/a2a-paid - JSON-RPC request body parsing.
//
// The A2A server used to re-read the raw request stream itself, which hangs
// forever once Express has already drained it on Cloud Run. The fix was to
// delegate to the shared readBody() in api/_lib/http.js, which prefers the
// pre-parsed body the server captured. The delegation landed but the import did
// not, so every JSON-RPC POST answered
//   {"error":{"code":-32700,"message":"readBody is not defined"}}
// and the paid A2A skill was unreachable for every calling agent. Both the agent
// card (GET) and unauthenticated probes kept working, so nothing surfaced it.
//
// These tests pin the parse: a body that reaches the handler must be judged on
// its CONTENT (-32600 invalid request, -32601 unknown method), never rejected as
// unparseable (-32700).

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';

const { default: handler } = await import('../api/agents/a2a-paid.js');

function makeReq(body, { raw = null } = {}) {
	const payload = raw != null ? raw : JSON.stringify(body);
	const req = Readable.from([Buffer.from(payload)]);
	req.method = 'POST';
	req.url = '/api/agents/a2a-paid';
	req.headers = { 'content-type': 'application/json', origin: 'https://three.ws' };
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		_body: '',
		_headers: {},
		setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this._headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this._headers[String(k).toLowerCase()]; },
		writeHead(code) { this.statusCode = code; return this; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		end(chunk) { this._body = chunk ? String(chunk) : ''; return this; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}

async function post(body, opts) {
	const res = makeRes();
	await handler(makeReq(body, opts), res);
	return res;
}

describe('POST /api/agents/a2a-paid - body parsing', () => {
	it('parses the body and rejects it on content, not as unparseable', async () => {
		const res = await post({});
		expect(res.json.error.code).toBe(-32600);
		expect(res.json.error.message).not.toMatch(/is not defined/);
	});

	it('routes a well-formed envelope to method dispatch', async () => {
		const res = await post({ jsonrpc: '2.0', id: 7, method: 'bogus/method', params: {} });
		expect(res.json.error.code).toBe(-32601);
		expect(res.json.id).toBe(7);
	});

	it('reports genuinely malformed JSON as a parse error', async () => {
		const res = await post(null, { raw: '{not json' });
		expect(res.json.error.code).toBe(-32700);
		expect(res.json.error.message).toMatch(/invalid JSON/i);
	});
});
