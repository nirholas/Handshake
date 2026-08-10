// /api/chat-plugin/[tool] — the gateway-facing tool endpoint LobeChat / SperaxOS
// call when the LLM invokes a plugin function. Validates arguments, reads the
// agent id from the Sperax-Plugin-Settings header, and returns the concise tool
// result the model reads back. Rate-limit is mocked so the test stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { widgetRead: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

// render-agent confirms a UUID agentId against agent_identities before it tells
// the model the panel is bound. Default: the agent exists.
const sqlMock = vi.fn(async () => [{ name: 'Nova' }]);
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a) }));

const REAL_UUID = '3f1c0b6a-7d21-4c8e-9a55-0b2e1d4f7a90';

const { default: handler } = await import('../../api/chat-plugin/[tool].js');

function makeReq({ method = 'POST', tool, body, headers = {} } = {}) {
	const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]);
	req.method = method;
	req.url = `/api/chat-plugin/${tool}`;
	req.query = { tool };
	req.headers = { 'content-type': 'application/json', ...headers };
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(b) {
			this._body = b;
			this.writableEnded = true;
		},
	};
}

async function call(opts) {
	const res = makeRes();
	await handler(makeReq(opts), res);
	let body = null;
	try {
		body = JSON.parse(res._body);
	} catch {
		/* non-JSON body */
	}
	return { res, body };
}

describe('/api/chat-plugin/[tool]', () => {
	beforeEach(() => {
		sqlMock.mockReset();
		sqlMock.mockResolvedValue([{ name: 'Nova' }]);
	});

	it('speak returns ok and clamps sentiment to [-1,1]', async () => {
		const { res, body } = await call({ tool: 'speak', body: { text: 'gm', sentiment: 5 } });
		expect(res.statusCode).toBe(200);
		expect(body).toMatchObject({ ok: true, action: 'speak', spoken: 'gm', sentiment: 1 });
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
	});

	it('speak rejects missing text', async () => {
		const { res, body } = await call({ tool: 'speak', body: {} });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('gesture validates the enum', async () => {
		expect((await call({ tool: 'gesture', body: { name: 'wave' } })).res.statusCode).toBe(200);
		expect((await call({ tool: 'gesture', body: { name: 'breakdance' } })).res.statusCode).toBe(
			400,
		);
	});

	it('emote validates the enum and clamps weight', async () => {
		const { body } = await call({
			tool: 'emote',
			body: { trigger: 'celebration', weight: 9 },
		});
		expect(body).toMatchObject({ ok: true, emotion: 'celebration', weight: 1 });
		expect((await call({ tool: 'emote', body: { trigger: 'nope' } })).res.statusCode).toBe(400);
	});

	it('render-agent reads agentId from the Sperax-Plugin-Settings header', async () => {
		const { res, body } = await call({
			tool: 'render-agent',
			body: {},
			headers: { 'sperax-plugin-settings': JSON.stringify({ agentId: 'a-77' }) },
		});
		expect(res.statusCode).toBe(200);
		expect(body).toMatchObject({ ok: true, action: 'render_agent', agentId: 'a-77' });
	});

	it('render-agent also accepts the lobe-chat-plugin-settings header', async () => {
		const { body } = await call({
			tool: 'render-agent',
			body: {},
			headers: { 'lobe-chat-plugin-settings': JSON.stringify({ agentId: 'a-9' }) },
		});
		expect(body).toMatchObject({ ok: true, agentId: 'a-9' });
	});

	it('render-agent 400s without an agentId', async () => {
		expect((await call({ tool: 'render-agent', body: {} })).res.statusCode).toBe(400);
	});

	it('render-agent 400s on a whitespace-only agentId', async () => {
		expect((await call({ tool: 'render-agent', body: { agentId: '   ' } })).res.statusCode).toBe(
			400,
		);
	});

	it('render-agent resolves a UUID agentId and names the agent', async () => {
		const { res, body } = await call({ tool: 'render-agent', body: { agentId: REAL_UUID } });
		expect(res.statusCode).toBe(200);
		expect(sqlMock).toHaveBeenCalledTimes(1);
		expect(body).toMatchObject({ ok: true, agentId: REAL_UUID, agentName: 'Nova' });
		expect(body.message).toContain('Nova');
	});

	it('render-agent trims a padded agentId from the settings header', async () => {
		const { body } = await call({
			tool: 'render-agent',
			body: {},
			headers: { 'sperax-plugin-settings': JSON.stringify({ agentId: ` ${REAL_UUID} ` }) },
		});
		expect(body).toMatchObject({ ok: true, agentId: REAL_UUID });
	});

	it('render-agent 404s when the UUID names no agent', async () => {
		sqlMock.mockResolvedValue([]);
		const { res, body } = await call({ tool: 'render-agent', body: { agentId: REAL_UUID } });
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
		expect(body.error_description).toContain('three.ws/dashboard');
	});

	it('render-agent binds unverified when the agent lookup fails', async () => {
		sqlMock.mockRejectedValue(new Error('connection terminated'));
		const { res, body } = await call({ tool: 'render-agent', body: { agentId: REAL_UUID } });
		expect(res.statusCode).toBe(200);
		expect(body).toMatchObject({ ok: true, agentId: REAL_UUID, agentName: null });
	});

	it('render-agent passes a non-UUID handle through without a DB read', async () => {
		const { res, body } = await call({ tool: 'render-agent', body: { agentId: '@nova' } });
		expect(res.statusCode).toBe(200);
		expect(sqlMock).not.toHaveBeenCalled();
		expect(body).toMatchObject({ ok: true, agentId: '@nova', agentName: null });
	});

	it('unknown tool returns 404', async () => {
		expect((await call({ tool: 'frobnicate', body: {} })).res.statusCode).toBe(404);
	});

	it('rejects non-POST methods', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', tool: 'speak', body: {} }), res);
		expect(res.statusCode).toBe(405);
	});
});
