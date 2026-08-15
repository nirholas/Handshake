// Handler behaviour for @three-ws/alerts-mcp, with fetch stubbed.
//
// registration.test.mjs pins the tool surface; this suite pins what the tools
// actually do on the wire and to the data. Every test replaces globalThis.fetch
// via node:test's mock tracker (restored automatically per-test), so no request
// ever leaves the process. Assertions cover the exact request each handler
// sends (method, path, query, cookie, CSRF header, JSON body), the CSRF
// double-submit flow the writes are required to perform, the client-side
// filtering in get_alert_history, and how upstream failures are normalized.
//
// Run: node --test packages/alerts-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js snapshots env at import time, so pin the session and base BEFORE the
// dynamic imports below. Each node --test file runs in its own process, so this
// does not leak into registration.test.mjs (which asserts the no-session path).
process.env.THREE_WS_SESSION = 'test-session-cookie';
process.env.THREE_WS_BASE = 'https://three.test';
delete process.env.THREE_WS_TIMEOUT_MS;

const { def: listRules } = await import('../src/tools/list-alert-rules.js');
const { def: createRule } = await import('../src/tools/create-alert-rule.js');
const { def: updateRule } = await import('../src/tools/update-alert-rule.js');
const { def: deleteRule } = await import('../src/tools/delete-alert-rule.js');
const { def: getHistory } = await import('../src/tools/get-alert-history.js');
const { summarizeAlert } = await import('../src/lib/shapes.js');

const RULE_ID = '76bf0786-1a43-4815-99fe-33f4a142e562';
// $THREE is the only coin three.ws promotes; it is the fixture mint everywhere.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

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

// A responder that answers the CSRF fetch first, then the write itself.
function csrfThen(responder, token = 'csrf-token-1') {
	return (url, init) => {
		if (url.endsWith('/api/csrf-token')) return jsonResponse({ data: { token } });
		return responder(url, init);
	};
}

const ruleRow = (over = {}) => ({
	id: RULE_ID,
	kind: 'price_above',
	label: null,
	label_display: 'Mcap above $100000',
	target_mint: THREE_MINT,
	threshold: 100000,
	deliver_in_app: true,
	cooldown_seconds: 600,
	enabled: true,
	created_at: '2026-08-15T05:16:44.450Z',
	updated_at: '2026-08-15T05:16:44.450Z',
	...over,
});

// list_alert_rules

test('list_alert_rules GETs the rules endpoint with the session cookie and shapes each row', async (t) => {
	const calls = stubFetch(t, () =>
		jsonResponse({ rules: [ruleRow(), null, ruleRow({ id: 'second' })] }),
	);

	const result = await listRules.handler();

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://three.test/api/alerts/rules');
	assert.equal(calls[0].init.method, 'GET');
	assert.equal(calls[0].init.headers.cookie, '__Host-sid=test-session-cookie');
	assert.equal(calls[0].init.headers['x-csrf-token'], undefined);

	// The null row is dropped, and every survivor carries the full pinned shape.
	assert.equal(result.ok, true);
	assert.equal(result.count, 2);
	assert.equal(result.rules[0].target_mint, THREE_MINT);
	assert.equal(result.rules[0].webhook_secret, null);
	assert.equal(result.rules[0].recent_failures, 0);
	assert.deepEqual(result.rules[0].recent_deliveries, []);
});

test('list_alert_rules reports an honest empty list on a malformed upstream', async (t) => {
	stubFetch(t, () => jsonResponse({ ok: true }));
	assert.deepEqual(await listRules.handler(), { ok: true, count: 0, rules: [] });
});

// create_alert_rule

test('create_alert_rule fetches a CSRF token, then POSTs only the defined fields', async (t) => {
	const calls = stubFetch(
		t,
		csrfThen(() => jsonResponse({ rule: ruleRow() })),
	);

	const result = await createRule.handler({
		kind: 'price_above',
		target_mint: THREE_MINT,
		threshold: 100000,
		deliver_in_app: true,
		cooldown_seconds: 600,
		enabled: true,
	});

	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, 'https://three.test/api/csrf-token');
	assert.equal(calls[0].init.method, 'GET');

	const write = calls[1];
	assert.equal(write.url, 'https://three.test/api/alerts/rules');
	assert.equal(write.init.method, 'POST');
	assert.equal(write.init.headers['x-csrf-token'], 'csrf-token-1');
	assert.equal(write.init.headers.cookie, '__Host-sid=test-session-cookie');
	assert.equal(write.init.headers['content-type'], 'application/json');

	// Undefined optionals must not be serialized: the API rejects explicit nulls
	// on create, so an absent field has to stay absent on the wire.
	const body = JSON.parse(write.init.body);
	assert.deepEqual(Object.keys(body).sort(), [
		'cooldown_seconds',
		'deliver_in_app',
		'enabled',
		'kind',
		'target_mint',
		'threshold',
	]);
	assert.equal(result.rule.id, RULE_ID);
});

test('create_alert_rule surfaces an API validation failure with its status and body', async (t) => {
	stubFetch(
		t,
		csrfThen(() =>
			jsonResponse({ message: 'price_above requires target_mint' }, { status: 400 }),
		),
	);

	await assert.rejects(
		createRule.handler({ kind: 'price_above', threshold: 1 }),
		(err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 400);
			assert.equal(err.message, 'price_above requires target_mint');
			return true;
		},
	);
});

test('a write refuses to proceed when three.ws returns no CSRF token', async (t) => {
	const calls = stubFetch(t, (url) =>
		url.endsWith('/api/csrf-token') ? jsonResponse({ data: {} }) : jsonResponse({ rule: ruleRow() }),
	);

	await assert.rejects(createRule.handler({ kind: 'graduation' }), (err) => {
		assert.equal(err.code, 'csrf_unavailable');
		return true;
	});
	// The rule POST must never have been attempted without the token.
	assert.equal(calls.length, 1);
});

// update_alert_rule

test('update_alert_rule PATCHes the rule id and keeps explicit nulls as clears', async (t) => {
	const calls = stubFetch(
		t,
		csrfThen(() => jsonResponse({ rule: ruleRow({ enabled: false, threshold: 250000 }) })),
	);

	const result = await updateRule.handler({
		rule_id: RULE_ID,
		enabled: false,
		threshold: 250000,
		webhook_url: null,
		label: undefined,
	});

	const write = calls[1];
	assert.equal(write.url, `https://three.test/api/alerts/rules/${RULE_ID}`);
	assert.equal(write.init.method, 'PATCH');
	assert.equal(write.init.headers['x-csrf-token'], 'csrf-token-1');

	const body = JSON.parse(write.init.body);
	// rule_id addresses the resource and must not be echoed into the patch; a
	// null is a deliberate clear and must survive; an undefined is dropped.
	assert.equal('rule_id' in body, false);
	assert.equal('label' in body, false);
	assert.equal(body.webhook_url, null);
	assert.equal(body.enabled, false);
	assert.equal(body.threshold, 250000);

	assert.equal(result.rule.enabled, false);
	assert.equal(result.rule.threshold, 250000);
});

// delete_alert_rule

test('delete_alert_rule DELETEs the rule and echoes the id even when the API omits it', async (t) => {
	const calls = stubFetch(
		t,
		csrfThen(() => jsonResponse({ ok: true })),
	);

	const result = await deleteRule.handler({ rule_id: RULE_ID });

	assert.equal(calls[1].url, `https://three.test/api/alerts/rules/${RULE_ID}`);
	assert.equal(calls[1].init.method, 'DELETE');
	assert.equal(calls[1].init.body, undefined);
	assert.deepEqual(result, { ok: true, deleted: true, id: RULE_ID });
});

// get_alert_history

test('get_alert_history asks for exactly the requested page when it is not filtering', async (t) => {
	const calls = stubFetch(t, () => jsonResponse({ notifications: [], unread_count: 0 }));

	await getHistory.handler({ limit: 5 });

	const url = new URL(calls[0].url);
	assert.equal(url.pathname, '/api/notifications');
	assert.equal(url.searchParams.get('type'), 'pump_alert');
	assert.equal(url.searchParams.get('limit'), '5');
});

test('get_alert_history pulls the full page before filtering, then trims to limit', async (t) => {
	const alert = (over) => ({
		id: over.id,
		created_at: '2026-08-15T05:20:00.000Z',
		read_at: null,
		payload: { rule_id: RULE_ID, kind: 'whale_buy', mint: THREE_MINT, symbol: 'THREE', ...over.payload },
	});
	const calls = stubFetch(t, () =>
		jsonResponse({
			unread_count: 3,
			notifications: [
				alert({ id: 1, payload: {} }),
				alert({ id: 2, payload: { kind: 'graduation' } }),
				alert({ id: 3, payload: { rule_id: 'other-rule' } }),
				alert({ id: 4, payload: {} }),
			],
		}),
	);

	const result = await getHistory.handler({ limit: 1, rule_id: RULE_ID, kind: 'whale_buy' });

	// Filtering client-side must request the API maximum, not the caller's limit,
	// or the filter would run over a pre-truncated slice.
	assert.equal(new URL(calls[0].url).searchParams.get('limit'), '50');
	assert.equal(result.count, 1);
	assert.equal(result.alerts[0].id, 1);
	assert.equal(result.alerts[0].read, false);
	assert.equal(result.unread_count, 3);
});

test('get_alert_history marks a read alert and summarizes each kind the way the site does', async (t) => {
	stubFetch(t, () =>
		jsonResponse({
			notifications: [
				{
					id: 9,
					created_at: '2026-08-15T05:21:00.000Z',
					read_at: '2026-08-15T05:22:00.000Z',
					payload: { kind: 'graduation', symbol: 'THREE', market_cap_usd: 69420 },
				},
			],
		}),
	);

	const result = await getHistory.handler({ limit: 20 });
	assert.equal(result.alerts[0].read, true);
	assert.equal(result.alerts[0].summary, '$THREE graduated to AMM at $69,420 mcap');

	assert.equal(
		summarizeAlert({ kind: 'whale_buy', symbol: 'THREE', amount_sol: 12.5, amount_usd: 2310 }),
		'Whale bought 12.50 SOL ($2,310) of $THREE',
	);
	assert.equal(
		summarizeAlert({ kind: 'price_below', symbol: 'THREE', threshold_usd: 50000, market_cap_usd: 48000 }),
		'$THREE mcap fell below $50,000 (now $48,000)',
	);
	assert.equal(summarizeAlert({ kind: 'new_mint', mint: THREE_MINT }), 'FeMb…pump just launched');
	assert.equal(summarizeAlert({ kind: 'unknown_kind' }), 'token alert');
});
