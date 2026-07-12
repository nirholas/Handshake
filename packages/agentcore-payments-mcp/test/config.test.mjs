// Config and env-handling invariants for @three-ws/agentcore-payments-mcp.
//
// config.js snapshots env at import time, so this file pins its env BEFORE the
// first dynamic import and uses query-busted imports where a second, fresh
// module instance is needed. Runs offline.
//
// Run: node --test packages/agentcore-payments-mcp/test/config.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the env this process's canonical config instance will snapshot.
process.env.THREE_WS_BASE = 'https://cfg.test///';
process.env.PAYMENT_SESSION_TOKEN = 'pss_from_env';
delete process.env.THREE_WS_SESSION;
delete process.env.THREE_WS_TIMEOUT_MS;

const config = await import('../src/config.js');
const { def: payWithSession } = await import('../src/tools/pay-with-session.js');

// ── env() helper ─────────────────────────────────────────────────────────────

test('env() trims values and falls back on unset, empty and whitespace-only vars', (t) => {
	process.env.ACP_TEST_VAR = '  padded-value  ';
	t.after(() => { delete process.env.ACP_TEST_VAR; });
	assert.equal(config.env('ACP_TEST_VAR', 'fb'), 'padded-value');

	process.env.ACP_TEST_VAR = '';
	assert.equal(config.env('ACP_TEST_VAR', 'fb'), 'fb', 'empty string means fallback');

	process.env.ACP_TEST_VAR = '   ';
	assert.equal(config.env('ACP_TEST_VAR', 'fb'), 'fb', 'whitespace-only means fallback');

	delete process.env.ACP_TEST_VAR;
	assert.equal(config.env('ACP_TEST_VAR', 'fb'), 'fb', 'unset means fallback');
	assert.equal(config.env('ACP_TEST_VAR'), undefined, 'no fallback means undefined');
});

// ── derived constants ────────────────────────────────────────────────────────

test('THREE_WS_BASE strips trailing slashes so URL joins cannot double-slash', () => {
	assert.equal(config.THREE_WS_BASE, 'https://cfg.test');
});

test('HTTP_TIMEOUT_MS defaults to 30s and honours a valid override', async () => {
	assert.equal(config.HTTP_TIMEOUT_MS, 30000);

	process.env.THREE_WS_TIMEOUT_MS = '5000';
	try {
		const fresh = await import('../src/config.js?custom-timeout');
		assert.equal(fresh.HTTP_TIMEOUT_MS, 5000);
	} finally {
		delete process.env.THREE_WS_TIMEOUT_MS;
	}
});

test('a malformed THREE_WS_TIMEOUT_MS fails fast with code bad_config', async () => {
	for (const bad of ['banana', '-5', '0']) {
		process.env.THREE_WS_TIMEOUT_MS = bad;
		try {
			await assert.rejects(
				import(`../src/config.js?bad-timeout-${encodeURIComponent(bad)}`),
				(err) => err.code === 'bad_config',
				`"${bad}" must be rejected at load time`,
			);
		} finally {
			delete process.env.THREE_WS_TIMEOUT_MS;
		}
	}
});

// ── PAYMENT_SESSION_TOKEN env fallback ───────────────────────────────────────

test('pay_with_session falls back to the PAYMENT_SESSION_TOKEN env var', async (t) => {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, init) => {
		calls.push({ url: String(url), init });
		return { ok: true, status: 200, text: async () => JSON.stringify({ paid: false, result: {} }) };
	});

	await payWithSession.handler({ url: 'https://api.example.com/paid' });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://cfg.test/api/pay/execute');
	assert.equal(JSON.parse(calls[0].init.body).session_token, 'pss_from_env');
});
