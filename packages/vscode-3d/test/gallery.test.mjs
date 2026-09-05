// The forge gallery feed. Rows come from a public endpoint, so anything without
// a usable model URL is dropped rather than rendered as a dead tree item.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeCreation, listCreations } from '../src/gallery.js';

test('the web-optimized copy wins over the original', () => {
	const item = normalizeCreation({
		id: 'abc',
		prompt: '  a frog  ',
		glb_url: 'https://x/raw.glb',
		web_glb_url: 'https://x/web.glb',
		model_category: 'avatar',
	});
	assert.equal(item.glbUrl, 'https://x/web.glb');
	assert.equal(item.prompt, 'a frog');
	assert.equal(item.category, 'avatar');
});

test('a row with no model URL is dropped', () => {
	assert.equal(normalizeCreation({ id: 'abc' }), null);
	assert.equal(normalizeCreation({ id: 'abc', glb_url: 'ftp://x/y.glb' }), null);
});

test('the feed is normalised and filtered', async () => {
	const server = createServer((req, res) => {
		assert.match(req.url, /^\/api\/forge-gallery\?limit=40$/);
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({
				enabled: true,
				creations: [
					{ id: '1', prompt: 'a frog', glb_url: 'https://x/1.glb' },
					{ id: '2', prompt: 'broken' },
				],
			}),
		);
	});
	await new Promise((r) => server.listen(0, r));
	const items = await listCreations(`http://127.0.0.1:${server.address().port}`);
	assert.equal(items.length, 1);
	assert.equal(items[0].id, '1');
	server.close();
});

test('a disabled gallery says so', async () => {
	const server = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ enabled: false }));
	});
	await new Promise((r) => server.listen(0, r));
	await assert.rejects(
		() => listCreations(`http://127.0.0.1:${server.address().port}`),
		/turned off/,
	);
	server.close();
});

test('an HTTP failure is reported with its status', async () => {
	const server = createServer((req, res) => {
		res.writeHead(500);
		res.end('nope');
	});
	await new Promise((r) => server.listen(0, r));
	await assert.rejects(
		() => listCreations(`http://127.0.0.1:${server.address().port}`),
		/HTTP 500/,
	);
	server.close();
});
