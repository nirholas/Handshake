import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	createPose,
	poseSeed,
	presetPose,
	listPresetGroups,
	PRESETS,
	PRESET_GROUPS,
	PoseError,
	PaymentRequiredError,
} from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints — we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

// A representative structuredContent envelope from the real pose_model tool.
function poseResponse(overrides = {}) {
	return {
		jsonrpc: '2.0',
		id: 1,
		result: {
			content: [{ type: 'text', text: 'Pose "Wave hello" (Standing) — seed 8c12abef0011e0f9.' }],
			structuredContent: {
				seed: '8c12abef0011e0f9',
				preset_id: 'wave',
				preset_label: 'Wave hello',
				group: 'Standing',
				parameters: {
					shoulderL: { x: 0, y: 0, z: 0.1 },
					shoulderR: { x: 0, y: 0, z: -2.45 },
					elbowR: { x: -1.2, y: 0, z: 0 },
				},
				preview_url: 'https://three.ws/pose?seed=8c12abef0011e0f9&preset=wave',
				match: { score: 3, reason: 'token-match' },
				groups: PRESET_GROUPS,
				...overrides,
			},
		},
	};
}

test('poseSeed() posts a tools/call and shapes snake_case → camelCase', async () => {
	const { fetch, calls } = stubFetch([{ body: poseResponse() }]);
	const client = createPose({ fetch, baseUrl: 'https://three.ws' });
	const pose = await client.poseSeed('wave hello');

	assert.equal(calls[0].url.pathname, '/api/mcp-3d');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.jsonrpc, '2.0');
	assert.equal(sent.method, 'tools/call');
	assert.equal(sent.params.name, 'pose_model');
	assert.equal(sent.params.arguments.prompt, 'wave hello');

	assert.equal(pose.seed, '8c12abef0011e0f9');
	assert.equal(pose.presetId, 'wave');
	assert.equal(pose.presetLabel, 'Wave hello');
	assert.equal(pose.group, 'Standing');
	assert.deepEqual(pose.parameters.shoulderR, { x: 0, y: 0, z: -2.45 });
	assert.equal(pose.previewUrl, 'https://three.ws/pose?seed=8c12abef0011e0f9&preset=wave');
	assert.equal(pose.match.reason, 'token-match');
	assert.deepEqual(pose.groups, PRESET_GROUPS);
	assert.equal(pose.raw.preset_id, 'wave');
});

test('the streamable-HTTP accept header advertises JSON + SSE', async () => {
	const { fetch, calls } = stubFetch([{ body: poseResponse() }]);
	const client = createPose({ fetch });
	await client.poseSeed('crouch');
	assert.match(calls[0].init.headers.accept, /text\/event-stream/);
	assert.match(calls[0].init.headers.accept, /application\/json/);
});

test('previewBase override rebases the returned previewUrl', async () => {
	const { fetch } = stubFetch([{ body: poseResponse() }]);
	const client = createPose({ fetch, previewBase: 'https://staging.three.ws/pose' });
	const pose = await client.poseSeed('wave hello');
	assert.equal(pose.previewUrl, 'https://staging.three.ws/pose?seed=8c12abef0011e0f9&preset=wave');
});

test('presetPose() resolves a known preset and rejects an unknown one before network', async () => {
	const { fetch, calls } = stubFetch([{ body: poseResponse({ preset_id: 'crouch', preset_label: 'Crouching', group: 'Sitting & Floor' }) }]);
	const client = createPose({ fetch });
	const pose = await client.presetPose('crouch');
	assert.equal(JSON.parse(calls[0].init.body).params.arguments.prompt, 'crouch');
	assert.equal(pose.presetId, 'crouch');

	await assert.rejects(() => client.presetPose('not-a-pose'), (e) => {
		assert.ok(e instanceof PoseError);
		assert.equal(e.code, 'invalid_prompt');
		return true;
	});
	assert.equal(calls.length, 1, 'the invalid preset never hit the network');
});

test('an empty or oversized prompt is rejected before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createPose({ fetch });
	await assert.rejects(() => client.poseSeed(''), (e) => {
		assert.ok(e instanceof PoseError);
		assert.equal(e.code, 'invalid_prompt');
		return true;
	});
	await assert.rejects(() => client.poseSeed('x'.repeat(501)), /1–500 characters/);
	assert.equal(calls.length, 0);
});

test('a JSON-RPC error envelope surfaces as a tool_error PoseError', async () => {
	const { fetch } = stubFetch([
		{ body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params for pose_model' } } },
	]);
	const client = createPose({ fetch });
	await assert.rejects(() => client.poseSeed('warrior stance'), (e) => {
		assert.ok(e instanceof PoseError);
		assert.equal(e.code, 'tool_error');
		assert.match(e.message, /invalid params/);
		return true;
	});
});

test('a result.isError tool result surfaces its text as a PoseError', async () => {
	const { fetch } = stubFetch([
		{ body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Error: rate_limited' }], isError: true } } },
	]);
	const client = createPose({ fetch });
	await assert.rejects(() => client.poseSeed('jump'), (e) => {
		assert.ok(e instanceof PoseError);
		assert.equal(e.code, 'tool_error');
		assert.match(e.message, /rate_limited/);
		return true;
	});
});

test('a 402 from the paid MCP lane surfaces as PaymentRequiredError with the x402 challenge', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'solana:mainnet', maxAmountRequired: '10000' }];
	const { fetch } = stubFetch([{ status: 402, body: { error: 'payment_required', message: 'pay', accepts } }]);
	const client = createPose({ fetch });
	await assert.rejects(() => client.poseSeed('kneeling'), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
});

test('listPresetGroups() returns the four real groups synchronously', () => {
	assert.deepEqual(listPresetGroups(), ['Standing', 'Action', 'Sitting & Floor', 'Expressive']);
	const client = createPose({ fetch: async () => { throw new Error('no network'); } });
	assert.deepEqual(client.listPresetGroups(), PRESET_GROUPS);
});

// ── The local lane (zero-config default: no network, no key, no payment) ──

test('zero-config poseSeed() resolves locally and never touches the network', async (t) => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error('the local lane must not fetch');
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const pose = await poseSeed('wave hello');
	assert.equal(pose.presetId, 'wave');
	assert.equal(pose.presetLabel, 'Wave hello');
	assert.equal(pose.group, 'Standing');
	assert.equal(pose.match.reason, 'token-match');
	assert.ok(pose.match.score > 0);
	assert.match(pose.seed, /^[0-9a-f]{16}$/);
	assert.equal(pose.previewUrl, `https://three.ws/pose?seed=${pose.seed}&preset=wave`);
	assert.deepEqual(pose.groups, PRESET_GROUPS);
	assert.ok(Object.keys(pose.parameters).length > 0, 'a real rotation map came back');
});

test('the local seed matches the hosted algorithm: sha256(prompt|presetId) first 16 hex', async () => {
	const pose = await poseSeed('wave hello');
	const expected = createHash('sha256').update(`wave hello|${pose.presetId}`).digest('hex').slice(0, 16);
	assert.equal(pose.seed, expected);
});

test('local resolution is deterministic across calls and clients', async () => {
	const a = await poseSeed('crouch');
	const b = await poseSeed('crouch');
	const c = await createPose().poseSeed('crouch');
	assert.equal(a.seed, b.seed);
	assert.equal(a.seed, c.seed);
	assert.equal(a.presetId, b.presetId);
});

test('a no-match prompt falls back to a deterministic pick, never an error', async () => {
	const prompt = 'zzz qqq xyzzy';
	const a = await poseSeed(prompt);
	const b = await poseSeed(prompt);
	assert.equal(a.match.reason, 'no-match-deterministic-pick');
	assert.equal(a.match.score, 0);
	assert.equal(a.presetId, b.presetId, 'the fallback pick is stable');
	assert.ok(PRESETS.some((p) => p.id === a.presetId), 'the pick is a real preset');
});

test('presetPose() resolves every bundled preset locally, exactly by id', async () => {
	for (const preset of PRESETS) {
		const pose = await presetPose(preset.id);
		assert.equal(pose.presetId, preset.id, `presetPose('${preset.id}') returns its own preset`);
		assert.deepEqual(pose.parameters, preset.pose);
		assert.equal(pose.match.reason, 'preset-id');
	}
});

test('previewBase override applies on the local lane too', async () => {
	const client = createPose({ previewBase: 'https://staging.three.ws/pose' });
	const pose = await client.poseSeed('wave hello');
	assert.ok(pose.previewUrl.startsWith('https://staging.three.ws/pose?seed='));
});

test('an aborted signal rejects the local call with AbortError', async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => poseSeed('wave hello', { signal: controller.signal }), (e) => {
		assert.equal(e.name, 'AbortError');
		return true;
	});
});
