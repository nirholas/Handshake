// Handler behavior for @three-ws/loom-mcp: request building, response shaping,
// and error normalization. Global fetch is stubbed for every test, so nothing
// here touches the network or the public gallery.
//
// Env is pinned BEFORE the dynamic imports because src/config.js reads
// process.env at module load.
//
// Run: node --test packages/loom-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THREE_WS_BASE = 'https://loom.test/';
delete process.env.THREE_WS_TIMEOUT_MS;

const { def: getLoomFeed } = await import('../src/tools/get-loom-feed.js');
const { def: getCreation } = await import('../src/tools/get-creation.js');
const { def: submitCreation } = await import('../src/tools/submit-creation.js');
const { apiRequest } = await import('../src/lib/api.js');
const { THREE_WS_BASE } = await import('../src/config.js');

const GLB = 'https://three.ws/accessories/hat-cowboy.glb';

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

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function recordingFetch(body, log, status = 200) {
	return async (url, init) => {
		log.push({ url: String(url), init });
		return jsonResponse(body, status);
	};
}

function creationRow(over = {}) {
	return {
		id: 'c0ffee00-0000-4000-8000-000000000001',
		prompt: 'a cowboy hat, low-poly',
		glbUrl: GLB,
		previewImageUrl: null,
		author: 'anon',
		tier: null,
		backend: null,
		createdAt: 1750000000000,
		...over,
	};
}

test('config strips trailing slashes off THREE_WS_BASE', () => {
	assert.equal(THREE_WS_BASE, 'https://loom.test');
});

// -- get_loom_feed ----------------------------------------------------------

test('get_loom_feed pages /api/loom and decorates every creation for inline preview', async () => {
	const log = [];
	const body = { creations: [creationRow()], nextBefore: 1749999000000 };
	const out = await withFetch(recordingFetch(body, log), () => getLoomFeed.handler({ limit: 2, before: 1750000000001 }));
	const url = new URL(log[0].url);
	assert.equal(url.origin + url.pathname, 'https://loom.test/api/loom');
	assert.equal(url.searchParams.get('limit'), '2');
	assert.equal(url.searchParams.get('before'), '1750000000001');
	assert.equal(out.ok, true);
	assert.equal(out.count, 1);
	assert.equal(out.nextBefore, 1749999000000);
	assert.equal(out.has_more, true, 'a cursor means there is another page');
	const [first] = out.creations;
	assert.equal(first.viewer_url, `https://loom.test/forge/embed?src=${encodeURIComponent(GLB)}&title=a+cowboy+hat%2C+low-poly`);
	assert.equal(first.og_image_url, `https://loom.test/api/avatar-og?src=${encodeURIComponent(GLB)}`);
	assert.match(first.iframe_snippet, /^<iframe src="https:\/\/loom\.test\/forge\/embed\?src=/);
	assert.equal(first.prompt, 'a cowboy hat, low-poly', 'unknown fields pass through untouched');
});

test('get_loom_feed sends no query at all when no options are given', async () => {
	const log = [];
	await withFetch(recordingFetch({ creations: [] }, log), () => getLoomFeed.handler({}));
	assert.equal([...new URL(log[0].url).searchParams.keys()].length, 0);
});

test('the end of the feed is a null cursor and has_more:false, not an error', async () => {
	const out = await withFetch(async () => jsonResponse({ creations: [creationRow()], nextBefore: null }), () =>
		getLoomFeed.handler({}),
	);
	assert.equal(out.nextBefore, null);
	assert.equal(out.has_more, false);
});

test('a malformed feed body shapes into an empty page, never a crash', async () => {
	for (const body of [{}, { creations: 'nope' }, { creations: [null, 7] }]) {
		const out = await withFetch(async () => jsonResponse(body), () => getLoomFeed.handler({}));
		assert.deepEqual(out.creations, []);
		assert.equal(out.count, 0);
	}
});

test('a creation with no glbUrl still returns, with null preview fields', async () => {
	const out = await withFetch(async () => jsonResponse({ creations: [creationRow({ glbUrl: null })] }), () =>
		getLoomFeed.handler({}),
	);
	const [first] = out.creations;
	assert.equal(first.viewer_url, null);
	assert.equal(first.og_image_url, null);
	assert.equal(first.iframe_snippet, null);
});

// -- get_creation -----------------------------------------------------------

test('get_creation fetches one id via ?c= and decorates it', async () => {
	const log = [];
	const row = creationRow();
	const out = await withFetch(recordingFetch({ creation: row }, log), () => getCreation.handler({ id: ` ${row.id} ` }));
	const url = new URL(log[0].url);
	assert.equal(url.searchParams.get('c'), row.id, 'the id is trimmed before it is sent');
	assert.equal(out.creation.id, row.id);
	assert.ok(out.creation.viewer_url);
});

test('get_creation rejects an empty id before any network call', async () => {
	await withFetch(
		async () => {
			throw new Error('network must not be reached');
		},
		() => assert.rejects(getCreation.handler({ id: '   ' }), (err) => err.code === 'invalid_input'),
	);
});

test('an unknown id surfaces as not_found, not as a generic upstream_error', async () => {
	const body = { error: 'not_found', error_description: 'creation not found' };
	await withFetch(async () => jsonResponse(body, 404), () =>
		assert.rejects(getCreation.handler({ id: 'missing' }), (err) => {
			assert.equal(err.code, 'not_found');
			assert.equal(err.status, 404);
			assert.match(err.message, /No Loom creation found/);
			return true;
		}),
	);
});

test('a non-404 failure keeps its upstream_error typing', async () => {
	await withFetch(async () => jsonResponse({ error: 'boom', error_description: 'gallery storage down' }, 503), () =>
		assert.rejects(getCreation.handler({ id: 'x' }), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.message, 'gallery storage down');
			return true;
		}),
	);
});

// -- submit_creation --------------------------------------------------------

test('submit_creation POSTs the sanitized body and returns the decorated record', async () => {
	const log = [];
	const row = creationRow({ author: 'nova', backend: 'forge' });
	const out = await withFetch(recordingFetch({ creation: row }, log, 201), () =>
		submitCreation.handler({ prompt: '  a cowboy hat, low-poly  ', glbUrl: GLB, author: 'nova', backend: 'forge' }),
	);
	assert.equal(log[0].init.method, 'POST');
	assert.equal(log[0].init.headers['content-type'], 'application/json');
	assert.deepEqual(JSON.parse(log[0].init.body), {
		prompt: 'a cowboy hat, low-poly',
		glbUrl: GLB,
		author: 'nova',
		backend: 'forge',
	});
	assert.equal(out.creation.author, 'nova');
	assert.ok(out.creation.iframe_snippet);
});

test('submit_creation omits optional fields that were not supplied', async () => {
	const log = [];
	await withFetch(recordingFetch({ creation: creationRow() }, log, 201), () =>
		submitCreation.handler({ prompt: 'a cube', glbUrl: GLB }),
	);
	assert.deepEqual(Object.keys(JSON.parse(log[0].init.body)).sort(), ['glbUrl', 'prompt']);
});

test('a disallowed GLB host is rejected client-side, before the gallery is touched', async () => {
	const reject = async () => {
		throw new Error('network must not be reached');
	};
	for (const bad of ['http://three.ws/a.glb', 'https://evil.example.com/a.glb', 'not a url', '']) {
		await withFetch(reject, () =>
			assert.rejects(submitCreation.handler({ prompt: 'x', glbUrl: bad }), (err) => {
				assert.equal(err.code, 'invalid_glb_url');
				assert.equal(err.status, 400);
				return true;
			}),
		);
	}
});

test('submit_creation rejects an empty prompt before any network call', async () => {
	await withFetch(
		async () => {
			throw new Error('network must not be reached');
		},
		() => assert.rejects(submitCreation.handler({ prompt: '   ', glbUrl: GLB }), (err) => err.code === 'invalid_input'),
	);
});

// -- apiRequest -------------------------------------------------------------

test('apiRequest identifies itself and asks for JSON', async () => {
	const log = [];
	await withFetch(recordingFetch({ creations: [] }, log), () => apiRequest('/api/loom'));
	assert.equal(log[0].init.headers.accept, 'application/json');
	assert.equal(log[0].init.headers['user-agent'], '@three-ws/loom-mcp');
	assert.equal(log[0].init.body, undefined, 'GET carries no body');
});

test('apiRequest surfaces the platform error_description, not just the bare code', async () => {
	const body = { error: 'rate_limited', error_description: 'too many creations, slow down' };
	await withFetch(async () => jsonResponse(body, 429), () =>
		assert.rejects(apiRequest('/api/loom', { method: 'POST', body: {} }), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 429);
			assert.equal(err.message, 'too many creations, slow down');
			assert.deepEqual(err.body, body);
			return true;
		}),
	);
});

test('apiRequest maps a transport failure to network_error and an abort to timeout', async () => {
	await withFetch(
		async () => {
			throw new TypeError('fetch failed');
		},
		() => assert.rejects(apiRequest('/api/loom'), (err) => err.code === 'network_error'),
	);
	await withFetch(
		async () => {
			throw Object.assign(new Error('aborted'), { name: 'AbortError' });
		},
		() => assert.rejects(apiRequest('/api/loom'), (err) => err.code === 'timeout'),
	);
});
