// Caller-facing input rules this server enforces itself, before spending a
// request on the upstream model lanes.
//
// `audio_to_face` is the only tool with a rule its JSON schema cannot express:
// exactly one of two optional fields must be present. A caller who passes
// neither should be told that in the same turn, not after a round trip that
// fails somewhere in the pipeline.
//
// No network: every case here is decided before a request is made.
//
// Run: node --test packages/audio-mcp/test/input-contract.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/index.js';
import { HTTP_TIMEOUT_MS, THREE_WS_BASE } from '../src/config.js';

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

test('audio_to_face declares text and audio as the two ways in', () => {
	const schema = byName.audio_to_face.inputSchema;
	assert.ok('text' in schema, 'the text path must be declared');
	assert.ok('audio' in schema, 'the audio path must be declared');
	// Both optional at the schema layer, because the rule is "exactly one".
	assert.equal(schema.text.isOptional(), true);
	assert.equal(schema.audio.isOptional(), true);
});

test('audio_to_face refuses locally when neither text nor audio is given', async () => {
	const started = Date.now();
	for (const args of [{}, { text: '' }, { text: '   ' }, { audio: '' }]) {
		await assert.rejects(
			() => byName.audio_to_face.handler(args),
			(err) => {
				assert.equal(err.code, 'bad_request', `expected bad_request for ${JSON.stringify(args)}`);
				assert.match(err.message, /text/, 'the message must name the text path');
				assert.match(err.message, /audio/, 'the message must name the audio path');
				return true;
			},
		);
	}
	// A local refusal, not a round trip that happened to fail.
	assert.ok(Date.now() - started < 1000, 'an empty request must not reach a model lane');
});

test('the request budget is generous enough for a real model call', () => {
	// TTS, ASR, and Audio2Face are live gRPC calls to hosted models, not cache
	// reads. A short default would time out on a clip that synthesizes fine.
	assert.equal(HTTP_TIMEOUT_MS, 60000);
	assert.ok(HTTP_TIMEOUT_MS >= 30000, 'a model call needs real headroom');
});

test('the base URL is normalized so path joins cannot double a slash', () => {
	assert.equal(THREE_WS_BASE, 'https://three.ws');
	assert.doesNotMatch(THREE_WS_BASE, /\/$/, 'a trailing slash would produce //api/... paths');
});
