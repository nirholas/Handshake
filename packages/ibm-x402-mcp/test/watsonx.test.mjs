// WatsonxClient behavior: config loading, IAM token minting + caching, the
// request each inference method builds, response shaping, and upstream error
// normalization. Global fetch is stubbed for every test — nothing here touches
// IBM Cloud or the network.
//
// Run: node --test packages/ibm-x402-mcp/test/watsonx.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, WatsonxClient, WatsonxError } from '../src/watsonx.js';

const BASE_ENV = {
	WATSONX_API_KEY: 'test-api-key',
	WATSONX_PROJECT_ID: 'proj-123',
};

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

// A fetch stub that answers the IAM token mint, records every other request,
// and replies from a URL-substring → body map.
function watsonxFetch(routes, log = []) {
	return async (url, init) => {
		const u = String(url);
		log.push({ url: u, init });
		if (u.includes('iam.cloud.ibm.com') || u.includes('/identity/token')) {
			return new Response(JSON.stringify({ access_token: 'iam-token-1', expires_in: 3600 }), {
				status: 200,
			});
		}
		for (const [needle, body] of Object.entries(routes)) {
			if (u.includes(needle)) {
				return typeof body === 'function' ? body() : new Response(JSON.stringify(body), { status: 200 });
			}
		}
		throw new Error(`unrouted request: ${u}`);
	};
}

// ── loadConfig ────────────────────────────────────────────────────────────

test('loadConfig fails fast and actionably without WATSONX_API_KEY', () => {
	assert.throws(() => loadConfig({}), (err) => {
		assert.ok(err instanceof WatsonxError);
		assert.match(err.message, /WATSONX_API_KEY/);
		return true;
	});
});

test('loadConfig requires a project or space id', () => {
	assert.throws(() => loadConfig({ WATSONX_API_KEY: 'k' }), (err) => {
		assert.ok(err instanceof WatsonxError);
		assert.match(err.message, /WATSONX_PROJECT_ID/);
		return true;
	});
	// A space id alone satisfies the scope requirement.
	const cfg = loadConfig({ WATSONX_API_KEY: 'k', WATSONX_SPACE_ID: 'space-9' });
	assert.equal(cfg.spaceId, 'space-9');
	assert.equal(cfg.projectId, undefined);
});

test('loadConfig applies documented defaults and trims a trailing URL slash', () => {
	const cfg = loadConfig({ ...BASE_ENV, WATSONX_URL: 'https://eu-de.ml.cloud.ibm.com/' });
	assert.equal(cfg.url, 'https://eu-de.ml.cloud.ibm.com');
	assert.equal(cfg.apiVersion, '2024-05-31');
	assert.equal(cfg.tsApiVersion, '2025-02-11');
	assert.equal(cfg.chatModel, 'ibm/granite-3-8b-instruct');
	assert.equal(cfg.embedModel, 'ibm/granite-embedding-278m-multilingual');
	assert.equal(cfg.forecastModel, 'ibm/granite-ttm-512-96-r2');
	assert.equal(cfg.timeoutMs, 90_000);
});

test('loadConfig honors overrides and falls back on a non-numeric timeout', () => {
	const cfg = loadConfig({
		...BASE_ENV,
		WATSONX_MODEL_ID: 'ibm/granite-3-2b-instruct',
		WATSONX_TIMEOUT_MS: 'not-a-number',
	});
	assert.equal(cfg.chatModel, 'ibm/granite-3-2b-instruct');
	assert.equal(cfg.timeoutMs, 90_000, 'NaN timeout falls back to the default');
	assert.equal(loadConfig({ ...BASE_ENV, WATSONX_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
});

// ── IAM token ─────────────────────────────────────────────────────────────

test('the IAM mint is form-encoded, and the token is cached across calls', async () => {
	const log = [];
	const fetchStub = watsonxFetch(
		{ '/ml/v1/text/chat': { choices: [{ message: { content: 'hi' } }] } },
		log,
	);
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	await withFetch(fetchStub, async () => {
		await client.chat([{ role: 'user', content: 'a' }]);
		await client.chat([{ role: 'user', content: 'b' }]);
	});

	const iamCalls = log.filter((c) => c.url.includes('/identity/token'));
	assert.equal(iamCalls.length, 1, 'second call must reuse the cached token');
	const iam = iamCalls[0];
	assert.equal(iam.init.method, 'POST');
	assert.equal(iam.init.headers['content-type'], 'application/x-www-form-urlencoded');
	const params = new URLSearchParams(String(iam.init.body));
	assert.equal(params.get('grant_type'), 'urn:ibm:params:oauth:grant-type:apikey');
	assert.equal(params.get('apikey'), 'test-api-key');

	const chatCalls = log.filter((c) => c.url.includes('/ml/v1/text/chat'));
	assert.equal(chatCalls.length, 2);
	for (const call of chatCalls) {
		assert.equal(call.init.headers.authorization, 'Bearer iam-token-1');
	}
});

test('an IAM rejection surfaces as a WatsonxError naming the API key', async () => {
	const fetchStub = async () =>
		new Response(JSON.stringify({ errorCode: 'BXNIM0415E', errorMessage: 'bad key' }), { status: 400 });
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	await withFetch(fetchStub, () =>
		assert.rejects(client.chat([{ role: 'user', content: 'x' }]), (err) => {
			assert.ok(err instanceof WatsonxError);
			assert.match(err.message, /IAM authentication failed/);
			assert.equal(err.status, 400);
			assert.equal(err.detail, 'bad key');
			return true;
		}),
	);
});

// ── chat / generate ───────────────────────────────────────────────────────

test('chat posts model, messages, parameters, and project scope; shapes the reply', async () => {
	const log = [];
	const fetchStub = watsonxFetch(
		{
			'/ml/v1/text/chat': {
				model_id: 'ibm/granite-3-8b-instruct',
				choices: [{ message: { content: 'Answer.' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 9, completion_tokens: 3 },
			},
		},
		log,
	);
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	const out = await withFetch(fetchStub, () =>
		client.chat([{ role: 'user', content: 'q' }], { parameters: { max_new_tokens: 64 } }),
	);

	const call = log.find((c) => c.url.includes('/ml/v1/text/chat'));
	assert.match(call.url, /\?version=2024-05-31$/);
	const body = JSON.parse(call.init.body);
	assert.equal(body.model_id, 'ibm/granite-3-8b-instruct');
	assert.deepEqual(body.messages, [{ role: 'user', content: 'q' }]);
	assert.deepEqual(body.parameters, { max_new_tokens: 64 });
	assert.equal(body.project_id, 'proj-123', 'project scope must ride along');
	assert.ok(!('space_id' in body));

	assert.deepEqual(out, {
		text: 'Answer.',
		finishReason: 'stop',
		usage: { prompt_tokens: 9, completion_tokens: 3 },
		model: 'ibm/granite-3-8b-instruct',
	});
});

test('a space-scoped client sends space_id instead of project_id', async () => {
	const log = [];
	const fetchStub = watsonxFetch({ '/ml/v1/text/chat': { choices: [] } }, log);
	const client = new WatsonxClient(loadConfig({ WATSONX_API_KEY: 'k', WATSONX_SPACE_ID: 'space-9' }));
	const out = await withFetch(fetchStub, () => client.chat([{ role: 'user', content: 'q' }]));
	const body = JSON.parse(log.find((c) => c.url.includes('/ml/v1/text/chat')).init.body);
	assert.equal(body.space_id, 'space-9');
	assert.ok(!('project_id' in body));
	assert.equal(out.text, '', 'no choices → empty text, not a crash');
});

test('generate shapes the text-generation result fields', async () => {
	const fetchStub = watsonxFetch({
		'/ml/v1/text/generation': {
			results: [
				{ generated_text: 'code here', generated_token_count: 5, input_token_count: 11, stop_reason: 'eos_token' },
			],
		},
	});
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	const out = await withFetch(fetchStub, () => client.generate('write code'));
	assert.deepEqual(out, {
		text: 'code here',
		generatedTokenCount: 5,
		inputTokenCount: 11,
		stopReason: 'eos_token',
		model: 'ibm/granite-3-8b-instruct',
	});
});

// ── embed ─────────────────────────────────────────────────────────────────

test('embed maps result vectors and reports count and dimensions', async () => {
	const log = [];
	const fetchStub = watsonxFetch(
		{
			'/ml/v1/text/embeddings': {
				results: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
			},
		},
		log,
	);
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	const out = await withFetch(fetchStub, () => client.embed(['a', 'b']));
	const body = JSON.parse(log.find((c) => c.url.includes('/embeddings')).init.body);
	assert.equal(body.model_id, 'ibm/granite-embedding-278m-multilingual');
	assert.deepEqual(body.inputs, ['a', 'b']);
	assert.deepEqual(out.vectors, [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
	assert.equal(out.inputCount, 2);
	assert.equal(out.dimensions, 3);
});

// ── forecast ──────────────────────────────────────────────────────────────

test('forecast validates series alignment before any network call', async () => {
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	const cases = [
		{ timestamps: ['t1'], values: [1, 2] },
		{ timestamps: [], values: [] },
		{ timestamps: 'nope', values: [1] },
		{ timestamps: ['t1'], values: 'nope' },
	];
	await withFetch(
		async () => {
			throw new Error('network must not be reached');
		},
		async () => {
			for (const args of cases) {
				await assert.rejects(client.forecast({ ...args, freq: '1D' }), (err) => {
					assert.ok(err instanceof WatsonxError);
					assert.match(err.message, /equal-length, non-empty arrays/);
					return true;
				});
			}
		},
	);
});

test('forecast builds the TTM payload on the time-series API version and shapes the horizon', async () => {
	const log = [];
	const fetchStub = watsonxFetch(
		{
			'/ml/v1/time_series/forecast': {
				model_id: 'ibm/granite-ttm-512-96-r2',
				results: [{ date: ['2025-01-03', '2025-01-04'], value: [30] }],
			},
		},
		log,
	);
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	const out = await withFetch(fetchStub, () =>
		client.forecast({
			timestamps: ['2025-01-01', '2025-01-02'],
			values: [10, 20],
			freq: '1D',
			predictionLength: 2,
		}),
	);

	const call = log.find((c) => c.url.includes('/time_series/forecast'));
	assert.match(call.url, /\?version=2025-02-11$/, 'uses the TS API version, not the text one');
	const body = JSON.parse(call.init.body);
	assert.deepEqual(body.schema, { timestamp_column: 'date', freq: '1D', target_columns: ['value'] });
	assert.deepEqual(body.data, { date: ['2025-01-01', '2025-01-02'], value: [10, 20] });
	assert.deepEqual(body.parameters, { prediction_length: 2 });

	assert.equal(out.model, 'ibm/granite-ttm-512-96-r2');
	assert.deepEqual(out.timestamps, ['2025-01-03', '2025-01-04']);
	assert.deepEqual(out.values, [30]);
	assert.equal(out.inputWindow, 2);
});

// ── tokenize / listModels / errors ────────────────────────────────────────

test('tokenize returns the token count for the chat model by default', async () => {
	const log = [];
	const fetchStub = watsonxFetch({ '/ml/v1/text/tokenization': { result: { token_count: 17 } } }, log);
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	const out = await withFetch(fetchStub, () => client.tokenize('some text'));
	const body = JSON.parse(log.find((c) => c.url.includes('/tokenization')).init.body);
	assert.deepEqual(body.parameters, { return_tokens: false });
	assert.deepEqual(out, { model: 'ibm/granite-3-8b-instruct', tokenCount: 17 });
});

test('listModels clamps limit to 200, forwards filters, and shapes the specs', async () => {
	const log = [];
	const fetchStub = watsonxFetch(
		{
			'/ml/v1/foundation_model_specs': {
				resources: [
					{
						model_id: 'ibm/granite-3-8b-instruct',
						label: 'Granite 3 8B',
						provider: 'IBM',
						functions: [{ id: 'text_chat' }, { id: 'text_generation' }],
						short_description: 'Instruct model',
					},
				],
			},
		},
		log,
	);
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	const out = await withFetch(fetchStub, () => client.listModels({ filter: 'function_text_chat', limit: 999 }));
	const url = new URL(log.find((c) => c.url.includes('foundation_model_specs')).url);
	assert.equal(url.searchParams.get('limit'), '200');
	assert.equal(url.searchParams.get('filters'), 'function_text_chat');
	assert.equal(url.searchParams.get('version'), '2024-05-31');
	assert.deepEqual(out, [
		{
			model_id: 'ibm/granite-3-8b-instruct',
			label: 'Granite 3 8B',
			provider: 'IBM',
			functions: ['text_chat', 'text_generation'],
			short_description: 'Instruct model',
		},
	]);
});

test('an upstream 4xx/5xx becomes a WatsonxError with status, message, and detail code', async () => {
	const fetchStub = watsonxFetch({
		'/ml/v1/text/chat': () =>
			new Response(
				JSON.stringify({ errors: [{ code: 'model_not_supported', message: 'model x does not exist' }], trace: 'abc' }),
				{ status: 404 },
			),
	});
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	await withFetch(fetchStub, () =>
		assert.rejects(client.chat([{ role: 'user', content: 'q' }]), (err) => {
			assert.ok(err instanceof WatsonxError);
			assert.equal(err.status, 404);
			assert.match(err.message, /watsonx\.ai error \(404\): model x does not exist/);
			assert.equal(err.detail, 'model_not_supported');
			return true;
		}),
	);
});

test('a non-JSON upstream error body still produces a readable WatsonxError', async () => {
	const fetchStub = watsonxFetch({
		'/ml/v1/text/chat': () => new Response('<html>Gateway Timeout</html>', { status: 504 }),
	});
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	await withFetch(fetchStub, () =>
		assert.rejects(client.chat([{ role: 'user', content: 'q' }]), (err) => {
			assert.equal(err.status, 504);
			assert.match(err.message, /watsonx\.ai error \(504\): <html>Gateway Timeout<\/html>/);
			return true;
		}),
	);
});

test('a network failure is wrapped in a WatsonxError naming the URL', async () => {
	const client = new WatsonxClient(loadConfig(BASE_ENV));
	await withFetch(
		async () => {
			throw new TypeError('fetch failed');
		},
		() =>
			assert.rejects(client.chat([{ role: 'user', content: 'q' }]), (err) => {
				assert.ok(err instanceof WatsonxError);
				assert.match(err.message, /Network error calling https:\/\/iam\.cloud\.ibm\.com/);
				return true;
			}),
	);
});
