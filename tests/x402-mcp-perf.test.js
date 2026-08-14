/**
 * GET /api/x402/mcp-perf: the MCP latency SLA feed the dashboard renders.
 *
 * Two behaviours here are deliberate and easy to "fix" into something worse:
 *
 *   - A breach is still a 200. The dashboard draws the breach itself, so
 *     answering non-2xx would make a tool over its p95 indistinguishable from
 *     the endpoint being down.
 *   - A missing table (the sweep has never run) is 200 with note
 *     no_samples_yet, while a real read failure is 503. One of those is a cold
 *     start, the other is an outage, and they must not read alike.
 *
 * The window is clamped rather than trusted, because it goes into a rolling
 * query: an unbounded one is a free way to make the database do arbitrary work.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let health = null;
let failure = null;

vi.mock('../api/_lib/x402/mcp-latency-sweep.js', () => ({
	readPerfHealth: async ({ windowHours }) => {
		if (failure) throw failure;
		return { ...health, window_hours: windowHours };
	},
}));

const { default: handler } = await import('../api/x402/mcp-perf.js');

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(payload) { this.headersSent = true; this.writableEnded = true; this.body = payload; },
		get json() { return this.body ? JSON.parse(this.body) : null; },
	};
}

const req = (url = '/api/x402/mcp-perf') => ({ method: 'GET', url, headers: {}, socket: {} });

beforeEach(() => {
	failure = null;
	health = {
		ok: true,
		healthy: false,
		tool_count: 12,
		breach_count: 1,
		breaches: [{ tool: 'render_avatar', p95_ms: 4200, sla_ms: 3000 }],
		tools: [{ tool: 'render_avatar', p50_ms: 900, p95_ms: 4200, p99_ms: 6100, samples: 41 }],
	};
});

describe('GET /api/x402/mcp-perf', () => {
	it('reports a breached SLA as a 200 the dashboard can render', async () => {
		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(200);
		expect(res.json.healthy).toBe(false);
		expect(res.json.breach_count).toBe(1);
		expect(res.json.breaches[0].tool).toBe('render_avatar');
		expect(res.json.generated_at).toBeTruthy();
	});

	it('clamps the requested window to the supported range', async () => {
		const res = mockRes();
		await handler(req('/api/x402/mcp-perf?window=100000'), res);
		expect(res.json.window_hours).toBe(168);

		const res2 = mockRes();
		await handler(req('/api/x402/mcp-perf?window=6'), res2);
		expect(res2.json.window_hours).toBe(6);

		const res3 = mockRes();
		await handler(req('/api/x402/mcp-perf?window=not-a-number'), res3);
		expect(res3.json.window_hours).toBe(24);
	});

	it('answers 200 no_samples_yet before the sweep has ever written a row', async () => {
		failure = new Error('relation "x402_perf_log" does not exist');
		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(200);
		expect(res.json.note).toBe('no_samples_yet');
		expect(res.json.tool_count).toBe(0);
		expect(res.json.error).toBeUndefined();
	});

	it('answers 503 on a real read failure', async () => {
		failure = new Error('connection terminated unexpectedly');
		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(503);
		expect(res.json.ok).toBe(false);
		expect(res.json.error).toBe('perf_read_failed');
	});

	it('refuses a method other than GET', async () => {
		const res = mockRes();
		await handler({ ...req(), method: 'DELETE' }, res);
		expect(res.statusCode).toBe(405);
	});
});
