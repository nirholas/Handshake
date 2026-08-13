// GET /api/llm/health - the gate in front of the provider report.
//
// The report names every configured provider and quotes the upstream error
// text, which is exactly the material that tells an attacker which vendor key
// is dead or out of credits. The handler is also the hourly Cloud Scheduler
// target (vercel.json crons), so it has to accept both header shapes a caller
// can present: `X-Cron-Secret` from an operator or external monitor, and
// `Authorization: Bearer` from the scheduled invocation. These pin the gate and
// the alert hand-off; the probe itself is covered in llm-health-vertex.test.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const healthState = { report: { overall: 'ok', anthropic: { status: 'ok' } } };
vi.mock('../../api/_lib/llm-health.js', () => ({
	probeLlmHealth: vi.fn(async () => healthState.report),
}));

const alerts = [];
vi.mock('../../api/_lib/alerts.js', () => ({
	sendOpsAlert: vi.fn(async (title, detail, opts) => {
		alerts.push({ title, detail, opts });
	}),
}));

const { default: handler } = await import('../../api/llm/health.js');

const SECRET = 'cron-secret-under-test';

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(headers = {}, method = 'GET') {
	const req = { method, url: '/api/llm/health', headers };
	const res = makeRes();
	await handler(req, res);
	let body = null;
	try {
		body = res.body ? JSON.parse(res.body) : null;
	} catch {
		body = res.body;
	}
	return { status: res.statusCode, body };
}

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
	process.env.CRON_SECRET = SECRET;
	healthState.report = { overall: 'ok', anthropic: { status: 'ok' } };
	alerts.length = 0;
});

afterEach(() => {
	if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
	else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe('GET /api/llm/health: authorization', () => {
	it('serves the provider report to a valid X-Cron-Secret header', async () => {
		const { status, body } = await invoke({ 'x-cron-secret': SECRET });
		expect(status).toBe(200);
		expect(body).toEqual({ overall: 'ok', anthropic: { status: 'ok' } });
	});

	it('serves the provider report to the Bearer form Cloud Scheduler sends', async () => {
		const { status, body } = await invoke({ authorization: `Bearer ${SECRET}` });
		expect(status).toBe(200);
		expect(body.overall).toBe('ok');
	});

	it('refuses an unauthenticated caller without naming a provider', async () => {
		const { status, body } = await invoke();
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
		expect(JSON.stringify(body)).not.toContain('anthropic');
	});

	it('refuses a wrong secret in either header', async () => {
		expect((await invoke({ 'x-cron-secret': 'wrong' })).status).toBe(403);
		expect((await invoke({ authorization: 'Bearer wrong' })).status).toBe(403);
	});

	it('refuses a repeated header that arrives as an array', async () => {
		const { status } = await invoke({ 'x-cron-secret': [SECRET, 'wrong'] });
		expect(status).toBe(403);
	});

	it('reports 503 rather than opening the gate when no CRON_SECRET is deployed', async () => {
		delete process.env.CRON_SECRET;
		const { status, body } = await invoke({ 'x-cron-secret': SECRET });
		expect(status).toBe(503);
		expect(body.error).toBe('not_configured');
	});

	it('allows GET only', async () => {
		const { status, body } = await invoke({ 'x-cron-secret': SECRET }, 'POST');
		expect(status).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});
});

describe('GET /api/llm/health: ops alerting', () => {
	it('pages ops with the failing providers when the report degrades', async () => {
		healthState.report = {
			overall: 'degraded',
			openrouter: { status: 'error', error: 'HTTP 402' },
			anthropic: { status: 'ok' },
		};
		const { status } = await invoke({ 'x-cron-secret': SECRET });
		expect(status).toBe(200);
		expect(alerts).toHaveLength(1);
		expect(alerts[0].title).toContain('DEGRADED');
		expect(alerts[0].detail).toContain('openrouter: HTTP 402');
		// Deduped per failing-provider signature so a sustained outage pages once.
		expect(alerts[0].opts.signature).toBe('llm-health:degraded:openrouter: HTTP 402');
	});

	it('stays quiet while every configured provider passes', async () => {
		await invoke({ 'x-cron-secret': SECRET });
		expect(alerts).toHaveLength(0);
	});
});
