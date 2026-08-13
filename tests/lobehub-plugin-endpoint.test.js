/**
 * api/lobehub/[action].js — the host-facing half of the LobeHub / LobeChat
 * plugin (manifest, .well-known config, handshake).
 *
 * `api/_lib/db.js` and `api/_lib/rate-limit.js` are mocked so every branch runs
 * deterministically without a database: the agent-found, agent-missing,
 * owner-policy, and database-outage paths are all reachable from here, and none
 * of them needs a live Neon branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		widgetRead: vi.fn(async () => ({
			success: rl.ok,
			limit: 60,
			remaining: 0,
			reset: Date.now() + 60_000,
		})),
	},
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../api/lobehub/[action].js');

const AGENT_ID = '11111111-2222-4333-8444-555555555555';

function makeReq({ method = 'GET', action, body = null, headers = {} } = {}) {
	const req = {
		method,
		url: `/api/lobehub/${action}`,
		query: { action },
		headers: { origin: 'https://chat.lobehub.com', ...headers },
		socket: { remoteAddress: '127.0.0.1' },
	};
	if (body !== null) {
		req.headers['content-type'] = req.headers['content-type'] || 'application/json';
		req.body = body;
	}
	return req;
}

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null, writableEnded: false, headersSent: false };
	r.setHeader = (k, v) => { r._h[k.toLowerCase()] = v; };
	r.getHeader = (k) => r._h[k.toLowerCase()];
	r.end = (b) => { r._b = b ?? r._b; r.writableEnded = true; };
	r.json = () => (r._b ? JSON.parse(r._b) : undefined);
	return r;
}

async function call(opts) {
	const res = makeRes();
	await handler(makeReq(opts), res);
	return res;
}

beforeEach(() => {
	rl.ok = true;
	sqlMock.mockReset().mockResolvedValue([]);
});

describe('GET /api/lobehub/manifest', () => {
	it('serves the real plugin manifest with an open CORS policy', async () => {
		const res = await call({ action: 'manifest' });
		expect(res.statusCode).toBe(200);
		// LobeHub's plugin store fetches this URL straight from the browser, so a
		// restricted allow-origin breaks every install.
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
		expect(res.getHeader('cache-control')).toBe('public, max-age=300');
		const body = res.json();
		expect(body.identifier).toBe('3d-agent');
		expect(body.ui.url).toContain('/lobehub/iframe/');
		expect(body.api.map((a) => a.name)).toEqual(
			expect.arrayContaining(['render_agent', 'speak', 'gesture', 'emote']),
		);
	});

	it('answers a preflight without running the handler body', async () => {
		const res = await call({ action: 'manifest', method: 'OPTIONS' });
		expect(res.statusCode).toBe(204);
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
	});

	it('rejects a non-GET method with 405 and an Allow header', async () => {
		const res = await call({ action: 'manifest', method: 'POST' });
		expect(res.statusCode).toBe(405);
		expect(String(res.getHeader('allow'))).toContain('GET');
		expect(res.json().error).toBe('method_not_allowed');
	});
});

describe('GET /api/lobehub/config', () => {
	it('serves the .well-known descriptor openly', async () => {
		const res = await call({ action: 'config' });
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
		expect(res.json().identifier).toBe('3d-agent');
		expect(res.json().ui.settings.agentId.type).toBe('string');
	});
});

describe('POST /api/lobehub/handshake', () => {
	it('requires an agentId', async () => {
		const res = await call({ action: 'handshake', method: 'POST', body: {} });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a non-UUID agentId before it reaches Postgres', async () => {
		// agent_identities.id is a uuid column: passing a handle straight through
		// raised 22P02 and surfaced to the caller as an opaque 5xx.
		const res = await call({ action: 'handshake', method: 'POST', body: { agentId: 'my-agent' } });
		expect(res.statusCode).toBe(400);
		expect(res.json().error_description).toContain('UUID');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a hostOrigin that is not an http(s) URL', async () => {
		const res = await call({
			action: 'handshake',
			method: 'POST',
			body: { agentId: AGENT_ID, hostOrigin: 'javascript:alert(1)' },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error_description).toContain('http(s)');
	});

	it('404s an agent that does not exist', async () => {
		sqlMock.mockResolvedValue([]);
		const res = await call({ action: 'handshake', method: 'POST', body: { agentId: AGENT_ID } });
		expect(res.statusCode).toBe(404);
		expect(res.json().error).toBe('not_found');
	});

	it('returns the iframe URL, the agent name, and the plugin host allowlist', async () => {
		sqlMock
			.mockResolvedValueOnce([{ id: AGENT_ID, name: 'Ada' }])
			.mockResolvedValueOnce([{ embed_policy: null }]);
		const res = await call({
			action: 'handshake',
			method: 'POST',
			body: { agentId: AGENT_ID, hostOrigin: 'https://chat.example.com/some/path' },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.verified).toBe(true);
		expect(body.agentName).toBe('Ada');
		expect(body.iframeUrl).toBe(`https://three.ws/lobehub/iframe/?agent=${AGENT_ID}`);
		expect(body.embedPolicy.origins.mode).toBe('allowlist');
		expect(body.embedPolicy.origins.hosts).toContain('chat.lobehub.com');
		// Only the hostname of the caller's origin is folded in, never a path.
		expect(body.embedPolicy.origins.hosts).toContain('chat.example.com');
	});

	it("unions the owner's own allowlist into the reported policy", async () => {
		sqlMock
			.mockResolvedValueOnce([{ id: AGENT_ID, name: 'Ada' }])
			.mockResolvedValueOnce([
				{ embed_policy: { origins: { mode: 'allowlist', hosts: ['docs.example.org'] } } },
			]);
		const res = await call({ action: 'handshake', method: 'POST', body: { agentId: AGENT_ID } });
		expect(res.statusCode).toBe(200);
		const hosts = res.json().embedPolicy.origins.hosts;
		expect(hosts).toContain('docs.example.org');
		expect(hosts).toContain('chat.lobehub.com');
		expect(new Set(hosts).size).toBe(hosts.length);
	});

	it("passes an owner's denylist through instead of inverting it", async () => {
		sqlMock
			.mockResolvedValueOnce([{ id: AGENT_ID, name: null }])
			.mockResolvedValueOnce([
				{ embed_policy: { origins: { mode: 'denylist', hosts: ['Bad.example'] } } },
			]);
		const res = await call({ action: 'handshake', method: 'POST', body: { agentId: AGENT_ID } });
		const origins = res.json().embedPolicy.origins;
		expect(origins.mode).toBe('denylist');
		expect(origins.hosts).toEqual(['bad.example']);
	});

	it('degrades to an unverified handshake when the database is unreachable', async () => {
		sqlMock.mockRejectedValue(new Error('connection refused'));
		const res = await call({ action: 'handshake', method: 'POST', body: { agentId: AGENT_ID } });
		expect(res.statusCode).toBe(200);
		expect(res.json().verified).toBe(false);
		expect(res.json().iframeUrl).toContain(AGENT_ID);
	});

	it('429s when the widget-read limiter is exhausted', async () => {
		rl.ok = false;
		const res = await call({ action: 'handshake', method: 'POST', body: { agentId: AGENT_ID } });
		expect(res.statusCode).toBe(429);
		expect(res.json().error).toBe('rate_limited');
		expect(res.getHeader('retry-after')).toBeDefined();
	});
});

describe('unknown lobehub action', () => {
	it('404s rather than falling through', async () => {
		const res = await call({ action: 'bogus' });
		expect(res.statusCode).toBe(404);
		expect(res.json().error).toBe('not_found');
	});
});
