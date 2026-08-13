// GET /api/llm/health — the gate in front of the provider report.
//
// The report names every configured provider and quotes the upstream's own
// error text, which is exactly the material an attacker wants: which vendor key
// is dead, which account is out of credits, which lane is currently carrying
// traffic. The probe itself is covered in llm-health-vertex.test.js; what is
// pinned here is the handler around it — the cron secret gate (both header
// forms), the method gate, the unconfigured-deployment response, and the ops
// page that fires on a degraded verdict.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/_lib/env.js', () => ({
	env: new Proxy({}, { get: (_t, k) => process.env[k] }),
}));

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
const { probeLlmHealth } = await import('../../api/_lib/llm-health.js');

const SECRET = 'test-cron-secret-llm-health';
const ORIGINAL_ENV = { ...process.env };

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		headersSent: false,
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

async function invoke({ method = 'GET', headers = {} } = {}) {
	const req = { method, url: '/api/llm/health', headers };
	const res = makeRes();
	await handler(req, res);
	let body = null;
	try {
		body = res.body ? JSON.parse(res.body) : null;
	} catch {
		body = res.body;
	}
	return { res, status: res.statusCode, body };
}

beforeEach(() => {
	process.env.CRON_SECRET = SECRET;
	healthState.report = { overall: 'ok', anthropic: { status: 'ok' } };
	alerts.length = 0;
	probeLlmHealth.mockClear();
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe('/api/llm/health: cron secret gate', () => {
	it('rejects an unauthenticated caller without probing any provider', async () => {
		const { status, body } = await invoke();
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
		// The gate runs before the probe: no provider names, no upstream calls.
		expect(JSON.stringify(body)).not.toContain('anthropic');
		expect(probeLlmHealth).not.toHaveBeenCalled();
	});

	it('rejects a wrong secret in either header form', async () => {
		const viaHeader = await invoke({ headers: { 'x-cron-secret': 'wrong' } });
		const viaBearer = await invoke({ headers: { authorization: 'Bearer wrong' } });
		expect(viaHeader.status).toBe(403);
		expect(viaBearer.status).toBe(403);
		expect(probeLlmHealth).not.toHaveBeenCalled();
	});

	it('rejects a repeated header that collapses into a comma-joined value', async () => {
		// Node hands a duplicated header through as an array; the comparison
		// stringifies it, so the smuggled copy must still fail closed.
		const { status } = await invoke({ headers: { 'x-cron-secret': [SECRET, 'wrong'] } });
		expect(status).toBe(403);
	});

	it('serves the report to the X-Cron-Secret header an operator sends', async () => {
		const { status, body } = await invoke({ headers: { 'x-cron-secret': SECRET } });
		expect(status).toBe(200);
		expect(body).toEqual({ overall: 'ok', anthropic: { status: 'ok' } });
	});

	it('serves the report to the Bearer form the scheduled invocation sends', async () => {
		const { status, body } = await invoke({ headers: { authorization: `Bearer ${SECRET}` } });
		expect(status).toBe(200);
		expect(body.overall).toBe('ok');
	});

	it('answers 503 not_configured when the deployment has no CRON_SECRET', async () => {
		delete process.env.CRON_SECRET;
		const { status, body } = await invoke({ headers: { 'x-cron-secret': SECRET } });
		expect(status).toBe(503);
		expect(body.error).toBe('not_configured');
		expect(probeLlmHealth).not.toHaveBeenCalled();
	});

	it('refuses a non-GET method', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			headers: { 'x-cron-secret': SECRET },
		});
		expect(status).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});
});

describe('/api/llm/health: ops paging', () => {
	it('pages ops with the failing providers when the verdict is degraded', async () => {
		healthState.report = {
			overall: 'degraded',
			openrouter: { status: 'error', error: 'HTTP 402' },
			anthropic: { status: 'ok' },
		};
		const { status } = await invoke({ headers: { 'x-cron-secret': SECRET } });
		expect(status).toBe(200);
		expect(alerts).toHaveLength(1);
		expect(alerts[0].title).toContain('DEGRADED');
		expect(alerts[0].detail).toContain('openrouter: HTTP 402');
		// Healthy providers stay out of the page.
		expect(alerts[0].detail).not.toContain('anthropic');
		// Deduped on the failing set so a sustained outage pages once.
		expect(alerts[0].opts.signature).toBe('llm-health:degraded:openrouter: HTTP 402');
	});

	it('pages on a full outage too', async () => {
		healthState.report = { overall: 'down', anthropic: { status: 'error', error: 'HTTP 401' } };
		await invoke({ headers: { 'x-cron-secret': SECRET } });
		expect(alerts).toHaveLength(1);
		expect(alerts[0].title).toContain('DOWN');
	});

	it('stays quiet on a healthy or unconfigured verdict', async () => {
		await invoke({ headers: { 'x-cron-secret': SECRET } });
		healthState.report = { overall: 'unconfigured' };
		await invoke({ headers: { 'x-cron-secret': SECRET } });
		expect(alerts).toHaveLength(0);
	});
});
