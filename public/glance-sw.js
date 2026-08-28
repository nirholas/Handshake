//
// Glance widget handlers, imported into the VitePWA-generated service worker
// via `workbox.importScripts` (see vite.config.js). Plain classic worker
// script (no imports) so importScripts can pull it in, same as
// push-sw.js and share-target-sw.js.
//
// This is the Windows 11 widgets board half of Glance. The manifest's
// `widgets` member declares the widget and points at the Adaptive Card
// template (/api/glance/template); the host then hands this worker the widget
// lifecycle and expects it to supply the data:
//
//   widgetinstall   the user pinned the widget   -> render it now
//   widgetresume    the board woke up            -> render from cache, refresh
//   widgetclick     a custom verb fired          -> refresh on demand
//   widgetuninstall the user removed it          -> drop the cached payload
//   periodicsync    the platform granted a tick  -> refresh every pinned widget
//
// The data comes from /api/glance/mine, which answers per session cookie, so a
// signed-out board renders a real "sign in" card instead of an error. The last
// good payload is kept in the Cache API: an offline device shows the card it
// last saw, with its own timestamp, rather than an empty slot.
//

const GLANCE_TAG = 'agent-glance';
const GLANCE_CACHE = 'threews-glance';
const GLANCE_STATE_KEY = '/_glance/state';
const GLANCE_DATA_URL = '/api/glance/mine';
const GLANCE_REFRESH_TAG = 'glance-refresh';
// A widget board is a background surface: a request that hangs there burns the
// platform's refresh budget and leaves the slot stale anyway.
const GLANCE_TIMEOUT_MS = 8000;

/**
 * Shape the widget payload from the /api/glance/mine response. Pure, so the
 * signed-out and empty states are testable without a network or a widget host.
 * @param {object|null} body
 * @param {{ offline?: boolean, at?: string }} [opts]
 */
function glancePayload(body, opts = {}) {
	const stamp = opts.at || new Date().toISOString();
	if (!body || body.signedIn === false) {
		return {
			name: 'Sign in to three.ws',
			headline: 'Sign in to put your agent on the home screen.',
			image: '/pwa-192x192.png',
			url: (body && body.signInUrl) || 'https://three.ws/login',
			createUrl: (body && body.createUrl) || 'https://three.ws/create',
			metric: { label: 'Moves today', value: '0' },
			stats: [
				{ label: 'This week', value: '0' },
				{ label: 'All time', value: '0' },
				{ label: 'Skills', value: '0' },
			],
			state: 'signed-out',
			updatedAt: stamp,
		};
	}
	if (!body.card) {
		return {
			name: 'No agent yet',
			headline: 'Create your first agent and it lands here.',
			image: '/pwa-192x192.png',
			url: body.createUrl || 'https://three.ws/create',
			createUrl: body.createUrl || 'https://three.ws/create',
			metric: { label: 'Moves today', value: '0' },
			stats: [
				{ label: 'This week', value: '0' },
				{ label: 'All time', value: '0' },
				{ label: 'Skills', value: '0' },
			],
			state: 'empty',
			updatedAt: stamp,
		};
	}
	const card = body.card;
	return {
		name: card.name,
		headline: opts.offline ? `${card.headline} (offline)` : card.headline,
		image: card.image || '/pwa-192x192.png',
		url: card.url,
		createUrl: card.createUrl || 'https://three.ws/create',
		metric: { label: card.metric.label, value: String(card.metric.value) },
		stats: (card.stats || []).map((s) => ({ label: s.label, value: String(s.value) })),
		state: opts.offline ? 'offline' : card.status,
		updatedAt: opts.at || card.updatedAt || stamp,
	};
}

async function readCachedPayload() {
	try {
		const cache = await caches.open(GLANCE_CACHE);
		const hit = await cache.match(GLANCE_STATE_KEY);
		return hit ? await hit.json() : null;
	} catch {
		return null;
	}
}

async function writeCachedPayload(payload) {
	try {
		const cache = await caches.open(GLANCE_CACHE);
		await cache.put(
			GLANCE_STATE_KEY,
			new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }),
		);
	} catch {
		/* a cache write failure must never break the render */
	}
}

/**
 * Fetch the live card, falling back to the last one this device saw. Returns
 * a payload every time: a widget slot always has something in it.
 */
async function loadPayload() {
	try {
		const res = await fetch(GLANCE_DATA_URL, {
			credentials: 'include',
			signal: AbortSignal.timeout(GLANCE_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`glance data ${res.status}`);
		const payload = glancePayload(await res.json());
		await writeCachedPayload(payload);
		return payload;
	} catch {
		const cached = await readCachedPayload();
		if (cached) return { ...cached, state: 'offline', headline: offlineHeadline(cached) };
		return glancePayload(null);
	}
}

function offlineHeadline(cached) {
	const base = String(cached.headline || '').replace(/ \(offline\)$/, '');
	return `${base} (offline)`;
}

/** Push the payload into every instance of the widget the host has pinned. */
async function renderGlanceWidget(widget) {
	const payload = await loadPayload();
	const tag = (widget && widget.definition && widget.definition.tag) || GLANCE_TAG;
	if (!self.widgets) return payload;
	await self.widgets.updateByTag(tag, {
		template: JSON.stringify(widget && widget.definition ? widget.definition.msAcTemplate : ''),
		data: JSON.stringify(payload),
	});
	return payload;
}

self.addEventListener('widgetinstall', (event) => {
	event.waitUntil(renderGlanceWidget(event.widget));
});

self.addEventListener('widgetresume', (event) => {
	event.waitUntil(renderGlanceWidget(event.widget));
});

self.addEventListener('widgetclick', (event) => {
	// `refresh` is the only verb the template declares; anything else is a host
	// lifecycle nudge and re-rendering is the right answer for both.
	event.waitUntil(renderGlanceWidget(event.widget));
});

self.addEventListener('widgetuninstall', (event) => {
	event.waitUntil(
		(async () => {
			try {
				const cache = await caches.open(GLANCE_CACHE);
				await cache.delete(GLANCE_STATE_KEY);
			} catch {
				/* nothing pinned, nothing to clean */
			}
		})(),
	);
});

self.addEventListener('periodicsync', (event) => {
	if (event.tag !== GLANCE_REFRESH_TAG) return;
	event.waitUntil(
		(async () => {
			if (!self.widgets) return;
			const pinned = await self.widgets.matchAll({ tag: GLANCE_TAG });
			await Promise.all(pinned.map((widget) => renderGlanceWidget(widget)));
		})(),
	);
});

// Exposed for tests (tests/glance-sw.test.js evaluates this file against a
// fake `self`) and for debugging from the service worker console.
self.__threewsGlancePayload = glancePayload;
self.__threewsGlanceRender = renderGlanceWidget;
