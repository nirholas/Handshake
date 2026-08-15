// Core-path behaviour for @three-ws/alibaba-cloud-mcp, with fetch stubbed.
//
// dashscope.test.mjs covers config resolution; this suite covers what the
// package actually does at runtime: the exact DashScope requests the client
// sends, how it maps responses and upstream failures, what each tool handler
// returns, and that buildServer() registers all three tools with a usable
// (Zod) input schema. Every test replaces globalThis.fetch via node:test's mock
// tracker (restored automatically per-test), so no request leaves the process.
//
// Run: node --test packages/alibaba-cloud-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// loadConfig() reads process.env at call time, and buildServer() calls it, so a
// key has to be present before the server is built.
process.env.DASHSCOPE_API_KEY = 'sk-test-key';
delete process.env.DASHSCOPE_BASE_URL;
delete process.env.DASHSCOPE_REGION;
delete process.env.DASHSCOPE_MODEL_ID;
delete process.env.DASHSCOPE_EMBED_MODEL_ID;

const { DashScopeClient, DashScopeError, loadConfig, INTL_BASE_URL } = await import(
	'../src/dashscope.js'
);
const { buildTools } = await import('../src/tools.js');
const { buildServer } = await import('../src/index.js');

const client = () => new DashScopeClient(loadConfig());

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

const toolsByName = (c) => Object.fromEntries(buildTools(c).map((tool) => [tool.name, tool]));

// DashScopeClient: chat

test('chat POSTs the OpenAI-compatible completions endpoint with bearer auth', async (t) => {
	const calls = stubFetch(t, () =>
		jsonResponse({
			model: 'qwen-plus',
			choices: [{ message: { content: 'hello back' }, finish_reason: 'stop' }],
			usage: { total_tokens: 12 },
		}),
	);

	const result = await client().chat([{ role: 'user', content: 'hello' }]);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `${INTL_BASE_URL}/chat/completions`);
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test-key');
	assert.equal(calls[0].init.headers['content-type'], 'application/json');

	const body = JSON.parse(calls[0].init.body);
	assert.equal(body.model, 'qwen-plus');
	assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
	// Sampling knobs the caller did not set must not be sent at all, so the
	// account's own model defaults apply.
	assert.equal('temperature' in body, false);
	assert.equal('top_p' in body, false);

	assert.deepEqual(result, {
		text: 'hello back',
		finishReason: 'stop',
		usage: { total_tokens: 12 },
		model: 'qwen-plus',
	});
});

test('chat forwards an overridden model and the sampling parameters', async (t) => {
	const calls = stubFetch(t, () => jsonResponse({ choices: [] }));

	const result = await client().chat([{ role: 'user', content: 'hi' }], {
		model: 'qwen-max',
		maxTokens: 256,
		temperature: 0,
		topP: 0.8,
	});

	const body = JSON.parse(calls[0].init.body);
	assert.equal(body.model, 'qwen-max');
	assert.equal(body.max_tokens, 256);
	assert.equal(body.temperature, 0);
	assert.equal(body.top_p, 0.8);
	// An empty choices array is a real upstream shape, not a crash.
	assert.equal(result.text, '');
	assert.equal(result.model, 'qwen-max');
});

// DashScopeClient: embeddings

test('embed sends float encoding, wraps a single string, and orders vectors by index', async (t) => {
	const calls = stubFetch(t, () =>
		jsonResponse({
			model: 'text-embedding-v3',
			data: [
				{ index: 1, embedding: [0.3, 0.4] },
				{ index: 0, embedding: [0.1, 0.2] },
			],
			usage: { total_tokens: 4 },
		}),
	);

	const result = await client().embed(['a', 'b'], { dimensions: 512 });

	assert.equal(calls[0].url, `${INTL_BASE_URL}/embeddings`);
	const body = JSON.parse(calls[0].init.body);
	assert.deepEqual(body.input, ['a', 'b']);
	assert.equal(body.encoding_format, 'float');
	assert.equal(body.dimensions, 512);

	// DashScope may return embeddings out of order; callers index by input.
	assert.deepEqual(result.vectors, [[0.1, 0.2], [0.3, 0.4]]);
	assert.equal(result.inputCount, 2);
	assert.equal(result.dimensions, 2);
	assert.equal(result.model, 'text-embedding-v3');
});

test('embed omits dimensions when unset and accepts a bare string', async (t) => {
	const calls = stubFetch(t, () => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));

	await client().embed('one string');

	const body = JSON.parse(calls[0].init.body);
	assert.deepEqual(body.input, ['one string']);
	assert.equal('dimensions' in body, false);
});

// DashScopeClient: model discovery

test('listModels GETs /models and projects the fields the tool advertises', async (t) => {
	const calls = stubFetch(t, () =>
		jsonResponse({
			data: [{ id: 'qwen-max', object: 'model', owned_by: 'system', created: 1, extra: 'dropped' }],
		}),
	);

	const models = await client().listModels();

	assert.equal(calls[0].url, `${INTL_BASE_URL}/models`);
	assert.equal(calls[0].init.method, 'GET');
	assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test-key');
	assert.deepEqual(models, [{ id: 'qwen-max', object: 'model', owned_by: 'system', created: 1 }]);
});

// Failure mapping

test('an upstream error becomes a DashScopeError carrying status and code', async (t) => {
	stubFetch(t, () =>
		jsonResponse(
			{ error: { message: 'Invalid API-key provided.', code: 'InvalidApiKey', type: 'auth' } },
			{ status: 401 },
		),
	);

	await assert.rejects(client().listModels(), (err) => {
		assert.ok(err instanceof DashScopeError);
		assert.equal(err.status, 401);
		assert.equal(err.detail, 'InvalidApiKey');
		assert.match(err.message, /DashScope error \(401\): Invalid API-key provided\./);
		return true;
	});
});

test('a non-JSON error body still produces a coded error, not a parse crash', async (t) => {
	stubFetch(t, () => ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' }));

	await assert.rejects(client().listModels(), (err) => {
		assert.ok(err instanceof DashScopeError);
		assert.equal(err.status, 502);
		assert.match(err.message, /bad gateway/);
		return true;
	});
});

test('an aborted request maps to a timeout DashScopeError', async (t) => {
	stubFetch(t, () => {
		throw Object.assign(new Error('aborted'), { name: 'AbortError' });
	});

	await assert.rejects(client().chat([{ role: 'user', content: 'hi' }]), (err) => {
		assert.ok(err instanceof DashScopeError);
		assert.match(err.message, /timed out after 60000ms/);
		return true;
	});
});

// Tool handlers

test('qwen_chat returns the reply as the summary and the full result as structured content', async (t) => {
	stubFetch(t, () =>
		jsonResponse({
			model: 'qwen-plus',
			choices: [{ message: { content: 'four' }, finish_reason: 'stop' }],
			usage: { total_tokens: 3 },
		}),
	);

	const result = await toolsByName(client()).qwen_chat.handler({
		messages: [{ role: 'user', content: '2+2?' }],
	});

	assert.equal(result.content[0].type, 'text');
	assert.match(result.content[0].text, /^four\n\n\{/);
	assert.equal(result.structuredContent.text, 'four');
	assert.equal(result.structuredContent.usage.total_tokens, 3);
});

test('qwen_embed accepts one string or many and reports what it embedded', async (t) => {
	stubFetch(t, () =>
		jsonResponse({
			model: 'text-embedding-v3',
			data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
		}),
	);

	const result = await toolsByName(client()).qwen_embed.handler({ inputs: 'one string' });

	assert.equal(result.structuredContent.inputCount, 1);
	assert.equal(result.structuredContent.dimensions, 3);
	assert.match(result.content[0].text, /Embedded 1 string\(s\) with text-embedding-v3/);
});

test('qwen_list_models counts what the account exposes', async (t) => {
	stubFetch(t, () => jsonResponse({ data: [{ id: 'qwen-plus' }, { id: 'qwen-turbo' }] }));

	const result = await toolsByName(client()).qwen_list_models.handler({});

	assert.equal(result.structuredContent.count, 2);
	assert.deepEqual(
		result.structuredContent.models.map((m) => m.id),
		['qwen-plus', 'qwen-turbo'],
	);
	assert.match(result.content[0].text, /^2 models available/);
});

// Registration

test('buildServer registers all three tools with their annotations and a usable schema', () => {
	const tools = buildTools(client());
	assert.deepEqual(
		tools.map((tool) => tool.name),
		['qwen_chat', 'qwen_embed', 'qwen_list_models'],
	);

	const registered = buildServer()._registeredTools;
	assert.ok(registered, 'McpServer should expose its tool registry');
	for (const tool of tools) {
		const entry = registered[tool.name];
		assert.ok(entry, `${tool.name} not registered on the server`);
		assert.equal(entry.title, tool.title);
		assert.deepEqual(entry.annotations, tool.annotations);
		// The SDK only keeps an inputSchema it recognized as a Zod shape; a raw
		// JSON Schema object is rejected at registration, which is how this
		// server shipped unable to start.
		assert.ok(entry.inputSchema, `${tool.name} must register a Zod input schema`);
		assert.equal(typeof entry.handler, 'function');
	}
});

test('the registered qwen_chat schema rejects an empty message list', () => {
	const entry = buildServer()._registeredTools.qwen_chat;
	assert.equal(entry.inputSchema.safeParse({ messages: [] }).success, false);
	assert.equal(
		entry.inputSchema.safeParse({ messages: [{ role: 'user', content: 'hi' }] }).success,
		true,
	);
});
