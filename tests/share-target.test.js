// @vitest-environment jsdom
//
// Web Share Target handoff: the service worker half (public/share-target-sw.js,
// evaluated as the real file text against a fake `self`) and the page half
// (src/shared/share-target.js) round-tripped through a fake Cache API.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { File as NodeFile } from 'node:buffer';
import { takeSharedFiles, sharedIntent, clearSharedIntent } from '../src/shared/share-target.js';

const SW_SOURCE = readFileSync(resolve(process.cwd(), 'public/share-target-sw.js'), 'utf8');

// ── Fake Cache API (stores Response objects, deletes on demand) ─────────────
function makeFakeCaches() {
	const stores = new Map();
	class FakeCache {
		constructor() {
			this.entries = new Map();
		}
		keyOf(req) {
			const url = typeof req === 'string' ? req : req.url;
			return new URL(url, 'http://localhost').pathname;
		}
		async put(req, res) {
			this.entries.set(this.keyOf(req), res);
		}
		async match(req) {
			return this.entries.get(this.keyOf(req)) || undefined;
		}
		async delete(req) {
			return this.entries.delete(this.keyOf(req));
		}
		async keys() {
			return [...this.entries.keys()].map((k) => new Request(`http://localhost${k}`));
		}
	}
	return {
		stores,
		async open(name) {
			if (!stores.has(name)) stores.set(name, new FakeCache());
			return stores.get(name);
		},
	};
}

function stash(cache, index, file, receivedAt = Date.now()) {
	return cache.put(
		`/_share/${index}`,
		new Response(file, {
			headers: {
				'content-type': file.type || 'application/octet-stream',
				'x-share-filename': file.name,
				'x-share-received': String(receivedAt),
			},
		}),
	);
}

// ── Load the real SW file against a fake `self` ─────────────────────────────
function loadServiceWorker(fakeCaches) {
	const listeners = {};
	const fakeSelf = {
		addEventListener(type, fn) {
			listeners[type] = fn;
		},
	};
	const run = new Function('self', 'caches', 'Response', 'URL', 'console', SW_SOURCE);
	run(fakeSelf, fakeCaches, Response, URL, { error() {} });
	return { listeners, self: fakeSelf };
}

function fakeFetchEvent({ method = 'POST', url = 'https://three.ws/create/share', formData }) {
	let response = null;
	const event = {
		request: {
			method,
			url,
			formData: async () => {
				if (formData instanceof Error) throw formData;
				return formData;
			},
		},
		respondWith(p) {
			response = p;
		},
		get response() {
			return response;
		},
	};
	return event;
}

// The SW runs against the worker realm's File/FormData/Response, which all
// agree with each other. Under vitest-jsdom the page File is jsdom's while
// Response is Node's, so the worker side is fed Node-native Files through a
// minimal FormData stand-in (only `get` / `getAll` are used by the SW).
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff]);
const jpeg = () => new NodeFile([JPEG_BYTES], 'selfie.jpg', { type: 'image/jpeg' });
const glb = () => new NodeFile(['glTF'], 'avatar.glb', { type: 'model/gltf-binary' });
const png = () => new NodeFile(['x'], 'left.png', { type: 'image/png' });

function fakeFormData() {
	const fields = [];
	return {
		append: (k, v) => fields.push([k, v]),
		get: (k) => (fields.find(([key]) => key === k) || [])[1] ?? null,
		getAll: (k) => fields.filter(([key]) => key === k).map(([, v]) => v),
	};
}

function readBytes(file) {
	return new Promise((res, rej) => {
		const r = new FileReader();
		r.onload = () => res(new Uint8Array(r.result));
		r.onerror = () => rej(r.error);
		r.readAsArrayBuffer(file);
	});
}

describe('share-target service worker', () => {
	let fakeCaches;
	let sw;
	beforeEach(() => {
		fakeCaches = makeFakeCaches();
		sw = loadServiceWorker(fakeCaches);
	});

	it('registers a fetch listener and exposes the destination decision', () => {
		expect(typeof sw.listeners.fetch).toBe('function');
		const dest = sw.self.__threewsShareTargetDestination;
		expect(dest([])).toBe('/create');
		expect(dest([{ name: 'a.jpg', type: 'image/jpeg' }])).toBe('/create/selfie?shared=1');
		expect(dest([{ name: 'a.glb', type: '' }])).toBe('/create?shared=glb');
		expect(dest([{ name: 'blob', type: 'model/gltf-binary' }])).toBe('/create?shared=glb');
		expect(dest([{ name: 'notes.txt', type: 'text/plain' }])).toBe('/create?shared=1');
	});

	it('ignores requests that are not the share POST', () => {
		const get = fakeFetchEvent({ method: 'GET' });
		sw.listeners.fetch(get);
		expect(get.response).toBeNull();
		const other = fakeFetchEvent({ url: 'https://three.ws/api/version' });
		sw.listeners.fetch(other);
		expect(other.response).toBeNull();
	});

	it('stashes shared images and meta, then redirects to the selfie flow', async () => {
		const fd = fakeFormData();
		fd.append('title', 'My face');
		fd.append('text', 'from gallery');
		fd.append('media', jpeg());
		fd.append('media', png());
		const ev = fakeFetchEvent({ formData: fd });
		sw.listeners.fetch(ev);
		const res = await ev.response;
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toMatch(/\/create\/selfie\?shared=1$/);

		const cache = fakeCaches.stores.get('threews-share-target');
		expect([...cache.entries.keys()].sort()).toEqual(['/_share/0', '/_share/1', '/_share/meta']);
		const first = cache.entries.get('/_share/0');
		expect(first.headers.get('x-share-filename')).toBe('selfie.jpg');
		expect(first.headers.get('content-type')).toBe('image/jpeg');
		expect(Number(first.headers.get('x-share-received'))).toBeGreaterThan(0);
		const meta = await cache.entries.get('/_share/meta').json();
		expect(meta).toMatchObject({ title: 'My face', text: 'from gallery', url: '', count: 2 });
	});

	it('routes a .glb to /create?shared=glb', async () => {
		const fd = fakeFormData();
		fd.append('media', glb());
		const ev = fakeFetchEvent({ formData: fd });
		sw.listeners.fetch(ev);
		const res = await ev.response;
		expect(res.headers.get('location')).toMatch(/\/create\?shared=glb$/);
	});

	it('redirects to /create when nothing was attached', async () => {
		const fd = fakeFormData();
		fd.append('text', 'just words');
		const ev = fakeFetchEvent({ formData: fd });
		sw.listeners.fetch(ev);
		const res = await ev.response;
		expect(res.headers.get('location')).toMatch(/\/create$/);
	});

	it('never fails the navigation: a broken form redirects to ?shared=error', async () => {
		const ev = fakeFetchEvent({ formData: new Error('multipart boom') });
		sw.listeners.fetch(ev);
		const res = await ev.response;
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toMatch(/\/create\?shared=error$/);
	});
});

describe('takeSharedFiles', () => {
	let fakeCaches;
	let origCaches;
	beforeEach(() => {
		fakeCaches = makeFakeCaches();
		origCaches = globalThis.caches;
		globalThis.caches = fakeCaches;
	});
	afterEach(() => {
		if (origCaches === undefined) delete globalThis.caches;
		else globalThis.caches = origCaches;
	});

	it('round-trips files and meta through the cache and consumes them', async () => {
		const cache = await fakeCaches.open('threews-share-target');
		await stash(cache, 1, png());
		await stash(cache, 0, jpeg());
		await cache.put(
			'/_share/meta',
			new Response(JSON.stringify({ title: 't', text: '', url: '', count: 2 }), {
				headers: { 'content-type': 'application/json', 'x-share-received': String(Date.now()) },
			}),
		);

		const { files, meta } = await takeSharedFiles();
		expect(files.map((f) => f.name)).toEqual(['selfie.jpg', 'left.png']);
		expect(files[0]).toBeInstanceOf(File);
		expect(files[0].type).toBe('image/jpeg');
		expect(await readBytes(files[0])).toEqual(JPEG_BYTES);
		expect(meta).toMatchObject({ title: 't', count: 2 });

		// One-shot: everything consumed.
		expect(cache.entries.size).toBe(0);
		const again = await takeSharedFiles();
		expect(again.files).toEqual([]);
		expect(again.meta).toBeNull();
	});

	it('drops entries older than maxAgeMs but still deletes them', async () => {
		const cache = await fakeCaches.open('threews-share-target');
		await stash(cache, 0, jpeg(), Date.now() - 60_000);
		await stash(cache, 1, glb(), Date.now());
		const { files } = await takeSharedFiles({ maxAgeMs: 30_000 });
		expect(files.map((f) => f.name)).toEqual(['avatar.glb']);
		expect(cache.entries.size).toBe(0);
	});

	it('returns empty when the Cache API is unavailable', async () => {
		delete globalThis.caches;
		expect(await takeSharedFiles()).toEqual({ files: [], meta: null });
	});

	it('SW output is readable by takeSharedFiles (full round trip)', async () => {
		const sw = loadServiceWorker(fakeCaches);
		const fd = fakeFormData();
		fd.append('media', glb());
		const ev = fakeFetchEvent({ formData: fd });
		sw.listeners.fetch(ev);
		await ev.response;
		const { files, meta } = await takeSharedFiles();
		expect(files).toHaveLength(1);
		expect(files[0].name).toBe('avatar.glb');
		expect(files[0].type).toBe('model/gltf-binary');
		expect(meta.count).toBe(1);
	});
});

describe('sharedIntent', () => {
	it('reads and strips the shared query param', () => {
		window.history.replaceState(null, '', '/create/selfie?shared=1&x=2');
		expect(sharedIntent()).toBe('1');
		clearSharedIntent();
		expect(sharedIntent()).toBeNull();
		expect(window.location.search).toBe('?x=2');
		window.history.replaceState(null, '', '/create?shared=glb');
		expect(sharedIntent()).toBe('glb');
		window.history.replaceState(null, '', '/create');
		expect(sharedIntent()).toBeNull();
	});
});
