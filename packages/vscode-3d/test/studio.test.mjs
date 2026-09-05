// The studio client: how a tools/call answer becomes a model, and how the
// transport reports the ways a call can fail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readModelResult, textOf, normalizeOrigin, rpc, callTool, TOOLS } from '../src/studio.js';

test('a structured result yields the model', () => {
	const model = readModelResult({
		structuredContent: {
			kind: 'model',
			glbUrl: 'https://three.ws/cdn/creations/abc/mesh.glb',
			viewerUrl: 'https://three.ws/viewer?src=x',
			format: 'glb',
			prompt: 'a frog',
		},
	});
	assert.equal(model.glbUrl, 'https://three.ws/cdn/creations/abc/mesh.glb');
	assert.equal(model.prompt, 'a frog');
});

test('a snake_case glb_url is accepted too', () => {
	assert.equal(
		readModelResult({ structuredContent: { glb_url: 'https://x/y.glb' } }).glbUrl,
		'https://x/y.glb',
	);
});

test('an error result surfaces what the studio said', () => {
	assert.throws(
		() => readModelResult({ isError: true, content: [{ type: 'text', text: 'lane is busy' }] }),
		/lane is busy/,
	);
});

test('a result with no model is a failure, not an empty viewer', () => {
	assert.throws(() => readModelResult({ content: [] }), /no model URL/);
	assert.throws(() => readModelResult(null), /empty response/);
});

test('a non-http URL is refused rather than opened', () => {
	assert.throws(() => readModelResult({ structuredContent: { glbUrl: 'file:///etc/passwd' } }), /no model URL/);
});

test('text blocks are joined and capped', () => {
	assert.equal(textOf({ content: [{ text: ' one ' }, { text: 'two' }] }), 'one\ntwo');
	assert.equal(textOf({}), '');
});

test('the origin must be an http(s) origin', () => {
	assert.equal(normalizeOrigin('https://three.ws/'), 'https://three.ws');
	assert.throws(() => normalizeOrigin('three.ws'), /must be an http\(s\) origin/);
});

test('a JSON-RPC error is reported with its message', async () => {
	const server = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'prompt too short' } }));
	});
	await new Promise((r) => server.listen(0, r));
	const origin = `http://127.0.0.1:${server.address().port}`;
	await assert.rejects(() => rpc(origin, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), /prompt too short/);
	server.close();
});

test('a non-JSON body is reported with its status', async () => {
	const server = createServer((req, res) => {
		res.writeHead(502, { 'content-type': 'text/html' });
		res.end('<html>bad gateway</html>');
	});
	await new Promise((r) => server.listen(0, r));
	const origin = `http://127.0.0.1:${server.address().port}`;
	await assert.rejects(() => rpc(origin, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), /502 with a non-JSON body/);
	server.close();
});

test('callTool posts a tools/call for the named tool', async () => {
	let seen = null;
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			seen = JSON.parse(body);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					jsonrpc: '2.0',
					id: seen.id,
					result: { structuredContent: { glbUrl: 'https://x/y.glb' } },
				}),
			);
		});
	});
	await new Promise((r) => server.listen(0, r));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const model = await callTool(origin, TOOLS.model, { prompt: 'a frog', tier: 'draft' });
	assert.equal(model.glbUrl, 'https://x/y.glb');
	assert.equal(seen.method, 'tools/call');
	assert.equal(seen.params.name, 'forge_free');
	assert.deepEqual(seen.params.arguments, { prompt: 'a frog', tier: 'draft' });
	server.close();
});

test('a timeout is reported as a timeout', async () => {
	const server = createServer(() => {});
	await new Promise((r) => server.listen(0, r));
	const origin = `http://127.0.0.1:${server.address().port}`;
	await assert.rejects(
		() => rpc(origin, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { timeoutMs: 60 }),
		/did not answer within/,
	);
	server.close();
});
