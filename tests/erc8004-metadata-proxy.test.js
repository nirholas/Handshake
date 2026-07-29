// GET /api/erc8004/metadata: the registration-JSON proxy.
//
// An ERC-8004 agent's registration JSON is hosted wherever its registrant put
// it, and most of those hosts send no Access-Control-Allow-Origin, so the
// browser could not read them: every such agent page rendered "Could not fetch
// registration JSON: Failed to fetch". The server has no same-origin policy, so
// this endpoint fetches it instead.
//
// The URI is attacker-influenced (it comes off-chain from whoever registered the
// agent), which makes this endpoint a classic SSRF sink. These tests pin the two
// properties that matter: it fetches ONLY through the platform pinned guard
// (never a raw fetch that would follow redirects into an internal address), and
// every failure mode answers with a designed status instead of leaking or 500ing.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const pinned = vi.fn();

vi.mock('../api/_lib/ssrf-guard.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		fetchSafePublicUrlPinned: (...args) => pinned(...args),
	};
});

vi.mock('../api/_lib/rate-limit.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		clientIp: () => '203.0.113.9',
		limits: { ...actual.limits, pumpMetaIp: async () => ({ success: true }) },
	};
});

const { SsrfBlockedError, MaxBytesExceededError } = await import('../api/_lib/ssrf-guard.js');
const handler = (await import('../api/erc8004/[action].js')).default;

function makeReq(query) {
	return { method: 'GET', url: '/api/erc8004/metadata', headers: {}, query };
}

function makeRes() {
	const res = {
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
	return res;
}

async function call(query) {
	const res = makeRes();
	await handler(makeReq({ action: 'metadata', ...query }), res);
	let parsed = null;
	try {
		parsed = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
	} catch {
		parsed = res.body;
	}
	return { status: res.statusCode, body: parsed, headers: res.headers };
}

beforeEach(() => {
	pinned.mockReset();
});

describe('GET /api/erc8004/metadata', () => {
	it('returns the registration JSON a CORS-blocked host would not give the browser', async () => {
		const doc = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Agent' };
		pinned.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(doc) });

		const { status, body } = await call({ uri: 'https://registry.example/agent/1' });

		expect(status).toBe(200);
		expect(body.data).toEqual(doc);
		expect(body.resolvedUrl).toBe('https://registry.example/agent/1');
	});

	it('fetches only through the pinned SSRF guard, with a byte ceiling', async () => {
		pinned.mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });

		await call({ uri: 'https://registry.example/agent/1' });

		expect(pinned).toHaveBeenCalledTimes(1);
		const [url, , opts] = pinned.mock.calls[0];
		expect(url).toBe('https://registry.example/agent/1');
		expect(opts.maxBytes).toBe(2 * 1024 * 1024);
	});

	it('resolves ipfs:// and ar:// to their public gateways before fetching', async () => {
		pinned.mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });

		await call({ uri: 'ipfs://bafyagent' });
		expect(pinned.mock.calls[0][0]).toBe('https://ipfs.io/ipfs/bafyagent');

		pinned.mockClear();
		await call({ uri: 'ar://txid123' });
		expect(pinned.mock.calls[0][0]).toBe('https://arweave.net/txid123');
	});

	it('rejects a missing uri', async () => {
		const { status, body } = await call({});
		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
		expect(pinned).not.toHaveBeenCalled();
	});

	it('rejects a non-http scheme without ever fetching', async () => {
		const { status, body } = await call({ uri: 'file:///etc/passwd' });
		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
		expect(pinned).not.toHaveBeenCalled();
	});

	it('answers 400 blocked_uri when the guard refuses an internal address', async () => {
		pinned.mockRejectedValue(new SsrfBlockedError('blocked private address'));

		const { status, body } = await call({ uri: 'http://169.254.169.254/latest/meta-data/' });

		expect(status).toBe(400);
		expect(body.error).toBe('blocked_uri');
		// The upstream reason never reaches the caller.
		expect(JSON.stringify(body)).not.toContain('169.254');
	});

	it('answers 413 when the host streams past the byte ceiling', async () => {
		pinned.mockRejectedValue(new MaxBytesExceededError('too big'));

		const { status, body } = await call({ uri: 'https://registry.example/huge' });

		expect(status).toBe(413);
		expect(body.error).toBe('too_large');
	});

	it('answers 502 when the registration host is unreachable', async () => {
		pinned.mockRejectedValue(new Error('ECONNREFUSED'));

		const { status, body } = await call({ uri: 'https://registry.example/down' });

		expect(status).toBe(502);
		expect(body.error).toBe('upstream_unreachable');
	});

	it('answers 502 when the host returns a non-OK status', async () => {
		pinned.mockResolvedValue({ ok: false, status: 404, text: async () => 'nope' });

		const { status, body } = await call({ uri: 'https://registry.example/missing' });

		expect(status).toBe(502);
		expect(body.error).toBe('upstream_error');
	});

	it('answers 502 rather than passing through a host that serves HTML', async () => {
		pinned.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>error page</html>' });

		const { status, body } = await call({ uri: 'https://registry.example/html' });

		expect(status).toBe(502);
		expect(body.error).toBe('invalid_json');
	});

	it('lets a successful lookup be edge-cached', async () => {
		pinned.mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });

		const { headers } = await call({ uri: 'https://registry.example/agent/1' });

		expect(headers['cache-control']).toMatch(/s-maxage=\d+/);
	});
});
