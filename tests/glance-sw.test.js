// The Windows 11 widget half of Glance: public/glance-sw.js evaluated as the
// real file text against a fake `self`, the same way tests/share-target.test.js
// exercises the share-target worker.
//
// What matters here is that a widget slot ALWAYS has something in it: signed
// out, no agent yet, and offline are three designed cards, not three errors.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SW_SOURCE = readFileSync(resolve(process.cwd(), 'public/glance-sw.js'), 'utf8');

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

/** Evaluate the worker source against a fake global and hand back its exports. */
function loadWorker({ fetchImpl } = {}) {
	const listeners = new Map();
	const updates = [];
	const self = {
		addEventListener: (type, fn) => listeners.set(type, fn),
		widgets: {
			updateByTag: async (tag, payload) => updates.push({ tag, payload }),
			matchAll: async () => [{ definition: { tag: 'agent-glance', msAcTemplate: '{}' } }],
		},
	};
	const caches = makeFakeCaches();
	const fn = new Function('self', 'caches', 'fetch', 'Response', 'AbortSignal', SW_SOURCE);
	fn(self, caches, fetchImpl || globalThis.fetch, Response, AbortSignal);
	return { self, listeners, updates, caches };
}

describe('glance widget worker', () => {
	let worker;
	beforeEach(() => {
		worker = loadWorker();
	});

	it('registers every widget lifecycle event the board fires', () => {
		expect([...worker.listeners.keys()].sort()).toEqual([
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
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
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
			}),
		}));
		const w = loadWorker({ fetchImpl });
		await w.self.__threewsGlanceRender({ definition: { tag: 'agent-glance', msAcTemplate: '{}' } });
		expect(fetchImpl).toHaveBeenCalledWith('/api/glance/mine', expect.objectContaining({ credentials: 'include' }));
		expect(w.updates).toHaveLength(1);
		expect(JSON.parse(w.updates[0].payload.data).name).toBe('Atlas Scout');
	});

	it('falls back to the last card this device saw when the network is gone', async () => {
		let online = true;
		const fetchImpl = vi.fn(async () => {
			if (!online) throw new Error('offline');
			return {
				ok: true,
				status: 200,
				json: async () => ({
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
				}),
			};
		});
		const w = loadWorker({ fetchImpl });
		const widget = { definition: { tag: 'agent-glance', msAcTemplate: '{}' } };
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
