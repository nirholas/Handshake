// Handler behaviour for @three-ws/agentcore-payments-mcp, with fetch stubbed.
//
// Every test replaces globalThis.fetch via node:test's mock tracker (restored
// automatically per-test), so no request ever leaves the process. Assertions
// cover the exact wire shape each handler sends (method, path, query, headers,
// JSON body) and how it maps upstream responses and failures.
//
// Run: node --test packages/agentcore-payments-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js snapshots env at import time — pin credentials/base BEFORE the
// dynamic imports below so the module under test sees exactly these values.
process.env.THREE_WS_SESSION = 'test-session-cookie';
process.env.THREE_WS_BASE = 'https://three.test';
delete process.env.PAYMENT_SESSION_TOKEN;
delete process.env.THREE_WS_TIMEOUT_MS;

const { def: createSession } = await import('../src/tools/create-session.js');
const { def: payWithSession } = await import('../src/tools/pay-with-session.js');
const { def: checkSession } = await import('../src/tools/check-session.js');
const { def: listSessions } = await import('../src/tools/list-sessions.js');
const { def: cancelSession } = await import('../src/tools/cancel-session.js');

const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';

function jsonResponse(data, { status = 200 } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(data),
	};
}

// Stub fetch for one test; returns the recorded calls [{ url, init }].
function stubFetch(t, responder) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, init) => {
		calls.push({ url: String(url), init });
		return responder(String(url), init);
	});
	return calls;
}

// ── create_payment_session ───────────────────────────────────────────────────

test('create_payment_session POSTs defaults with session auth and returns the token', async (t) => {
	const calls = stubFetch(t, () =>
		jsonResponse({ session: { id: SESSION_ID, status: 'active' }, token: 'pss_abc123' }),
	);

	const result = await createSession.handler({ budget_usd: 2.5 });

	assert.equal(calls.length, 1);
	const { url, init } = calls[0];
	assert.equal(url, 'https://three.test/api/pay/session');
	assert.equal(init.method, 'POST');
	assert.equal(init.headers.cookie, '__Host-sid=test-session-cookie');
	assert.equal(init.headers['content-type'], 'application/json');
	assert.deepEqual(JSON.parse(init.body), {
		budget_usd: 2.5,
		label: '',
		expiry_seconds: 3600,
		max_per_tx_usd: null,
		allowed_hosts: [],
		agent_id: null,
		network: 'solana',
		metadata: {},
	});

	assert.equal(result.ok, true);
	assert.equal(result.token, 'pss_abc123');
	assert.deepEqual(result.session, { id: SESSION_ID, status: 'active' });
	assert.match(result.note, /shown once/i, 'default note warns the token is shown once');
});

test('create_payment_session forwards explicit governance limits verbatim', async (t) => {
	const calls = stubFetch(t, () => jsonResponse({ session: {}, token: 'pss_x', note: 'upstream note' }));

	const result = await createSession.handler({
		budget_usd: 10,
		label: 'Research run #4',
		expiry_seconds: 600,
		max_per_tx_usd: 0.05,
		allowed_hosts: ['api.weather.com'],
		agent_id: SESSION_ID,
		network: 'solana',
		metadata: { run: 4 },
	});

	assert.deepEqual(JSON.parse(calls[0].init.body), {
		budget_usd: 10,
		label: 'Research run #4',
		expiry_seconds: 600,
		max_per_tx_usd: 0.05,
		allowed_hosts: ['api.weather.com'],
		agent_id: SESSION_ID,
		network: 'solana',
		metadata: { run: 4 },
	});
	assert.equal(result.note, 'upstream note', 'upstream note wins over the default');
});

// ── list_payment_sessions ────────────────────────────────────────────────────

test('list_payment_sessions builds the query and maps items/stats/has_more', async (t) => {
	const calls = stubFetch(t, () =>
		jsonResponse({
			items: [{ id: SESSION_ID }],
			stats: { total_spent_usd: 1.25 },
			next_cursor: 'cursor-2',
		}),
	);

	const result = await listSessions.handler({ status: 'active', limit: 5 });

	const url = new URL(calls[0].url);
	assert.equal(url.pathname, '/api/pay/session');
	assert.equal(url.searchParams.get('status'), 'active');
	assert.equal(url.searchParams.get('limit'), '5');
	assert.equal(calls[0].init.headers.cookie, '__Host-sid=test-session-cookie');

	assert.deepEqual(result, {
		ok: true,
		sessions: [{ id: SESSION_ID }],
		stats: { total_spent_usd: 1.25 },
		has_more: true,
	});
});

test('list_payment_sessions omits the status filter and defaults limit to 20', async (t) => {
	const calls = stubFetch(t, () => jsonResponse({ items: [], stats: {} }));

	const result = await listSessions.handler({});

	const url = new URL(calls[0].url);
	assert.equal(url.searchParams.has('status'), false, 'no status filter when omitted');
	assert.equal(url.searchParams.get('limit'), '20');
	assert.equal(result.has_more, false, 'no next_cursor means no more pages');
});

// ── check_payment_session ────────────────────────────────────────────────────

test('check_payment_session fetches the session only by default', async (t) => {
	const calls = stubFetch(t, () => jsonResponse({ session: { id: SESSION_ID, remaining_usd: 3 } }));

	const result = await checkSession.handler({ session_id: SESSION_ID });

	assert.equal(calls.length, 1);
	assert.equal(new URL(calls[0].url).pathname, `/api/pay/session/${SESSION_ID}`);
	assert.deepEqual(result, { ok: true, session: { id: SESSION_ID, remaining_usd: 3 } });
	assert.ok(!('recent_executions' in result), 'executions are opt-in');
});

test('check_payment_session with include_executions fans out to both routes', async (t) => {
	const calls = stubFetch(t, (url) =>
		url.includes('/executions')
			? jsonResponse({ items: [{ id: 'exec-1' }] })
			: jsonResponse({ session: { id: SESSION_ID } }),
	);

	const result = await checkSession.handler({ session_id: SESSION_ID, include_executions: true });

	assert.equal(calls.length, 2);
	const paths = calls.map((c) => new URL(c.url).pathname).sort();
	assert.deepEqual(paths, [
		`/api/pay/session/${SESSION_ID}`,
		`/api/pay/session/${SESSION_ID}/executions`,
	]);
	const execCall = calls.find((c) => c.url.includes('/executions'));
	assert.equal(new URL(execCall.url).searchParams.get('limit'), '10');
	assert.deepEqual(result.recent_executions, [{ id: 'exec-1' }]);
});

// ── cancel_payment_session ───────────────────────────────────────────────────

test('cancel_payment_session DELETEs and reports the refunded amount', async (t) => {
	const calls = stubFetch(t, () =>
		jsonResponse({ cancelled: true, session_id: SESSION_ID, refunded_usd: 0.25 }),
	);

	const result = await cancelSession.handler({ session_id: SESSION_ID });

	assert.equal(calls[0].init.method, 'DELETE');
	assert.equal(new URL(calls[0].url).pathname, `/api/pay/session/${SESSION_ID}`);
	assert.equal(result.ok, true);
	assert.equal(result.cancelled, true);
	assert.equal(result.refunded_usd, 0.25);
	assert.match(result.note, /\$0\.2500/, 'note states the refunded amount');
});

test('cancel_payment_session explains when nothing remained to refund', async (t) => {
	stubFetch(t, () => jsonResponse({ cancelled: true, session_id: SESSION_ID, refunded_usd: 0 }));

	const result = await cancelSession.handler({ session_id: SESSION_ID });
	assert.match(result.note, /No budget remained/);
});

// ── pay_with_session ─────────────────────────────────────────────────────────

test('pay_with_session executes via /api/pay/execute with an inline token and no cookie', async (t) => {
	const calls = stubFetch(t, () =>
		jsonResponse({
			paid: true,
			result: { data: 'hello' },
			payment: { amount_usd: 0.01, signature: 'sig111' },
			session: { remaining_usd: 1.99 },
			duration_ms: 42,
		}),
	);

	const result = await payWithSession.handler({
		url: 'https://api.example.com/paid',
		token: 'pss_inline',
	});

	const { url, init } = calls[0];
	assert.equal(url, 'https://three.test/api/pay/execute');
	assert.equal(init.method, 'POST');
	assert.equal(init.headers.cookie, undefined, 'payment execution must not send the account cookie');
	assert.deepEqual(JSON.parse(init.body), {
		session_token: 'pss_inline',
		url: 'https://api.example.com/paid',
		method: 'GET',
		body: null,
		idempotency_key: null,
	});

	assert.deepEqual(result, {
		ok: true,
		paid: true,
		result: { data: 'hello' },
		payment: { amount_usd: 0.01, signature: 'sig111' },
		session: { remaining_usd: 1.99 },
		duration_ms: 42,
	});
});

test('pay_with_session surfaces a free (un-paid) response distinctly', async (t) => {
	stubFetch(t, () => jsonResponse({ paid: false, result: { data: 'free' } }));

	const result = await payWithSession.handler({
		url: 'https://api.example.com/maybe-paid',
		token: 'pss_inline',
	});

	assert.deepEqual(result, {
		ok: true,
		paid: false,
		note: 'Endpoint served a free response — no payment was required.',
		result: { data: 'free' },
	});
});

// ── upstream failure mapping (lib/api.js) ────────────────────────────────────

test('a JSON upstream error becomes a coded error with status and body attached', async (t) => {
	stubFetch(t, () =>
		jsonResponse(
			{ error: 'per-tx ceiling exceeded', code: 'per_tx_ceiling' },
			{ status: 402 },
		),
	);

	await assert.rejects(
		payWithSession.handler({ url: 'https://api.example.com/paid', token: 'pss_inline' }),
		(err) => {
			assert.equal(err.message, 'per-tx ceiling exceeded');
			assert.equal(err.code, 'per_tx_ceiling');
			assert.equal(err.status, 402);
			assert.deepEqual(err.body, { error: 'per-tx ceiling exceeded', code: 'per_tx_ceiling' });
			return true;
		},
	);
});

test('a non-JSON upstream error falls back to upstream_error with the HTTP status', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => ({
		ok: false,
		status: 500,
		text: async () => 'internal server error (html)',
	}));

	await assert.rejects(
		listSessions.handler({}),
		(err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 500);
			assert.match(err.message, /HTTP 500/);
			assert.deepEqual(err.body, { raw: 'internal server error (html)' });
			return true;
		},
	);
});

test('an aborted request maps to code timeout; other fetch failures to network_error', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => {
		throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
	});
	await assert.rejects(
		checkSession.handler({ session_id: SESSION_ID }),
		(err) => err.code === 'timeout' && /timed out/.test(err.message),
	);

	t.mock.method(globalThis, 'fetch', async () => {
		throw new TypeError('fetch failed');
	});
	await assert.rejects(
		checkSession.handler({ session_id: SESSION_ID }),
		(err) => err.code === 'network_error' && /fetch failed/.test(err.message),
	);
});
