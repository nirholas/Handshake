import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '../_helpers/monetization.js';

// The developer dashboard's usage panel. Two behaviors pinned here:
//
//   1. x402 revenue is read from settled checkout calls against the caller's own
//      SKUs. The original query hit x402_receipts on payee_user_id/amount_usdc/
//      created_at, columns that table has never had, so every request threw and
//      a blanket .catch() reported a clean 0 to every developer.
//   2. A query that does fail still degrades gracefully, but now names itself in
//      `degraded` instead of masquerading as real zeros.

const authState = { session: null };
const sqlState = { calls: [], handler: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
}));

vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn((strings, ...values) => {
		const query = Array.isArray(strings) ? strings.join('?') : String(strings);
		sqlState.calls.push({ query, values });
		return sqlState.handler(query, values);
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

const { default: handler } = await import('../../api/developer/usage.js');

const OWNER = { id: '11111111-1111-4111-8111-111111111111' };

function defaultRows(query) {
	if (query.includes('from api_keys')) return [{ total_keys: 2, active_keys: 1 }];
	if (query.includes('date_trunc')) return [{ day: '2026-08-01', requests: 4 }];
	if (query.includes('group by action')) return [{ action: 'login', count: 4 }];
	if (query.includes('from audit_log')) {
		return [{
			total_requests: 10,
			unique_actions: 3,
			error_count: 2,
			first_request_at: '2026-08-01T00:00:00.000Z',
			last_request_at: '2026-08-02T00:00:00.000Z',
		}];
	}
	if (query.includes('webhook_deliveries')) return [{ total_deliveries: 5, succeeded: 4, failed: 1 }];
	if (query.includes('x402_checkout_calls')) return [{ total_payments: 3, total_atomics: '750000' }];
	return [];
}

beforeEach(() => {
	authState.session = OWNER;
	sqlState.calls = [];
	sqlState.handler = async (query) => defaultRows(query);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /api/developer/usage', () => {
	it('reports x402 revenue from settled checkout calls on the caller\'s SKUs', async () => {
		const { status, body } = await invoke(handler, { method: 'GET', url: '/api/developer/usage' });

		expect(status).toBe(200);
		expect(body.x402).toEqual({ payments: 3, volume_usdc: 0.75, volume_atomics: '750000' });
		expect(body.degraded).toEqual([]);

		const x402Query = sqlState.calls.find((c) => c.query.includes('x402_checkout_calls'));
		expect(x402Query.query).toContain('x402_skus');
		expect(x402Query.query).toContain('owner_user_id');
		expect(x402Query.query).toContain('response_status < 400');
		// The old, permanently-broken source must not come back.
		expect(sqlState.calls.some((c) => c.query.includes('x402_receipts'))).toBe(false);
	});

	it('clamps the lookback window to the allowed set', async () => {
		const { body: outOfRange } = await invoke(handler, { method: 'GET', url: '/api/developer/usage?days=999' });
		expect(outOfRange.period.days).toBe(30);

		const { body: garbage } = await invoke(handler, { method: 'GET', url: '/api/developer/usage?days=abc' });
		expect(garbage.period.days).toBe(30);

		const { body: allowed } = await invoke(handler, { method: 'GET', url: '/api/developer/usage?days=7' });
		expect(allowed.period.days).toBe(7);
	});

	it('computes the error rate from the audit counts', async () => {
		const { body } = await invoke(handler, { method: 'GET', url: '/api/developer/usage' });
		expect(body.requests.total).toBe(10);
		expect(body.requests.errors).toBe(2);
		expect(body.error_rate ?? body.requests.error_rate).toBe(20);
	});

	it('names a failed section in `degraded` rather than reporting it as zero', async () => {
		sqlState.handler = async (query) => {
			if (query.includes('x402_checkout_calls')) throw new Error('relation "x402_skus" does not exist');
			return defaultRows(query);
		};

		const { status, body } = await invoke(handler, { method: 'GET', url: '/api/developer/usage' });

		expect(status).toBe(200);
		expect(body.degraded).toEqual(['x402']);
		expect(body.x402.payments).toBe(0);
		// The rest of the dashboard still renders real numbers.
		expect(body.webhooks.total_deliveries).toBe(5);
		expect(console.warn).toHaveBeenCalled();
	});

	it('returns 401 without a session', async () => {
		authState.session = null;
		const { status } = await invoke(handler, { method: 'GET', url: '/api/developer/usage' });
		expect(status).toBe(401);
		expect(sqlState.calls).toHaveLength(0);
	});

	it('rejects a non-GET method', async () => {
		const { status } = await invoke(handler, { method: 'POST', url: '/api/developer/usage', body: {} });
		expect(status).toBe(405);
	});
});
