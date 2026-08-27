// /api/evm-rpc: the browser's same-origin EVM JSON-RPC proxy. Locks down the
// read-only method allowlist and the endpoint rotation, so a keyless host that
// answers 403 (or a 200 carrying a non-JSON-RPC body) never reaches the browser.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: () => true,
	readJson: async (req) => req.body,
	rateLimited: (res) => {
		res._json = { status: 429, body: { error: 'rate_limited' } };
		return res;
	},
	error: (res, status, code, message) => {
		res._json = { status, body: { error: code, error_description: message } };
		return res;
	},
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		evmRpcIp: vi.fn(async () => ({ success: true })),
		evmRpcGlobal: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '1.2.3.4',
}));
const endpoints = ['https://a.test/', 'https://b.test/', 'https://c.test/'];
vi.mock('../api/_lib/evm/rpc.js', () => ({
	evmRpcEndpoints: vi.fn(() => endpoints),
}));

import handler, { rejectReason, forwardWithRotation, ALLOWED_METHODS } from '../api/evm-rpc.js';

const OK = { jsonrpc: '2.0', id: 1, result: '0x1' };
const jsonRes = (body, status = 200) =>
	new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

function makeRes() {
	const headers = {};
	return {
		statusCode: 0,
		setHeader: (k, v) => { headers[k] = v; },
		end(text) { this.text = text; },
		headers,
	};
}

describe('/api/evm-rpc method allowlist', () => {
	it('accepts every read-only method and refuses everything else', () => {
		for (const m of ALLOWED_METHODS) {
			expect(rejectReason({ jsonrpc: '2.0', id: 1, method: m, params: [] })).toBeNull();
		}
		expect(rejectReason({ method: 'eth_sendRawTransaction', params: ['0x'] })).toBe('method_not_allowed');
		expect(rejectReason({ method: 'eth_subscribe' })).toBe('method_not_allowed');
		expect(rejectReason({ method: 'eth_newFilter' })).toBe('method_not_allowed');
	});

	it('refuses malformed, empty and oversized batches', () => {
		expect(rejectReason([])).toBe('empty_request');
		expect(rejectReason('nope')).toBe('malformed_request');
		expect(rejectReason({ id: 1 })).toBe('malformed_request');
		expect(rejectReason(Array.from({ length: 11 }, () => ({ method: 'eth_chainId' })))).toBe('batch_too_large');
		expect(rejectReason([{ method: 'eth_chainId' }, { method: 'eth_sendRawTransaction' }])).toBe('method_not_allowed');
	});

	it('answers 403 for a write method and 400 for an unknown chain through the handler', async () => {
		let res = makeRes();
		await handler({ url: '/api/evm-rpc?chainId=1', body: { method: 'eth_sendRawTransaction' } }, res);
		expect(res._json.status).toBe(403);
		expect(res._json.body.error).toBe('method_not_allowed');

		res = makeRes();
		await handler({ url: '/api/evm-rpc?chainId=999999', body: { method: 'eth_chainId' } }, res);
		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('unknown_chain');
	});
});

describe('/api/evm-rpc endpoint rotation', () => {
	let calls;
	beforeEach(() => { calls = []; });

	it('rotates past a 403, a non-JSON-RPC 200 body and a network error to the first good host', async () => {
		const fetchImpl = vi.fn(async (url) => {
			calls.push(url);
			if (url === 'https://a.test/') return jsonRes('forbidden', 403);
			if (url === 'https://b.test/') return jsonRes({ error: 'Unauthorized: You must authenticate your request with an API key' });
			return jsonRes(OK);
		});
		const out = await forwardWithRotation(endpoints, { jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { fetchImpl });
		expect(out.url).toBe('https://c.test/');
		expect(JSON.parse(out.text)).toEqual(OK);
		expect(calls).toEqual(endpoints);
	});

	it('rotates past a timeout', async () => {
		const fetchImpl = vi.fn((url, init) => {
			calls.push(url);
			if (url === 'https://a.test/') {
				return new Promise((_, reject) => {
					init.signal.addEventListener('abort', () => reject(new Error('aborted')));
				});
			}
			return Promise.resolve(jsonRes(OK));
		});
		const out = await forwardWithRotation(endpoints, { method: 'eth_blockNumber' }, { fetchImpl, timeoutMs: 20 });
		expect(out.url).toBe('https://b.test/');
		expect(calls).toEqual(['https://a.test/', 'https://b.test/']);
	});

	it('returns a legitimate JSON-RPC error envelope without rotating (a revert is an answer, not an outage)', async () => {
		const revert = { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } };
		const fetchImpl = vi.fn(async () => jsonRes(revert));
		const out = await forwardWithRotation(endpoints, { method: 'eth_call' }, { fetchImpl });
		expect(out.url).toBe('https://a.test/');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('answers 502 upstream_error once every endpoint has failed', async () => {
		const orig = global.fetch;
		global.fetch = vi.fn(async () => jsonRes('nope', 500));
		try {
			const res = makeRes();
			await handler({ url: '/api/evm-rpc?chainId=8453', body: { jsonrpc: '2.0', id: 1, method: 'eth_chainId' } }, res);
			expect(res._json.status).toBe(502);
			expect(res._json.body.error).toBe('upstream_error');
			expect(global.fetch).toHaveBeenCalledTimes(endpoints.length);
		} finally {
			global.fetch = orig;
		}
	});

	it('streams the first good upstream body through with no-store caching', async () => {
		const orig = global.fetch;
		global.fetch = vi.fn(async () => jsonRes(OK));
		try {
			const res = makeRes();
			await handler({ url: '/api/evm-rpc?chainId=1', body: { jsonrpc: '2.0', id: 1, method: 'eth_chainId' } }, res);
			expect(res.statusCode).toBe(200);
			expect(res.headers['cache-control']).toBe('no-store');
			expect(JSON.parse(res.text)).toEqual(OK);
		} finally {
			global.fetch = orig;
		}
	});
});
