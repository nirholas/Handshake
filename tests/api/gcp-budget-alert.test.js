// /api/webhooks/gcp-budget-alert — Pub/Sub budget push → ops alert.
//
// Verifies the security + noise-control contract of the budget webhook:
//   • no shared secret configured → 503 (never accept unauthenticated pings)
//   • wrong token → 401
//   • a real threshold crossing → 200 + exactly one ops alert
//   • an info message (no alertThresholdExceeded) → 200 but NO alert (noise gate)
//   • a subscription-verification ping (no decodable data) → 200, no alert

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendOpsAlert = vi.fn(async () => {});
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => null, drain: async () => {} }));
vi.mock('../../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'http://localhost:3000' } }));

const { default: handler } = await import('../../api/webhooks/gcp-budget-alert.js');
// The REAL severity classifier, not the mock: the alert title is the only input
// that decides whether ops sees a budget crossing as critical or as a warning,
// so the test has to run the classifier that ships.
const { severityOf } = await vi.importActual('../../api/_lib/alerts.js');

function pubsubBody(notification) {
	const data = Buffer.from(JSON.stringify(notification), 'utf8').toString('base64');
	return JSON.stringify({ message: { data, messageId: '1', publishTime: 'now' }, subscription: 'sub' });
}

function mkReq({ token = 'secret', body = '', headers = {} } = {}) {
	const url = `/api/webhooks/gcp-budget-alert${token != null ? `?token=${encodeURIComponent(token)}` : ''}`;
	const listeners = {};
	const req = {
		method: 'POST',
		url,
		headers: { 'content-type': 'application/json', ...headers },
		on(event, cb) { listeners[event] = cb; return req; },
		destroy() {},
	};
	// Deliver the body on the next tick, after readBody attaches its listeners.
	queueMicrotask(() => {
		if (body && listeners.data) listeners.data(Buffer.from(body, 'utf8'));
		if (listeners.end) listeners.end();
	});
	return req;
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}

async function invoke(opts = {}) {
	const res = mkRes();
	await handler(mkReq(opts), res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

describe('gcp-budget-alert webhook', () => {
	beforeEach(() => {
		sendOpsAlert.mockClear();
		process.env.GCP_BUDGET_WEBHOOK_SECRET = 'secret';
	});

	it('refuses when no secret is configured (503)', async () => {
		delete process.env.GCP_BUDGET_WEBHOOK_SECRET;
		const { status } = await invoke({ token: 'secret', body: pubsubBody({ alertThresholdExceeded: 0.5 }) });
		expect(status).toBe(503);
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});

	it('rejects a wrong token (401)', async () => {
		const { status } = await invoke({ token: 'nope', body: pubsubBody({ alertThresholdExceeded: 0.5 }) });
		expect(status).toBe(401);
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});

	it('alerts once on a real threshold crossing', async () => {
		const { status, body } = await invoke({
			token: 'secret',
			body: pubsubBody({
				budgetDisplayName: 'gcp-credits — program',
				alertThresholdExceeded: 0.9,
				costAmount: 90000,
				budgetAmount: 100000,
				currencyCode: 'USD',
			}),
		});
		expect(status).toBe(200);
		expect(body.alerted).toBe(true);
		expect(body.threshold).toBe(0.9);
		expect(sendOpsAlert).toHaveBeenCalledTimes(1);
		const [title, detail, opts] = sendOpsAlert.mock.calls[0];
		expect(title).toContain('90%');
		expect(detail).toContain('$90,000');
		expect(opts.signature).toBe('gcp-budget:gcp-credits — program:0.9');
	});

	it('does NOT alert on an info message with no threshold', async () => {
		const { status, body } = await invoke({
			token: 'secret',
			body: pubsubBody({ budgetDisplayName: 'gcp-credits — program', costAmount: 100, budgetAmount: 100000 }),
		});
		expect(status).toBe(200);
		expect(body.alerted).toBe(false);
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});

	it('files a 90% crossing as critical, not as routine burn-down noise', async () => {
		await invoke({
			token: 'secret',
			body: pubsubBody({
				budgetDisplayName: 'gcp-credits program',
				alertThresholdExceeded: 0.9,
				costAmount: 90000,
				budgetAmount: 100000,
			}),
		});
		const [title] = sendOpsAlert.mock.calls[0];
		// alerts.js severityOf() reads the emoji: 🚨 is what makes this `critical`.
		// Any other marker files a near-exhausted grant next to routine warnings.
		expect(severityOf(title)).toBe('critical');
	});

	it('keeps a 25% crossing at warn severity', async () => {
		await invoke({
			token: 'secret',
			body: pubsubBody({
				budgetDisplayName: 'gcp-credits program',
				alertThresholdExceeded: 0.25,
				costAmount: 25000,
				budgetAmount: 100000,
			}),
		});
		const [title] = sendOpsAlert.mock.calls[0];
		expect(severityOf(title)).toBe('warn');
	});

	it('renders a zero budget without emitting a broken percentage', async () => {
		const { status } = await invoke({
			token: 'secret',
			body: pubsubBody({
				budgetDisplayName: 'misconfigured budget',
				alertThresholdExceeded: 0.5,
				costAmount: 5,
				budgetAmount: 0,
			}),
		});
		expect(status).toBe(200);
		const [, detail] = sendOpsAlert.mock.calls[0];
		expect(detail).toContain('(n/a)');
	});

	it('acks a verification ping with no decodable data', async () => {
		const { status, body } = await invoke({ token: 'secret', body: JSON.stringify({ message: { messageId: 'x' } }) });
		expect(status).toBe(200);
		expect(body.parsed).toBe(false);
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});
});
