// The Windows 11 widget half of Glance: public/glance-sw.js evaluated as the
// real file text against a fake `self`, the same way tests/share-target.test.js
// exercises the share-target worker.
//
// What matters here is that a widget slot ALWAYS has something in it: signed
// out, no agent yet, and offline are three designed cards, not three errors.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adaptiveTemplate } from '../api/_lib/glance-adaptive.js';

const SW_SOURCE = readFileSync(resolve(process.cwd(), 'public/glance-sw.js'), 'utf8');

// What the board actually holds: `msAcTemplate` is the URL of the card, so the
// worker has to fetch it. A test that hands the worker the card inline would
// pass while the real board rendered an empty slot.
const TEMPLATE_URL = '/api/glance/template';
const TEMPLATE_TEXT = JSON.stringify({ type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: '${name}' }] });
const DEFINITION = { tag: 'agent-glance', msAcTemplate: TEMPLATE_URL, update: 900 };

/** A widget's two fetches: the card template as text, the data as JSON. */
function makeFetch(data, { template = TEMPLATE_TEXT, offline = () => false } = {}) {
	return vi.fn(async (url) => {
		if (offline(String(url))) throw new Error('offline');
		if (String(url).includes('/template')) {
			if (template === null) return { ok: false, status: 503, text: async () => '' };
			return { ok: true, status: 200, text: async () => template };
		}
		return { ok: true, status: 200, json: async () => (typeof data === 'function' ? data() : data) };
	});
}

function makeFakeCaches() {
	const stores = new Map();
	class FakeCache {
		constructor() {
			this.entries = new Map();
		}
		async put(key, res) {
			this.entries.set(String(key), res);
		}
		async match(key) {
			return this.entries.get(String(key));
		}
		async delete(key) {
			return this.entries.delete(String(key));
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

/**
 * Fire a worker lifecycle event and wait for the work it handed to `waitUntil`,
 * which is the only handle the real host has on it too.
 */
async function fire(worker, type, event = {}) {
	const pending = [];
	await worker.listeners.get(type)({ ...event, waitUntil: (p) => pending.push(p) });
	await Promise.all(pending);
}

/** Evaluate the worker source against a fake global and hand back its exports. */
function loadWorker({ fetchImpl, pinned = [{ definition: DEFINITION, instances: [{ id: 'a' }] }] } = {}) {
	const listeners = new Map();
	const updates = [];
	const syncTags = [];
	const syncRegistrations = [];
	const self = {
		addEventListener: (type, fn) => listeners.set(type, fn),
		registration: {
			periodicSync: {
				getTags: async () => [...syncTags],
				register: async (tag, options) => {
					syncTags.push(tag);
					syncRegistrations.push({ tag, ...options });
				},
				unregister: async (tag) => {
					const at = syncTags.indexOf(tag);
					if (at >= 0) syncTags.splice(at, 1);
				},
			},
		},
		widgets: {
			updateByTag: async (tag, payload) => updates.push({ tag, payload }),
			matchAll: async ({ tag } = {}) => pinned.filter((w) => !tag || w.definition.tag === tag),
		},
	};
	const caches = makeFakeCaches();
	const fn = new Function('self', 'caches', 'fetch', 'Response', 'AbortSignal', SW_SOURCE);
	fn(self, caches, fetchImpl || globalThis.fetch, Response, AbortSignal);
	return { self, listeners, updates, caches, syncTags, syncRegistrations };
}

describe('glance widget worker', () => {
	let worker;
	beforeEach(() => {
		worker = loadWorker();
	});

	it('registers every widget lifecycle event the board fires', () => {
		expect([...worker.listeners.keys()].sort()).toEqual([
			'activate',
			'periodicsync',
			'widgetclick',
			'widgetinstall',
			'widgetresume',
			'widgetuninstall',
		]);
	});

	it('renders a sign-in card rather than an error when nobody is signed in', () => {
		const payload = worker.self.__threewsGlancePayload({ signedIn: false, signInUrl: 'https://three.ws/login' });
		expect(payload.state).toBe('signed-out');
		expect(payload.name).toMatch(/sign in/i);
		expect(payload.url).toBe('https://three.ws/login');
		expect(payload.metric.value).toBe('0');
	});

	it('invites the owner to create one when the account has no agent yet', () => {
		const payload = worker.self.__threewsGlancePayload({ signedIn: true, card: null, createUrl: 'https://three.ws/create' });
		expect(payload.state).toBe('empty');
		expect(payload.headline).toMatch(/create your first agent/i);
		expect(payload.url).toBe('https://three.ws/create');
	});

	it('carries the live card through with every value stringified for the host', () => {
		const payload = worker.self.__threewsGlancePayload({
			signedIn: true,
			card: {
				name: 'Atlas Scout',
				headline: 'Working.',
				image: 'https://cdn.example/thumb.png',
				url: 'https://three.ws/agents/abc',
				status: 'active',
				metric: { label: 'Moves today', value: 17 },
				stats: [{ label: 'This week', value: 96 }],
				updatedAt: '2026-08-28T12:00:00.000Z',
			},
		});
		expect(payload.state).toBe('active');
		expect(payload.metric).toEqual({ label: 'Moves today', value: '17' });
		expect(payload.stats).toEqual([{ label: 'This week', value: '96' }]);
		expect(payload.image).toBe('https://cdn.example/thumb.png');
	});

	it('marks a card offline instead of blanking the slot', () => {
		const payload = worker.self.__threewsGlancePayload(
			{
				signedIn: true,
				card: {
					name: 'Atlas Scout',
					headline: 'Working.',
					image: null,
					url: 'https://three.ws/agents/abc',
					status: 'active',
					metric: { label: 'Moves today', value: 3 },
					stats: [],
				},
			},
			{ offline: true },
		);
		expect(payload.state).toBe('offline');
		expect(payload.headline).toBe('Working. (offline)');
		expect(payload.image).toBe('/pwa-192x192.png');
	});

	it('pushes the fetched card into the host on install', async () => {
		const fetchImpl = makeFetch({
			signedIn: true,
			card: {
				name: 'Atlas Scout',
				headline: 'Working.',
				image: null,
				url: 'https://three.ws/agents/abc',
				status: 'active',
				metric: { label: 'Moves today', value: 5 },
				stats: [],
			},
		});
		const w = loadWorker({ fetchImpl });
		await w.self.__threewsGlanceRender({ definition: DEFINITION });
		expect(fetchImpl).toHaveBeenCalledWith('/api/glance/mine', expect.objectContaining({ credentials: 'include' }));
		expect(w.updates).toHaveLength(1);
		expect(JSON.parse(w.updates[0].payload.data).name).toBe('Atlas Scout');
	});

	// The bug this pins: the worker used to send `JSON.stringify(msAcTemplate)`,
	// so the host got the string "/api/glance/template" where the card belonged
	// and every pinned slot rendered empty.
	it('sends the host the fetched card, not the URL it came from', async () => {
		const fetchImpl = makeFetch({ signedIn: false });
		const w = loadWorker({ fetchImpl });
		await w.self.__threewsGlanceRender({ definition: DEFINITION });
		expect(fetchImpl).toHaveBeenCalledWith(TEMPLATE_URL, expect.anything());
		const { template } = w.updates[0].payload;
		expect(template).toBe(TEMPLATE_TEXT);
		expect(JSON.parse(template).type).toBe('AdaptiveCard');
	});

	it('serves the card from cache when the template endpoint is unreachable', async () => {
		let reachable = true;
		const w = loadWorker({
			fetchImpl: makeFetch({ signedIn: false }, { offline: (url) => !reachable && url.includes('/template') }),
		});
		await w.self.__threewsGlanceRender({ definition: DEFINITION });
		reachable = false;
		await w.self.__threewsGlanceRender({ definition: DEFINITION });
		expect(w.updates).toHaveLength(2);
		expect(w.updates[1].payload.template).toBe(TEMPLATE_TEXT);
	});

	it('leaves the slot alone rather than blanking it when no card can be had', async () => {
		const w = loadWorker({ fetchImpl: makeFetch({ signedIn: false }, { template: null }) });
		await w.self.__threewsGlanceRender({ definition: DEFINITION });
		expect(w.updates).toHaveLength(0);
	});

	it('falls back to the known endpoint when the event carries no definition', async () => {
		const fetchImpl = makeFetch({ signedIn: false });
		const w = loadWorker({ fetchImpl });
		// widgetclick hands over a widgetInstance, which has no `definition`.
		await w.self.__threewsGlanceRender({ id: 'instance-1' });
		expect(fetchImpl).toHaveBeenCalledWith(TEMPLATE_URL, expect.anything());
		expect(w.updates[0].tag).toBe('agent-glance');
	});

	it('registers the refresh the manifest asks for, in milliseconds', async () => {
		const w = loadWorker({ fetchImpl: makeFetch({ signedIn: false }) });
		await fire(w, 'widgetinstall', { widget: { definition: DEFINITION } });
		expect(w.syncRegistrations).toEqual([{ tag: 'agent-glance', minInterval: 900_000 }]);
		// Pinning a second copy must not stack a second sync on the same tag.
		await fire(w, 'widgetinstall', { widget: { definition: DEFINITION } });
		expect(w.syncRegistrations).toHaveLength(1);
	});

	it('drops the refresh only when the last instance leaves', async () => {
		const w = loadWorker({ fetchImpl: makeFetch({ signedIn: false }) });
		await fire(w, 'widgetinstall', { widget: { definition: DEFINITION } });
		await fire(w, 'widgetuninstall', { widget: { definition: DEFINITION, instances: [{ id: 'a' }, { id: 'b' }] } });
		expect(w.syncTags).toEqual(['agent-glance']);
		await fire(w, 'widgetuninstall', { widget: { definition: DEFINITION, instances: [{ id: 'a' }] } });
		expect(w.syncTags).toEqual([]);
	});

	it('answers its own periodic sync tag and ignores the rest', async () => {
		const w = loadWorker({ fetchImpl: makeFetch({ signedIn: false }) });
		await fire(w, 'periodicsync', { tag: 'push-retry' });
		expect(w.updates).toHaveLength(0);
		await fire(w, 'periodicsync', { tag: 'agent-glance' });
		expect(w.updates).toHaveLength(1);
	});

	it('re-renders a slot pinned before this worker activated', async () => {
		const w = loadWorker({ fetchImpl: makeFetch({ signedIn: false }) });
		await fire(w, 'activate');
		expect(w.updates).toHaveLength(1);
	});

	it('falls back to the last card this device saw when the network is gone', async () => {
		let online = true;
		const fetchImpl = makeFetch(
			{
				signedIn: true,
				card: {
					name: 'Atlas Scout',
					headline: 'Working.',
					image: null,
					url: 'https://three.ws/agents/abc',
					status: 'active',
					metric: { label: 'Moves today', value: 9 },
					stats: [],
				},
			},
			{ offline: () => !online },
		);
		const w = loadWorker({ fetchImpl });
		const widget = { definition: DEFINITION };
		await w.self.__threewsGlanceRender(widget);

		online = false;
		await w.self.__threewsGlanceRender(widget);
		const last = JSON.parse(w.updates.at(-1).payload.data);
		expect(last.name).toBe('Atlas Scout');
		expect(last.state).toBe('offline');
		expect(last.headline).toBe('Working. (offline)');
	});

	it('bounds the data fetch so a stalled network cannot hold the board', () => {
		expect(SW_SOURCE).toMatch(/AbortSignal\.timeout\(GLANCE_TIMEOUT_MS\)/);
	});
});

// The board binds the server's card to the worker's payload, and neither half
// can see the other: a template that names a field the worker stopped sending
// renders an empty row on the widgets board and nowhere else, which is the one
// surface no test machine here has. So the two shapes are checked against each
// other directly.
describe('the card the board renders binds to the payload the worker sends', () => {
	/** Every `${...}` in the template, as a path plus whether it has a fallback. */
	function bindings(node, found = []) {
		if (typeof node === 'string') {
			const match = node.match(/^\$\{(?:if\((?<guarded>[\w.]+),|(?<plain>[\w.]+)\})/);
			if (match) {
				const path = match.groups.plain || match.groups.guarded;
				found.push({ path, optional: Boolean(match.groups.guarded) });
			}
			return found;
		}
		if (Array.isArray(node)) {
			for (const item of node) bindings(item, found);
			return found;
		}
		if (node && typeof node === 'object') {
			for (const value of Object.values(node)) bindings(value, found);
		}
		return found;
	}

	const resolvePath = (payload, path) =>
		path.split('.').reduce((at, key) => (at === undefined || at === null ? undefined : at[key]), payload);

	const template = adaptiveTemplate();
	const bound = bindings(template);

	const AGENT = {
		signedIn: true,
		card: {
			name: 'Atlas Scout',
			headline: 'Working.',
			image: 'https://cdn.example/thumb.png',
			url: 'https://three.ws/agents/abc',
			status: 'active',
			metric: { label: 'Moves today', value: 17 },
			// The server sends exactly three, always: api/_lib/glance-card.js fills
			// the third with "Days live" when the agent has no skills yet.
			stats: [
				{ label: 'This week', value: 96 },
				{ label: 'All time', value: 400 },
				{ label: 'Days live', value: 12 },
			],
			updatedAt: '2026-09-04T12:00:00.000Z',
		},
	};

	it('reads a binding for every field the card draws', () => {
		// `name` binds twice, as the title and as the image's alt text.
		expect([...new Set(bound.map((b) => b.path))].sort()).toEqual([
			'createUrl',
			'headline',
			'image',
			'metric.label',
			'metric.value',
			'name',
			'stats.0.label',
			'stats.0.value',
			'stats.1.label',
			'stats.1.value',
			'stats.2.label',
			'stats.2.value',
			'url',
		]);
	});

	it.each([
		['signed out', { signedIn: false, signInUrl: 'https://three.ws/login' }],
		['no agent yet', { signedIn: true, card: null, createUrl: 'https://three.ws/create' }],
		['a live agent', AGENT],
	])('resolves every required binding for %s', (_label, body) => {
		const payload = loadWorker().self.__threewsGlancePayload(body);
		const missing = bound
			.filter((b) => !b.optional && resolvePath(payload, b.path) === undefined)
			.map((b) => b.path);
		expect(missing).toEqual([]);
	});

	it('fills the third fact slot rather than leaving the card ragged', () => {
		const payload = loadWorker().self.__threewsGlancePayload(AGENT);
		expect(payload.stats).toHaveLength(3);
		expect(payload.stats[2]).toEqual({ label: 'Days live', value: '12' });
	});
});
