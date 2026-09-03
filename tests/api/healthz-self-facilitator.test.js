// /api/healthz — self_facilitator block: aggregates the last 24h of
// x402_self_facilitator_log verify/settle outcomes by reason class so a
// buyer-facing verify-rejection streak (e.g. a wallet mutating the prepared
// transaction) is visible on the public health surface instead of only in
// admin dashboards.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

// sql template-tag mock: answer the self-facilitator aggregate with canned
// rows; every other query (siwx probe, monitor heartbeat) fails so those
// blocks take their degraded paths, same as the main healthz suite.
const FAC_ROWS = [
	{ action: 'verify', ok: true, reason: '', n: 12 },
	{ action: 'verify', ok: false, reason: 'program_not_allowed', n: 3 },
	{ action: 'verify', ok: false, reason: 'cu_price_too_high', n: 1 },
	{ action: 'settle', ok: true, reason: '', n: 11 },
	{ action: 'settle', ok: false, reason: 'broadcast_failed', n: 2 },
];
// Every other query rejects rather than throwing synchronously. Modules on
// this import chain call `sql` at module scope to build reusable column
// fragments (api/_lib/home/store.js), so a synchronous throw kills the import
// before a single test runs. A rejected promise is also what a DB outage
// actually looks like to the handler's try/catch.
vi.mock('../../api/_lib/db.js', () => ({
	sql: (strings) => {
		if (Array.isArray(strings) && strings.join('').includes('x402_self_facilitator_log')) {
			return Promise.resolve(FAC_ROWS);
		}
		return { then: (_resolve, reject) => reject(new Error('no database in test')) };
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

import healthz, { _resetX402Cache } from '../../api/healthz.js';

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}

beforeEach(() => {
	_resetX402Cache();
});

describe('GET /api/healthz — self_facilitator outcomes', () => {
	it('aggregates verify/settle counts and reason classes from the log', async () => {
		const res = makeRes();
		await healthz({ url: '/api/healthz', method: 'GET', headers: {} }, res);
		const body = JSON.parse(res._body);
		expect(body.x402.self_facilitator).toEqual({
			verify: {
				ok: 12,
				rejected: 4,
				reject_reasons: { program_not_allowed: 3, cu_price_too_high: 1 },
			},
			settle: {
				ok: 11,
				failed: 2,
				fail_reasons: { broadcast_failed: 2 },
			},
		});
	});
});
