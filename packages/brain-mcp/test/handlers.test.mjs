// Handler behavior for @three-ws/brain-mcp: request building, SSE stream
// parsing, response shaping, and error normalization. Global fetch is stubbed
// for every test — nothing here touches the network.
//
// Env is pinned BEFORE the dynamic imports because src/config.js reads
// process.env at module load.
//
// Run: node --test packages/brain-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THREE_WS_BASE = 'https://brain.test';
process.env.THREE_WS_API_KEY = 'sk_test_brain_mcp';
delete process.env.THREE_WS_TIMEOUT_MS;

const { def: chat } = await import('../src/tools/chat.js');
const { def: listProviders } = await import('../src/tools/list-providers.js');
const { apiRequest } = await import('../src/lib/api.js');
const { env } = await import('../src/config.js');
const { buildServer } = await import('../src/index.js');

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

// Record a single fetch invocation and answer with the given Response.
function recordingFetch(response, log) {
	return async (url, init) => {
		log.push({ url: String(url), init });
		return typeof response === 'function' ? response() : response;
	};
}

function sseResponse(text) {
	return new Response(text, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}

const FULL_STREAM = [
	'event: meta\ndata: {"provider":"claude-sonnet-4-6","label":"Claude Sonnet 4.6","network":"Anthropic","tier":"flagship"}',
	'event: first\ndata: {"firstTokenMs":180}',
	'data: "Hello"',
	'data: ", world"',
	'event: fallback\ndata: {"route":"openrouter-mirror"}',
	'event: done\ndata: {"elapsedMs":950,"firstTokenMs":180,"usage":{"inputTokens":12,"outputTokens":7,"totalTokens":19}}',
	'data: [DONE]',
].join('\n\n') + '\n\n';

// ── chat: request building ────────────────────────────────────────────────

test('chat POSTs to /api/brain/chat with the default provider, auth, and SSE accept', async () => {
	const log = [];
	await withFetch(recordingFetch(() => sseResponse(FULL_STREAM), log), () =>
		chat.handler({ messages: [{ role: 'user', content: 'hi' }] }),
	);
	assert.equal(log.length, 1);
	assert.equal(log[0].url, 'https://brain.test/api/brain/chat');
	assert.equal(log[0].init.method, 'POST');
	assert.equal(log[0].init.headers.accept, 'text/event-stream');
	assert.equal(log[0].init.headers['content-type'], 'application/json');
	assert.equal(log[0].init.headers.authorization, 'Bearer sk_test_brain_mcp');
	const body = JSON.parse(log[0].init.body);
	assert.equal(body.provider, 'gpt-oss-120b', 'defaults to the free open-weight tier');
	assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
	assert.ok(!('system' in body), 'no system key when none was given');
	assert.ok(!('maxTokens' in body), 'no maxTokens key when none was given');
});

test('chat coerces roles and content: anything but assistant becomes user, content stringified', async () => {
	const log = [];
	await withFetch(recordingFetch(() => sseResponse(FULL_STREAM), log), () =>
		chat.handler({
			messages: [
				{ role: 'assistant', content: 'earlier reply' },
				{ role: 'system', content: 'sneaky' },
				{ content: 42 },
			],
		}),
	);
	const body = JSON.parse(log[0].init.body);
	assert.deepEqual(body.messages, [
		{ role: 'assistant', content: 'earlier reply' },
		{ role: 'user', content: 'sneaky' },
		{ role: 'user', content: '42' },
	]);
});

test('chat forwards provider, trims-in system only when non-blank, and truncates maxTokens', async () => {
	const log = [];
	await withFetch(recordingFetch(() => sseResponse(FULL_STREAM), log), () =>
		chat.handler({
			messages: [{ role: 'user', content: 'q' }],
			provider: '  claude-sonnet-4-6  ',
			system: 'Be terse.',
			maxTokens: 512.9,
		}),
	);
	const body = JSON.parse(log[0].init.body);
	assert.equal(body.provider, 'claude-sonnet-4-6');
	assert.equal(body.system, 'Be terse.');
	assert.equal(body.maxTokens, 512, 'fractional maxTokens is truncated to an integer');

	const log2 = [];
	await withFetch(recordingFetch(() => sseResponse(FULL_STREAM), log2), () =>
		chat.handler({ messages: [{ role: 'user', content: 'q' }], system: '   ', maxTokens: NaN }),
	);
	const body2 = JSON.parse(log2[0].init.body);
	assert.ok(!('system' in body2), 'blank system is dropped');
	assert.ok(!('maxTokens' in body2), 'non-finite maxTokens is dropped');
});

// ── chat: SSE parsing + response shaping ──────────────────────────────────

test('chat accumulates text chunks and shapes meta, route, usage, and timing', async () => {
	const out = await withFetch(recordingFetch(() => sseResponse(FULL_STREAM), []), () =>
		chat.handler({ messages: [{ role: 'user', content: 'hi' }], provider: 'claude-sonnet-4-6' }),
	);
	assert.equal(out.ok, true);
	assert.equal(out.content, 'Hello, world');
	assert.equal(out.provider, 'claude-sonnet-4-6');
	assert.equal(out.model, 'Claude Sonnet 4.6');
	assert.equal(out.network, 'Anthropic');
	assert.equal(out.tier, 'flagship');
	assert.equal(out.routed_via, 'openrouter-mirror');
	assert.deepEqual(out.usage, { input_tokens: 12, output_tokens: 7, total_tokens: 19 });
	assert.deepEqual(out.timing_ms, { first_token: 180, total: 950 });
});

test('chat parses SSE blocks split across arbitrary read boundaries', async () => {
	// Split the stream mid-line and mid-block to prove the buffered parser
	// reassembles events regardless of chunking.
	const pieces = [];
	for (let i = 0; i < FULL_STREAM.length; i += 7) pieces.push(FULL_STREAM.slice(i, i + 7));
	const body = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			for (const p of pieces) controller.enqueue(encoder.encode(p));
			controller.close();
		},
	});
	const res = new Response(body, { status: 200 });
	const out = await withFetch(async () => res, () =>
		chat.handler({ messages: [{ role: 'user', content: 'hi' }] }),
	);
	assert.equal(out.content, 'Hello, world');
	assert.equal(out.routed_via, 'openrouter-mirror');
	assert.deepEqual(out.timing_ms, { first_token: 180, total: 950 });
});

test('chat ignores non-JSON data lines and [DONE] without corrupting the transcript', async () => {
	const stream =
		'data: "ok"\n\n' + 'data: this is not json\n\n' + 'data: 123\n\n' + 'data: [DONE]\n\n';
	const out = await withFetch(async () => sseResponse(stream), () =>
		chat.handler({ messages: [{ role: 'user', content: 'hi' }] }),
	);
	// Only JSON-encoded *strings* count as text chunks.
	assert.equal(out.content, 'ok');
	assert.equal(out.usage, null, 'no done event → usage is null');
	assert.deepEqual(out.timing_ms, { first_token: null, total: null });
});

test('chat surfaces a stream error event as upstream_error when nothing streamed', async () => {
	const stream = 'event: error\ndata: {"message":"model exploded","elapsedMs":10}\n\n';
	await withFetch(async () => sseResponse(stream), () =>
		assert.rejects(chat.handler({ messages: [{ role: 'user', content: 'hi' }] }), (err) => {
			assert.equal(err.message, 'model exploded');
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 502);
			return true;
		}),
	);
});

test('chat keeps partial output when an error event arrives after tokens streamed', async () => {
	const stream = 'data: "partial answer"\n\n' + 'event: error\ndata: {"message":"cut off"}\n\n';
	const out = await withFetch(async () => sseResponse(stream), () =>
		chat.handler({ messages: [{ role: 'user', content: 'hi' }] }),
	);
	assert.equal(out.ok, true);
	assert.equal(out.content, 'partial answer');
});

// ── chat: pre-stream rejections ───────────────────────────────────────────

test('chat normalizes a pre-stream 4xx JSON rejection into upstream_error', async () => {
	const res = new Response(JSON.stringify({ error: 'unknown_provider', error_description: 'no such model' }), {
		status: 400,
		headers: { 'content-type': 'application/json' },
	});
	await withFetch(async () => res, () =>
		assert.rejects(chat.handler({ messages: [{ role: 'user', content: 'hi' }] }), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 400);
			assert.equal(err.message, 'no such model', 'error_description wins');
			assert.deepEqual(err.body, { error: 'unknown_provider', error_description: 'no such model' });
			return true;
		}),
	);
});

test('chat falls back to a generic HTTP message when the error body is not JSON', async () => {
	const res = new Response('<html>Bad Gateway</html>', { status: 502 });
	await withFetch(async () => res, () =>
		assert.rejects(chat.handler({ messages: [{ role: 'user', content: 'hi' }] }), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 502);
			assert.match(err.message, /returned HTTP 502/);
			return true;
		}),
	);
});

test('chat maps a transport failure to network_error', async () => {
	await withFetch(
		async () => {
			throw new TypeError('fetch failed');
		},
		() =>
			assert.rejects(chat.handler({ messages: [{ role: 'user', content: 'hi' }] }), (err) => {
				assert.equal(err.code, 'network_error');
				assert.match(err.message, /request failed/);
				return true;
			}),
	);
});

// ── list_providers ────────────────────────────────────────────────────────

test('list_providers GETs /api/brain/chat and resolves requiresAuth per provider key', async () => {
	const providers = [
		{ key: 'gpt-oss-120b', label: 'GPT-OSS 120B', network: 'OpenRouter', tier: 'balanced', maxOutput: 8192, description: 'free', available: 1 },
		{ key: 'nvidia-nemotron-nano', label: 'Nemotron Nano', network: 'NVIDIA NIM', tier: 'fast', maxOutput: 4096, description: 'free', available: true },
		{ key: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', network: 'Anthropic', tier: 'flagship', maxOutput: 16384, description: 'paid', available: false },
	];
	const log = [];
	const res = new Response(JSON.stringify({ providers }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
	const out = await withFetch(recordingFetch(res, log), () => listProviders.handler());

	assert.equal(log[0].url, 'https://brain.test/api/brain/chat');
	assert.equal(log[0].init.method, 'GET');
	assert.equal(log[0].init.headers.authorization, 'Bearer sk_test_brain_mcp');

	assert.equal(out.ok, true);
	assert.equal(out.count, 3);
	assert.equal(out.available, 2, 'available flags are coerced to booleans and counted');
	assert.equal(out.default_provider, 'gpt-oss-120b');

	const byKey = Object.fromEntries(out.providers.map((p) => [p.key, p]));
	assert.equal(byKey['gpt-oss-120b'].requiresAuth, false, 'free open-weight tier');
	assert.equal(byKey['nvidia-nemotron-nano'].requiresAuth, false, 'NVIDIA NIM free tier');
	assert.equal(byKey['claude-sonnet-4-6'].requiresAuth, true, 'paid flagship needs a key');
	assert.equal(byKey['gpt-oss-120b'].available, true, 'truthy available becomes boolean true');
	assert.equal(byKey['claude-sonnet-4-6'].available, false);
	assert.equal(byKey['claude-sonnet-4-6'].maxOutput, 16384);
});

test('list_providers tolerates a response without a providers array', async () => {
	const res = new Response(JSON.stringify({ ok: true }), { status: 200 });
	const out = await withFetch(async () => res, () => listProviders.handler());
	assert.deepEqual(out, {
		ok: true,
		count: 0,
		available: 0,
		default_provider: 'gpt-oss-120b',
		providers: [],
	});
});

test('list_providers propagates upstream failures from apiRequest', async () => {
	const res = new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 });
	await withFetch(async () => res, () =>
		assert.rejects(listProviders.handler(), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 429);
			assert.equal(err.message, 'rate limited');
			return true;
		}),
	);
});

// ── apiRequest + config plumbing ──────────────────────────────────────────

test('apiRequest builds query strings, skipping undefined/null/empty values', async () => {
	const log = [];
	const res = new Response('{}', { status: 200 });
	await withFetch(recordingFetch(res, log), () =>
		apiRequest('/api/brain/chat', {
			query: { a: 1, b: 'two', skipUndef: undefined, skipNull: null, skipEmpty: '', zero: 0 },
		}),
	);
	const url = new URL(log[0].url);
	assert.equal(url.pathname, '/api/brain/chat');
	assert.equal(url.searchParams.get('a'), '1');
	assert.equal(url.searchParams.get('b'), 'two');
	assert.equal(url.searchParams.get('zero'), '0', 'zero is a real value, not an empty one');
	assert.equal(url.searchParams.has('skipUndef'), false);
	assert.equal(url.searchParams.has('skipNull'), false);
	assert.equal(url.searchParams.has('skipEmpty'), false);
});

test('apiRequest returns { raw } for a 200 response that is not JSON', async () => {
	const res = new Response('plain text', { status: 200 });
	const out = await withFetch(async () => res, () => apiRequest('/api/brain/chat'));
	assert.deepEqual(out, { raw: 'plain text' });
});

test('env() trims values and falls back on unset or blank variables', () => {
	process.env.__BRAIN_TEST_VAR = '  padded  ';
	assert.equal(env('__BRAIN_TEST_VAR', 'fb'), 'padded');
	process.env.__BRAIN_TEST_VAR = '   ';
	assert.equal(env('__BRAIN_TEST_VAR', 'fb'), 'fb', 'blank counts as unset');
	delete process.env.__BRAIN_TEST_VAR;
	assert.equal(env('__BRAIN_TEST_VAR', 'fb'), 'fb');
});

test('the registered MCP callback converts handler throws into an isError payload', async () => {
	const server = buildServer();
	const entry = server._registeredTools.list_providers;
	assert.ok(entry, 'list_providers must be registered');
	const result = await withFetch(
		async () => {
			throw new TypeError('fetch failed');
		},
		() => entry.handler({}, {}),
	);
	assert.equal(result.isError, true);
	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.ok, false);
	assert.equal(payload.error, 'network_error');
	assert.match(payload.message, /request failed/);
});
