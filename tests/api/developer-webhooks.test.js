import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '../_helpers/monetization.js';

// Coverage for the developer webhook surface (list/create and the per-webhook
// detail route). Three behaviors this pins, each a bug the endpoints shipped
// with:
//   1. developer_webhooks.id is uuid, so a malformed path segment reached
//      Postgres as `where id = 'not-a-uuid'` and 22P02 surfaced as a 500.
//   2. An unknown or empty `events` list was silently reduced to [], producing a
//      webhook that looked healthy in the dashboard and never fired.
//   3. The list route's 7-day delivery stats now come back on the same row as
//      the webhook (one query instead of 1 + N), and must still be nested under
//      stats_7d on the wire.

const authState = { session: null };
const sqlState = { calls: [], responses: [] };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
}));

vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: Array.isArray(strings) ? strings.join('?') : String(strings), values });
		return sqlState.responses.shift() ?? [];
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

// assertPublicHttpsUrl does real DNS resolution; the SSRF module has its own
// suite, so here it only needs to accept the example URLs under test.
vi.mock('../../api/_lib/ssrf.js', () => ({ assertPublicHttpsUrl: vi.fn(async () => true) }));

const { EVENT_TYPES } = await import('../../api/_lib/webhook-dispatch.js');
const { default: listHandler } = await import('../../api/developer/webhooks.js');
const { default: detailHandler } = await import('../../api/developer/webhooks/[id].js');

const OWNER = { id: '11111111-1111-4111-8111-111111111111' };
const WEBHOOK_ID = '22222222-2222-4222-8222-222222222222';
const BAD_ID = 'not-a-uuid';

const webhookRow = {
	id: WEBHOOK_ID,
	url: 'https://example.com/hook',
	events: ['agent.created'],
	active: true,
	description: null,
	created_at: '2026-08-01T00:00:00.000Z',
	updated_at: '2026-08-01T00:00:00.000Z',
};

beforeEach(() => {
	authState.session = OWNER;
	sqlState.calls = [];
	sqlState.responses = [];
});

describe('GET /api/developer/webhooks', () => {
	it('nests the joined delivery stats under stats_7d and issues one query', async () => {
		sqlState.responses = [[
			{ ...webhookRow, total: 3, succeeded: 2, failed: 1, last_delivery_at: '2026-08-02T00:00:00.000Z' },
		]];

		const { status, body } = await invoke(listHandler, { method: 'GET', url: '/api/developer/webhooks' });

		expect(status).toBe(200);
		expect(sqlState.calls).toHaveLength(1);
		expect(body.webhooks).toHaveLength(1);
		expect(body.webhooks[0].stats_7d).toEqual({
			total: 3,
			succeeded: 2,
			failed: 1,
			last_delivery_at: '2026-08-02T00:00:00.000Z',
		});
		// The flattened join columns must not leak alongside the nested object.
		expect(body.webhooks[0].total).toBeUndefined();
		expect(body.event_types).toContain('agent.created');
	});

	it('returns 401 without a session', async () => {
		authState.session = null;
		const { status } = await invoke(listHandler, { method: 'GET', url: '/api/developer/webhooks' });
		expect(status).toBe(401);
		expect(sqlState.calls).toHaveLength(0);
	});
});

describe('POST /api/developer/webhooks event validation', () => {
	it('rejects an unknown event type instead of silently dropping it', async () => {
		const { status, body } = await invoke(listHandler, {
			method: 'POST',
			url: '/api/developer/webhooks',
			body: { url: 'https://example.com/hook', events: ['avatar.create'] },
		});

		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
		expect(body.error_description).toContain('avatar.create');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('treats an omitted list as every event type, per the documented contract', async () => {
		sqlState.responses = [[{ count: 0 }], [webhookRow]];

		const { status } = await invoke(listHandler, {
			method: 'POST',
			url: '/api/developer/webhooks',
			body: { url: 'https://example.com/hook' },
		});

		expect(status).toBe(201);
		const insert = sqlState.calls.at(-1);
		expect(insert.values).toContainEqual([...EVENT_TYPES]);
	});

	it('treats an explicitly empty list the same way, never storing a webhook subscribed to nothing', async () => {
		sqlState.responses = [[{ count: 0 }], [webhookRow]];

		const { status } = await invoke(listHandler, {
			method: 'POST',
			url: '/api/developer/webhooks',
			body: { url: 'https://example.com/hook', events: [] },
		});

		expect(status).toBe(201);
		const insert = sqlState.calls.at(-1);
		expect(insert.values).toContainEqual([...EVENT_TYPES]);
	});

	it('rejects a non-array events value', async () => {
		const { status, body } = await invoke(listHandler, {
			method: 'POST',
			url: '/api/developer/webhooks',
			body: { url: 'https://example.com/hook', events: 'agent.created' },
		});

		expect(status).toBe(400);
		expect(body.error_description).toContain('must be an array');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('creates the webhook with deduped events and returns the secret once', async () => {
		sqlState.responses = [
			[{ count: 0 }],
			[{ ...webhookRow, events: ['agent.created', 'agent.updated'] }],
		];

		const { status, body } = await invoke(listHandler, {
			method: 'POST',
			url: '/api/developer/webhooks',
			body: {
				url: 'https://example.com/hook',
				events: ['agent.created', 'agent.updated', 'agent.created'],
			},
		});

		expect(status).toBe(201);
		expect(body.webhook.secret).toMatch(/^whsec_/);
		const insert = sqlState.calls.at(-1);
		expect(insert.query).toContain('insert into developer_webhooks');
		expect(insert.values).toContainEqual(['agent.created', 'agent.updated']);
	});

	it('enforces the per-user webhook cap', async () => {
		sqlState.responses = [[{ count: 10 }]];

		const { status, body } = await invoke(listHandler, {
			method: 'POST',
			url: '/api/developer/webhooks',
			body: { url: 'https://example.com/hook', events: ['agent.created'] },
		});

		expect(status).toBe(409);
		expect(body.error).toBe('limit_reached');
	});
});

describe('/api/developer/webhooks/:id uuid guard', () => {
	it('answers 404 for a malformed id without querying Postgres', async () => {
		const { status, body } = await invoke(detailHandler, {
			method: 'GET',
			url: `/api/developer/webhooks/${BAD_ID}?id=${BAD_ID}`,
			query: { id: BAD_ID },
		});

		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('returns the webhook and its recent deliveries for a valid id', async () => {
		sqlState.responses = [[webhookRow], [{ id: 'd1', event_type: 'agent.created', status_code: 200 }]];

		const { status, body } = await invoke(detailHandler, {
			method: 'GET',
			url: `/api/developer/webhooks/${WEBHOOK_ID}?id=${WEBHOOK_ID}`,
			query: { id: WEBHOOK_ID },
		});

		expect(status).toBe(200);
		expect(body.webhook.id).toBe(WEBHOOK_ID);
		expect(body.deliveries).toHaveLength(1);
	});

	it('rejects an unknown event type on PATCH', async () => {
		sqlState.responses = [[webhookRow]];

		const { status, body } = await invoke(detailHandler, {
			method: 'PATCH',
			url: `/api/developer/webhooks/${WEBHOOK_ID}?id=${WEBHOOK_ID}`,
			query: { id: WEBHOOK_ID },
			body: { events: ['agent.created', 'nope'] },
		});

		expect(status).toBe(400);
		expect(body.error_description).toContain('nope');
		// Only the ownership lookup ran; no update was attempted.
		expect(sqlState.calls).toHaveLength(1);
	});
});
