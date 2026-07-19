// Unit tests for the concierge answer client's SSE accumulation and the page
// fetcher's guards. `fetch` is stubbed, no real network. The live /api/concierge
// integration is exercised separately by test/_manual-e2e.mjs.
//
// Run: node --test packages/concierge-mcp/test/api.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { askConcierge, fetchPage } from '../src/lib/api.js';

function sseResponse(frames) {
	const body = {
		getReader() {
			let i = 0;
			return {
				read() {
					if (i >= frames.length) return Promise.resolve({ done: true, value: undefined });
					return Promise.resolve({ done: false, value: new TextEncoder().encode(frames[i++]) });
				},
				cancel() {
					return Promise.resolve();
				},
			};
		},
	};
	return { ok: true, status: 200, headers: new Map(), body };
}

test('askConcierge accumulates chunk text and captures done metadata', async () => {
	let captured = null;
	global.fetch = async (url, opts) => {
		captured = { url: String(url), body: JSON.parse(opts.body) };
		return sseResponse([
			'data: {"type":"chunk","text":"Pro skates "}\n\n',
			'data: {"type":"chunk","text":"cost $199."}\n\n',
			'data: {"type":"done","provider":"groq","model":"llama-3.3-70b"}\n\n',
		]);
	};
	const out = await askConcierge({
		question: 'How much are Pro skates?',
		site: { name: 'Acme', knowledge: 'Pro skates cost $199.' },
	});
	assert.equal(out.answer, 'Pro skates cost $199.');
	assert.equal(out.provider, 'groq');
	assert.equal(out.model, 'llama-3.3-70b');
	// The POST carried the message + the site payload.
	assert.equal(captured.body.message, 'How much are Pro skates?');
	assert.equal(captured.body.site.name, 'Acme');
	assert.match(captured.url, /\/api\/concierge$/);
	delete global.fetch;
});

test('askConcierge reassembles chunks split across network reads', async () => {
	global.fetch = async () =>
		sseResponse(['data: {"type":"chunk","tex', 't":"Hello "}\n\ndata: {"type":"chunk","text":"world."}\n\n', 'data: {"type":"done"}\n\n']);
	const out = await askConcierge({ question: 'hi', site: {} });
	assert.equal(out.answer, 'Hello world.');
	delete global.fetch;
});

test('askConcierge surfaces a stream error when no text arrived', async () => {
	global.fetch = async () => sseResponse(['data: {"type":"error","error":"upstream exploded"}\n\n']);
	await assert.rejects(() => askConcierge({ question: 'hi', site: {} }), /upstream exploded/);
	delete global.fetch;
});

test('askConcierge maps a non-2xx to an upstream_error with status', async () => {
	global.fetch = async () => ({ ok: false, status: 503, json: async () => ({ message: 'at capacity' }) });
	await assert.rejects(
		() => askConcierge({ question: 'hi', site: {} }),
		(err) => err.code === 'upstream_error' && err.status === 503 && /capacity/.test(err.message),
	);
	delete global.fetch;
});

test('fetchPage rejects non-http(s) URLs before any network call', async () => {
	await assert.rejects(() => fetchPage('ftp://example.com/x'), /only http\(s\)/);
	await assert.rejects(() => fetchPage('not a url'), /valid URL/);
});

test('fetchPage rejects a non-HTML content-type', async () => {
	global.fetch = async () => ({
		ok: true,
		status: 200,
		headers: new Map([['content-type', 'application/json']]),
		body: null,
		text: async () => '{}',
	});
	await assert.rejects(() => fetchPage('https://example.com/data.json'), /not an HTML page/);
	delete global.fetch;
});
