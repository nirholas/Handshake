// Unit tests for the Solana Developer Platform (SDP) client (api/_lib/sdp.js).
// fetch is mocked, so these run with no network and no real SDP key. They pin
// the wire contract the proxy (api/sdp/*) and any server-side caller depend on:
//   1. the path allowlist mirrors the upstream router — unknown paths are
//      refused before any request goes out (no open-proxy).
//   2. health/openapi/llms need no key; everything else fails closed with 503
//      when SDP_API_KEY is unset (never a fake success).
//   3. the server-side key is attached as a Bearer Authorization header and the
//      base host is overridable via SDP_API_BASE.
//   4. upstream non-2xx surfaces the structured { error: { code, message } }.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	isSdpAllowedPath,
	sdpConfigured,
	sdpPathNeedsKey,
	sdpRequest,
	sdpCall,
	sdpHealth,
} from '../api/_lib/sdp.js';

const realFetch = global.fetch;
let lastRequest = null; // { url, method, headers, body }

function mockFetch(status, body, { contentType = 'application/json', traceId = null } = {}) {
	global.fetch = vi.fn(async (url, init = {}) => {
		lastRequest = {
			url,
			method: init.method || 'GET',
			headers: init.headers || {},
			body: init.body ?? null,
		};
		const text = typeof body === 'string' ? body : JSON.stringify(body);
		const headers = new Map([['content-type', contentType]]);
		if (traceId) headers.set('x-sdp-trace-id', traceId);
		return {
			status,
			headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
			text: async () => text,
		};
	});
}

beforeEach(() => {
	lastRequest = null;
	delete process.env.SDP_API_KEY;
	delete process.env.SDP_API_BASE;
});

afterEach(() => {
	global.fetch = realFetch;
	vi.restoreAllMocks();
});

describe('path allowlist', () => {
	it('accepts the documented v1 resources and top-level surfaces', () => {
		for (const p of [
			'health',
			'health/ready',
			'openapi.json',
			'llms.txt',
			'v1/wallets',
			'v1/wallets/abc-123',
			'v1/issuance',
			'v1/payments/transfers',
			'v1/compliance/address-screenings',
			'v1/projects',
		]) {
			expect(isSdpAllowedPath(p), p).toBe(true);
		}
	});

	it('rejects unknown resources, traversal, and arbitrary paths', () => {
		for (const p of [
			'',
			'v1/secrets',
			'v2/wallets',
			'../etc/passwd',
			'v1/wallets/../../admin',
			'admin/allowlist',
		]) {
			expect(isSdpAllowedPath(p), p).toBe(false);
		}
	});

	it('leading slashes are normalized', () => {
		expect(isSdpAllowedPath('/v1/wallets')).toBe(true);
	});
});

describe('key requirements', () => {
	it('health/openapi/llms need no key; v1 routes do', () => {
		expect(sdpPathNeedsKey('health')).toBe(false);
		expect(sdpPathNeedsKey('health/ready')).toBe(false);
		expect(sdpPathNeedsKey('openapi.json')).toBe(false);
		expect(sdpPathNeedsKey('llms.txt')).toBe(false);
		expect(sdpPathNeedsKey('v1/wallets')).toBe(true);
	});

	it('sdpConfigured reflects SDP_API_KEY', () => {
		expect(sdpConfigured()).toBe(false);
		process.env.SDP_API_KEY = 'sdp_test_key';
		expect(sdpConfigured()).toBe(true);
	});
});

describe('sdpRequest', () => {
	it('refuses a disallowed path without making a request', async () => {
		mockFetch(200, { ok: true });
		await expect(sdpRequest('v1/secrets')).rejects.toMatchObject({ status: 404 });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('fails closed with 503 when an authenticated route has no key', async () => {
		mockFetch(200, { ok: true });
		await expect(sdpRequest('v1/wallets')).rejects.toMatchObject({ status: 503 });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('calls health with no key and no Authorization header', async () => {
		mockFetch(200, { status: 'ok' });
		const res = await sdpRequest('health');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ status: 'ok' });
		expect(lastRequest.url).toBe('https://api.solana.com/health');
		expect(lastRequest.headers.authorization).toBeUndefined();
	});

	it('omits the key on the public doc surfaces even when one is configured', async () => {
		process.env.SDP_API_KEY = 'sdp_live_abc';
		mockFetch(200, { openapi: '3.1.0' });
		await sdpRequest('openapi.json');
		expect(lastRequest.url).toBe('https://api.solana.com/openapi.json');
		expect(lastRequest.headers.authorization).toBeUndefined();
	});

	it('attaches the Bearer key and honors SDP_API_BASE', async () => {
		process.env.SDP_API_KEY = 'sdp_live_abc';
		process.env.SDP_API_BASE = 'https://sandbox.example.com/';
		mockFetch(200, { items: [] });
		await sdpRequest('v1/wallets', { query: { limit: 10, skip: '' } });
		expect(lastRequest.url).toBe('https://sandbox.example.com/v1/wallets?limit=10');
		expect(lastRequest.headers.authorization).toBe('Bearer sdp_live_abc');
	});

	it('serializes a JSON body on POST and sets content-type', async () => {
		process.env.SDP_API_KEY = 'sdp_live_abc';
		mockFetch(201, { id: 'wal_1' });
		await sdpRequest('v1/wallets', { method: 'POST', body: { name: 'treasury' } });
		expect(lastRequest.method).toBe('POST');
		expect(lastRequest.headers['content-type']).toBe('application/json');
		expect(JSON.parse(lastRequest.body)).toEqual({ name: 'treasury' });
	});

	it('returns the upstream status + body without throwing on HTTP errors', async () => {
		process.env.SDP_API_KEY = 'sdp_live_abc';
		mockFetch(400, { error: { code: 'BAD_REQUEST', message: 'nope' } }, { traceId: 'trace-9' });
		const res = await sdpRequest('v1/wallets', { method: 'POST', body: {} });
		expect(res.status).toBe(400);
		expect(res.traceId).toBe('trace-9');
		expect(res.body.error.code).toBe('BAD_REQUEST');
	});
});

describe('sdpCall', () => {
	it('returns the body on 2xx', async () => {
		mockFetch(200, { status: 'ok' });
		await expect(sdpHealth()).resolves.toEqual({ status: 'ok' });
	});

	it('throws the structured upstream error on non-2xx', async () => {
		process.env.SDP_API_KEY = 'sdp_live_abc';
		mockFetch(409, { error: { code: 'ALREADY_INITIALIZED', message: 'exists' } });
		await expect(sdpCall('v1/wallets', { method: 'POST', body: {} })).rejects.toMatchObject({
			status: 409,
			code: 'ALREADY_INITIALIZED',
		});
	});
});
