// Handler behavior for @three-ws/tutor-mcp: request shaping against the tutor
// session ledger, the shape each tool returns to the MCP client, and how an
// upstream failure is normalized. Global fetch is replaced for every test, so
// nothing here touches the network.
//
// Env is pinned BEFORE the dynamic imports because src/config.js reads
// process.env at module load.
//
// Run: node --test packages/tutor-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THREE_WS_BASE = 'https://tutor.test';
delete process.env.THREE_WS_TIMEOUT_MS;

const { def: loadSession } = await import('../src/tools/load-session.js');
const { def: closeSession } = await import('../src/tools/close-session.js');
const { buildServer } = await import('../src/index.js');

const SESSION_ID = 'learn-abc123';

// Swap globalThis.fetch for the duration of fn, always restoring it.
async function withFetch(stub, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = stub;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

// Answer every fetch with `body`, recording each invocation for assertions.
function recordingFetch(body, log, status = 200) {
	return async (url, init) => {
		log.push({ url: String(url), init });
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		});
	};
}

// One billed question, exactly as /api/tutor/session itemizes it.
function lineItem(n) {
	return {
		n,
		question: `Question ${n}?`,
		level: 'intro',
		outputTokens: 180,
		costAtomics: 10000,
		costUsd: '0.010000',
		at: '2026-06-24T03:41:00.000Z',
	};
}

function openSession(overrides = {}) {
	return {
		sessionId: SESSION_ID,
		createdAt: '2026-06-24T03:40:00.000Z',
		status: 'open',
		questionCount: 2,
		lineItems: [lineItem(1), lineItem(2)],
		totalAtomics: 20000,
		totalUsd: '0.020000',
		...overrides,
	};
}

test('load_session GETs the ledger with the sessionId in the query', async () => {
	const log = [];
	const result = await withFetch(recordingFetch(openSession(), log), () =>
		loadSession.handler({ sessionId: SESSION_ID }),
	);

	assert.equal(log.length, 1);
	const url = new URL(log[0].url);
	assert.equal(url.origin, 'https://tutor.test');
	assert.equal(url.pathname, '/api/tutor/session');
	assert.equal(url.searchParams.get('sessionId'), SESSION_ID);
	assert.equal(log[0].init.method, 'GET');

	assert.equal(result.ok, true);
	assert.equal(result.status, 'open');
	assert.equal(result.questionCount, 2);
	assert.equal(result.lineItems.length, 2);
	assert.equal(result.totalAtomics, 20000);
	assert.equal(result.totalUsd, '0.020000');
	assert.equal('invoice' in result, false, 'an open session carries no invoice');
});

test('load_session trims and truncates the sessionId to the API cap', async () => {
	const log = [];
	const long = ` ${'x'.repeat(140)} `;
	await withFetch(recordingFetch(openSession(), log), () => loadSession.handler({ sessionId: long }));

	const sent = new URL(log[0].url).searchParams.get('sessionId');
	assert.equal(sent.length, 100, 'sessionId is capped at 100 chars');
	assert.equal(sent, 'x'.repeat(100));
});

test('load_session surfaces a closed session with its finalized invoice', async () => {
	const invoice = { sessionId: SESSION_ID, attestation: 'sha256:abc', totalAtomics: 20000 };
	const result = await withFetch(recordingFetch(openSession({ status: 'closed', invoice }), []), () =>
		loadSession.handler({ sessionId: SESSION_ID }),
	);

	assert.equal(result.status, 'closed');
	assert.deepEqual(result.invoice, invoice);
});

test('load_session reports an unbilled session as an empty open tab, not an error', async () => {
	// The API answers an unknown sessionId with a fresh empty session; the tool
	// must pass that through as "nothing billed yet" rather than inventing data.
	const empty = { sessionId: 'brand-new', createdAt: '2026-06-24T03:40:00.000Z', status: 'open', questionCount: 0, lineItems: [], totalAtomics: 0, totalUsd: '0.000000' };
	const result = await withFetch(recordingFetch(empty, []), () => loadSession.handler({ sessionId: 'brand-new' }));

	assert.equal(result.ok, true);
	assert.equal(result.questionCount, 0);
	assert.deepEqual(result.lineItems, []);
	assert.equal(result.totalUsd, '0.000000');
});

test('close_session POSTs the end action and returns the attested invoice', async () => {
	const log = [];
	const invoice = {
		sessionId: SESSION_ID,
		createdAt: '2026-06-24T03:40:00.000Z',
		closedAt: '2026-06-24T03:45:00.000Z',
		questionCount: 2,
		lineItems: [lineItem(1), lineItem(2)],
		totalAtomics: 20000,
		totalUsd: '0.020000',
		attestation: 'sha256:9f2c',
	};
	const result = await withFetch(recordingFetch(invoice, log), () =>
		closeSession.handler({ sessionId: SESSION_ID }),
	);

	assert.equal(log.length, 1);
	assert.equal(new URL(log[0].url).pathname, '/api/tutor/session');
	assert.equal(log[0].init.method, 'POST');
	assert.deepEqual(JSON.parse(log[0].init.body), { sessionId: SESSION_ID, action: 'end' });
	assert.equal(log[0].init.headers['content-type'], 'application/json');

	assert.equal(result.ok, true);
	assert.equal(result.closedAt, '2026-06-24T03:45:00.000Z');
	assert.equal(result.attestation, 'sha256:9f2c');
	assert.equal(result.lineItems.length, 2);
});

test('close_session fills honest zeros when the API omits ledger fields', async () => {
	const result = await withFetch(recordingFetch({ sessionId: SESSION_ID }, []), () =>
		closeSession.handler({ sessionId: SESSION_ID }),
	);

	assert.equal(result.questionCount, 0);
	assert.deepEqual(result.lineItems, []);
	assert.equal(result.totalAtomics, 0);
	assert.equal(result.totalUsd, '0.000000');
	assert.equal(result.attestation, null, 'a missing attestation is null, never fabricated');
});

test('an upstream error becomes a typed error carrying the HTTP status', async () => {
	const failing = recordingFetch({ error: 'missing_session', message: 'sessionId is required' }, [], 400);
	await withFetch(failing, () =>
		assert.rejects(() => closeSession.handler({ sessionId: 'x' }), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 400);
			assert.match(err.message, /sessionId is required/);
			return true;
		}),
	);
});

test('the server wrapper renders a handler failure as an isError content block', async () => {
	const server = buildServer();
	const registered = server._registeredTools.load_session;
	const failing = recordingFetch({ error: 'upstream', message: 'ledger unavailable' }, [], 503);

	const result = await withFetch(failing, () => registered.handler({ sessionId: SESSION_ID }, {}));

	assert.equal(result.isError, true);
	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.ok, false);
	assert.equal(payload.error, 'upstream_error');
	assert.equal(payload.status, 503);
});

test('the server wrapper renders a successful handler result as JSON text', async () => {
	const server = buildServer();
	const registered = server._registeredTools.load_session;

	const result = await withFetch(recordingFetch(openSession(), []), () =>
		registered.handler({ sessionId: SESSION_ID }, {}),
	);

	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].type, 'text');
	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.sessionId, SESSION_ID);
	assert.equal(payload.questionCount, 2);
});
