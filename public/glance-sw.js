//
// Glance widget handlers, imported into the VitePWA-generated service worker
// via `workbox.importScripts` (see vite.config.js). Plain classic worker
// script (no imports) so importScripts can pull it in, same as
// push-sw.js and share-target-sw.js.
//
// This is the Windows 11 widgets board half of Glance. The manifest's
// `widgets` member declares the widget and points at the Adaptive Card
// template (/api/glance/template), but it fetches neither: it hands this
// worker the widget lifecycle and expects it to supply BOTH the card and the
// data it binds:
//
//   activate        this worker took over        -> re-render pinned slots
//   widgetinstall   the user pinned the widget   -> register refresh, render
//   widgetresume    the board woke up            -> render from cache, refresh
//   widgetclick     the host nudged an instance   -> refresh on demand
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
const GLANCE_TEMPLATE_KEY = '/_glance/template';
const GLANCE_DATA_URL = '/api/glance/mine';
const GLANCE_TEMPLATE_URL = '/api/glance/template';
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

async function readCachedText(key) {
	try {
		const cache = await caches.open(GLANCE_CACHE);
		const hit = await cache.match(key);
		return hit ? await hit.text() : null;
	} catch {
		return null;
	}
}

async function writeCachedText(key, body) {
	try {
		const cache = await caches.open(GLANCE_CACHE);
		await cache.put(key, new Response(body, { headers: { 'content-type': 'application/json' } }));
	} catch {
		/* a cache write failure must never break the render */
	}
}

async function readCachedPayload() {
	const text = await readCachedText(GLANCE_STATE_KEY);
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function writeCachedPayload(payload) {
	return writeCachedText(GLANCE_STATE_KEY, JSON.stringify(payload));
}

/**
 * The Adaptive Card the board renders the payload into. `msAcTemplate` is the
 * URL of the card, not the card itself, and the host fetches nothing on the
 * worker's behalf: the worker owns that fetch and hands `updateByTag` the card
 * text. It is static per deploy, so the last copy is kept beside the payload
 * and a board that wakes up offline still has something to render into.
 * @param {object|null} definition the widgetDefinition, absent on a click event
 */
async function loadTemplate(definition) {
	const url = (definition && definition.msAcTemplate) || GLANCE_TEMPLATE_URL;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(GLANCE_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`glance template ${res.status}`);
		const text = await res.text();
		await writeCachedText(GLANCE_TEMPLATE_KEY, text);
		return text;
	} catch {
		return readCachedText(GLANCE_TEMPLATE_KEY);
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
	const definition = (widget && widget.definition) || null;
	const tag = (definition && definition.tag) || GLANCE_TAG;
	const [payload, template] = await Promise.all([loadPayload(), loadTemplate(definition)]);
	if (!self.widgets) return payload;
	// No card means nothing to bind the data to. Leave whatever the slot already
	// holds rather than blanking it; the next resume tries the fetch again.
	if (!template) return payload;
	await self.widgets.updateByTag(tag, { template, data: JSON.stringify(payload) });
	return payload;
}

/**
 * The board refreshes nothing by itself: `update` in the manifest is a request,
 * and the worker is what honours it. The sync is registered under the widget's
 * own tag so the `periodicsync` handler can find the widget that woke it.
 */
async function registerGlanceSync(definition) {
	const sync = self.registration && self.registration.periodicSync;
	if (!sync || !definition || !('update' in definition)) return;
	try {
		const tags = await sync.getTags();
		if (tags.includes(definition.tag)) return;
		// The manifest counts seconds, the Periodic Background Sync API counts
		// milliseconds. The platform still clamps this to its own floor.
		await sync.register(definition.tag, { minInterval: Number(definition.update) * 1000 });
	} catch {
		/* the permission is the user's to grant; resume and click still refresh */
	}
}

self.addEventListener('activate', (event) => {
	// A widget pinned before this worker activated would otherwise sit empty
	// until the board next resumed it. Scoped to hosts that have the API, so a
	// browser with no widgets board pays nothing for this.
	event.waitUntil(
		(async () => {
			if (!self.widgets) return;
			await loadTemplate(null);
			const pinned = await self.widgets.matchAll({ tag: GLANCE_TAG });
			if (pinned.length) await renderGlanceWidget(pinned[0]);
		})(),
	);
});

self.addEventListener('widgetinstall', (event) => {
	event.waitUntil(
		(async () => {
			await registerGlanceSync(event.widget && event.widget.definition);
			await renderGlanceWidget(event.widget);
		})(),
	);
});

self.addEventListener('widgetresume', (event) => {
	event.waitUntil(renderGlanceWidget(event.widget));
});

self.addEventListener('widgetclick', (event) => {
	// The card's two actions are `Action.OpenUrl`, which the host opens itself
	// without telling the worker, so anything arriving here is a lifecycle nudge
	// and re-rendering is the right answer for all of them. `event.widget` is an
	// instance rather than a definition-bearing widget, which the render handles.
	event.waitUntil(renderGlanceWidget(event.widget));
});

self.addEventListener('widgetuninstall', (event) => {
	event.waitUntil(
		(async () => {
			const definition = event.widget && event.widget.definition;
			const instances = (event.widget && event.widget.instances) || [];
			const sync = self.registration && self.registration.periodicSync;
			// The last instance leaving is what ends the refresh; a board with a
			// second copy pinned still wants one.
			if (sync && definition && instances.length <= 1) {
				try {
					await sync.unregister(definition.tag);
				} catch {
					/* never registered, nothing to undo */
				}
			}
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
	// Other workers in this scope register their own syncs; this one is ours.
	if (event.tag !== GLANCE_TAG) return;
	event.waitUntil(
		(async () => {
			if (!self.widgets) return;
			const pinned = await self.widgets.matchAll({ tag: GLANCE_TAG });
			// `updateByTag` reaches every pinned instance, so one render is the
			// whole board.
			if (pinned.length) await renderGlanceWidget(pinned[0]);
		})(),
	);
});

// Exposed for tests (tests/glance-sw.test.js evaluates this file against a
// fake `self`) and for debugging from the service worker console.
self.__threewsGlancePayload = glancePayload;
self.__threewsGlanceRender = renderGlanceWidget;
self.__threewsGlanceTemplate = loadTemplate;
