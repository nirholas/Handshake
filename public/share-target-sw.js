//
// Web Share Target handler, imported into the VitePWA-generated service worker
// via `workbox.importScripts: ['/push-sw.js', '/share-target-sw.js']` (see
// vite.config.js). Kept as a plain classic worker script (no imports) so
// importScripts can pull it in.
//
// Flow: the manifest's `share_target` (and the Seeker TWA's `shareTarget` in
// solana-mobile/twa/twa-manifest.json) makes Android POST the shared files to
// /create/share as multipart/form-data. No server ever sees that request: this
// listener intercepts it, parks the files in the Cache API under
// `threews-share-target`, and 303-redirects to the creation flow that fits the
// first file. The page then calls `takeSharedFiles()` from
// src/shared/share-target.js, which drains the cache (one-shot handoff).

const SHARE_ACTION_PATH = '/create/share';
const SHARE_CACHE = 'threews-share-target';
const SHARE_KEY_PREFIX = '/_share/';
const SHARE_META_KEY = '/_share/meta';

/**
 * Pure routing decision: where a share with these files should land.
 * @param {Array<{ name?: string, type?: string }>} files
 * @returns {string}
 */
function shareTargetDestination(files) {
	if (!files || files.length === 0) return '/create';
	const first = files[0];
	if (isGlbFile(first)) return '/create?shared=glb';
	if (isImageFile(first)) return '/create/selfie?shared=1';
	return '/create?shared=1';
}

function isGlbFile(file) {
	const name = String(file?.name || '').toLowerCase();
	const type = String(file?.type || '').toLowerCase();
	return name.endsWith('.glb') || type === 'model/gltf-binary';
}

function isImageFile(file) {
	return /^image\//i.test(String(file?.type || ''));
}

function isShareTargetRequest(request) {
	if (!request || request.method !== 'POST') return false;
	try {
		return new URL(request.url).pathname === SHARE_ACTION_PATH;
	} catch {
		return false;
	}
}

async function stashSharedForm(formData) {
	const cache = await caches.open(SHARE_CACHE);
	// Drop anything a previous, unconsumed share left behind so indexes start
	// at zero and a stale file can never be mistaken for the new one.
	const stale = await cache.keys();
	await Promise.all(stale.map((req) => cache.delete(req)));

	const received = String(Date.now());
	const files = [];
	for (const entry of formData.getAll('media')) {
		if (!isFileLike(entry)) continue;
		const index = files.length;
		files.push({ name: entry.name, type: entry.type });
		await cache.put(
			`${SHARE_KEY_PREFIX}${index}`,
			new Response(entry, {
				headers: {
					'content-type': entry.type || 'application/octet-stream',
					'x-share-filename': entry.name || `shared-${index}`,
					'x-share-received': received,
				},
			}),
		);
	}

	const meta = {
		title: stringField(formData, 'title'),
		text: stringField(formData, 'text'),
		url: stringField(formData, 'url'),
		count: files.length,
		received: Number(received),
	};
	await cache.put(
		SHARE_META_KEY,
		new Response(JSON.stringify(meta), {
			headers: { 'content-type': 'application/json', 'x-share-received': received },
		}),
	);
	return files;
}

// Resolve the destination against the share request so the redirect carries
// the origin (Response.redirect refuses a bare path outside a window context).
function absolute(path, base) {
	return new URL(path, base).href;
}

function isFileLike(entry) {
	if (!entry || typeof entry === 'string') return false;
	return typeof entry === 'object' && typeof entry.size === 'number' && typeof entry.type === 'string';
}

function stringField(formData, key) {
	const v = formData.get(key);
	return typeof v === 'string' ? v : '';
}

self.addEventListener('fetch', (event) => {
	if (!isShareTargetRequest(event.request)) return;
	event.respondWith(
		(async () => {
			try {
				const formData = await event.request.formData();
				const files = await stashSharedForm(formData);
				return Response.redirect(absolute(shareTargetDestination(files), event.request.url), 303);
			} catch (err) {
				// Never let the share navigation fail: the page explains the miss.
				console.error('[share-target-sw] could not stash shared files', err);
				return Response.redirect(absolute('/create?shared=error', event.request.url), 303);
			}
		})(),
	);
});

// Exposed for tests (tests/share-target.test.js evaluates this file with a
// fake `self`) and for debugging from the SW console.
self.__threewsShareTargetDestination = shareTargetDestination;
