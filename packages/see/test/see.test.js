// @three-ws/see: the contract an agent depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { see, toMessageContent, VIEWS, SeeError } from '../src/index.js';

const OK = {
	model_url: 'https://cdn.test/robot.glb',
	size: 512,
	views: [
		{ view: 'three-quarter', theta: 35, phi: 78, image_url: 'https://cdn.test/a.png' },
		{ view: 'back', theta: 180, phi: 80, image_url: 'https://cdn.test/b.png' },
	],
	stats: { triangles: 12400, materials: 2 },
	notes: ['12,400 triangles, a normal real-time budget for a hero prop or character.'],
	viewer_url: 'https://three.ws/viewer?src=x',
	ar_url: 'https://three.ws/api/ar?src=x',
};

const jsonRes = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('rejects a non-https model URL before any network call', async () => {
	let called = false;
	await assert.rejects(
		() => see('ftp://example.com/x.glb', { fetch: async () => { called = true; } }),
		(e) => e instanceof SeeError && e.code === 'invalid_url',
	);
	assert.equal(called, false);
});

test('returns camelCase views, stats and links from the service payload', async () => {
	const look = await see('https://cdn.test/robot.glb', { fetch: async () => jsonRes(200, OK) });
	assert.equal(look.modelUrl, 'https://cdn.test/robot.glb');
	assert.deepEqual(look.views.map((v) => v.view), ['three-quarter', 'back']);
	assert.equal(look.views[0].imageUrl, 'https://cdn.test/a.png');
	assert.equal(look.stats.triangles, 12400);
	assert.equal(look.viewerUrl, 'https://three.ws/viewer?src=x');
	assert.deepEqual(look.missingViews, []);
});

test('sends only the options the caller set, so service defaults stand', async () => {
	let sent;
	await see('https://cdn.test/robot.glb', {
		fetch: async (_u, init) => { sent = JSON.parse(init.body); return jsonRes(200, OK); },
	});
	assert.deepEqual(sent, { glb_url: 'https://cdn.test/robot.glb' });

	await see('https://cdn.test/robot.glb', {
		views: ['back'], size: 256, stats: false,
		fetch: async (_u, init) => { sent = JSON.parse(init.body); return jsonRes(200, OK); },
	});
	assert.deepEqual(sent, { glb_url: 'https://cdn.test/robot.glb', views: ['back'], size: 256, stats: false });
});

test('surfaces a rate limit as a typed error carrying retryAfter', async () => {
	await assert.rejects(
		() => see('https://cdn.test/robot.glb', {
			fetch: async () => jsonRes(429, { error: 'rate_limited', message: 'slow down', retry_after: 42 }),
		}),
		(e) => e instanceof SeeError && e.code === 'rate_limited' && e.status === 429 && e.retryAfter === 42,
	);
});

test('reports a partial turntable rather than hiding it', async () => {
	const look = await see('https://cdn.test/robot.glb', {
		fetch: async () => jsonRes(200, { ...OK, missing_views: [{ view: 'top', error: 'render timed out' }] }),
	});
	assert.equal(look.missingViews.length, 1);
	assert.equal(look.missingViews[0].view, 'top');
});

test('shapes a look into multimodal content, one labelled image per angle', async () => {
	const look = await see('https://cdn.test/robot.glb', { fetch: async () => jsonRes(200, OK) });
	const content = await toMessageContent(look);
	assert.equal(content[0].type, 'text');
	assert.match(content[0].text, /Geometry:/);
	const images = content.filter((c) => c.type === 'image');
	assert.equal(images.length, 2);
	assert.equal(images[0].source.url, 'https://cdn.test/a.png');
	assert.equal(content[1].text, 'View: three-quarter');
});

test('inlines base64 when the target API will not fetch a URL', async () => {
	const look = await see('https://cdn.test/robot.glb', { fetch: async () => jsonRes(200, OK) });
	const content = await toMessageContent(look, {
		fetchImages: true,
		fetch: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
	});
	const img = content.find((c) => c.type === 'image');
	assert.equal(img.source.type, 'base64');
	assert.equal(img.source.media_type, 'image/png');
	assert.equal(img.source.data, Buffer.from([1, 2, 3]).toString('base64'));
});

test('publishes the angle vocabulary so a caller need not guess', () => {
	assert.ok(VIEWS.includes('three-quarter') && VIEWS.includes('bottom'));
	assert.equal(VIEWS.length, 6);
});
