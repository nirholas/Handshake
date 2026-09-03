// The pool, against a real Home Assistant.
//
// The pure tests in tests/home-runtime.test.js prove the refcounting, the cap,
// the breaker and the eviction boundary with a fake bridge, because a working
// house cannot be asked to fail its next five connects on cue. What they cannot
// prove is the claim the whole module exists for: that a second call really
// rides the first WebSocket instead of opening another one against somebody's
// instance. That needs a real socket and a real house, so it lives here.
//
// Self-skipping. Point it at any instance:
//
//   node scripts/home-test-instance.mjs --up --onboard --seed --json
//   HOME_ASSISTANT_URL=http://127.0.0.1:<port> HOME_ASSISTANT_TOKEN=<token> \
//     npx vitest run tests/home-runtime-live.test.js
//
// Never mocked. A fake instance is what hid Home Assistant's own
// `intent__HassTurnOff` performing an UNLOCK on a lock, which is the single most
// important thing this lane learned.

import { afterAll, describe, expect, it } from 'vitest';

import { createHomeRuntime } from '../api/_lib/home/runtime.js';
import { HOME_STATUS } from '../api/_lib/home/store.js';
import { HomeBridge } from '@three-ws/home-bridge';

const BASE_URL = process.env.HOME_ASSISTANT_URL;
const TOKEN = process.env.HOME_ASSISTANT_TOKEN;
const live = BASE_URL && TOKEN ? describe : describe.skip;

const HOME_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';

/** Counts the sockets actually constructed, which is the measurement this file exists for. */
function countingFactory() {
	const built = [];
	const factory = (options) => {
		const bridge = new HomeBridge(options);
		built.push(bridge);
		return bridge;
	};
	factory.built = built;
	return factory;
}

/** The store, reduced to the reads the runtime performs, pointed at the live instance. */
function liveStoreDeps() {
	const handshakes = [];
	return {
		handshakes,
		getConnection: async (id, userId) =>
			id === HOME_ID && userId === USER_ID
				? { id, user_id: userId, label: 'Live', base_url: BASE_URL, status: HOME_STATUS.CONNECTED }
				: null,
		getDecryptedToken: async () => ({
			token: TOKEN,
			baseUrl: BASE_URL,
			transport: 'direct',
			relayId: null,
			fingerprint: 'live',
		}),
		listAllowedEntities: async () => [],
		recordHandshake: async (id, update) => {
			handshakes.push({ id, ...update });
			return null;
		},
	};
}

const runtimes = [];
function liveRuntime(extra = {}) {
	const createBridge = countingFactory();
	const deps = liveStoreDeps();
	const runtime = createHomeRuntime({ createBridge, ...deps, ...extra });
	runtimes.push(runtime);
	return { runtime, createBridge, deps };
}

afterAll(() => {
	// Leaving a socket open would hold the instance's connection slot after the
	// run, which is exactly the failure this module is here to prevent.
	for (const runtime of runtimes) runtime.closeAll();
});

live('home runtime, against a real Home Assistant', () => {
	it('opens one socket for two sequential withHome calls', async () => {
		const { runtime, createBridge } = liveRuntime();

		const first = await runtime.withHome(HOME_ID, USER_ID, (bridge) => ({
			rooms: bridge.graph.rooms.length,
			entities: Object.keys(bridge.states).length,
			version: bridge.haVersion,
		}));
		const second = await runtime.withHome(HOME_ID, USER_ID, (bridge) => ({
			rooms: bridge.graph.rooms.length,
			entities: Object.keys(bridge.states).length,
		}));

		// A real house answered, twice, with the same numbers.
		expect(first.entities).toBeGreaterThan(0);
		expect(second.entities).toBe(first.entities);
		expect(first.rooms).toBe(second.rooms);
		expect(first.version).toMatch(/^\d+\.\d+/);

		// And it did so over ONE socket. This assertion is the whole file.
		expect(createBridge.built).toHaveLength(1);
		expect(createBridge.built[0].connected).toBe(true);
		expect(runtime.stats().open).toBe(1);

		runtime.closeAll();
		expect(createBridge.built[0].connected).toBe(false);
	}, 60_000);

	it('records the handshake it measured, so the store never holds a guessed capability', async () => {
		const { runtime, deps } = liveRuntime();

		await runtime.withHome(HOME_ID, USER_ID, () => null);
		// The handshake write is fire and forget on purpose; give it a turn.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const recorded = deps.handshakes.find((h) => h.status === HOME_STATUS.CONNECTED);
		expect(recorded).toBeTruthy();
		expect(recorded.capabilities.websocket).toBe(true);
		expect(recorded.capabilities.entityCount).toBeGreaterThan(0);
		expect(recorded.capabilities.haVersion).toMatch(/^\d+\.\d+/);
		runtime.closeAll();
	}, 60_000);

	it('reopens after eviction, which is the cold path a recycled instance takes', async () => {
		let clock = 1_000_000;
		const { runtime, createBridge } = liveRuntime({ now: () => clock, idleMs: 1_000 });

		await runtime.withHome(HOME_ID, USER_ID, () => null);
		clock += 1_001;
		expect(runtime.evictIdle(clock)).toBe(1);
		expect(createBridge.built[0].connected).toBe(false);

		const rooms = await runtime.withHome(HOME_ID, USER_ID, (bridge) => bridge.graph.rooms.length);

		expect(createBridge.built).toHaveLength(2);
		expect(rooms).toBeGreaterThanOrEqual(0);
		runtime.closeAll();
	}, 60_000);

	it('holds one socket while a subscriber watches, and releases it when they leave', async () => {
		let clock = 1_000_000;
		const { runtime, createBridge } = liveRuntime({ now: () => clock, idleMs: 1_000 });

		const events = [];
		const unsubscribe = await runtime.subscribe(HOME_ID, USER_ID, (event) => events.push(event));

		expect(events).toHaveLength(1);
		expect(events[0].connected).toBe(true);
		expect(events[0].stale).toBe(false);
		expect(runtime.stats().subscribers).toBe(1);

		// A watched home is never evicted out from under the browser watching it.
		clock += 60_000;
		expect(runtime.evictIdle(clock)).toBe(0);

		unsubscribe();
		clock += 1_001;
		expect(runtime.evictIdle(clock)).toBe(1);
		expect(createBridge.built[0].connected).toBe(false);
	}, 60_000);

	it('fails a bad token as auth rather than as an unreachable house', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({
			createBridge,
			...liveStoreDeps(),
			getDecryptedToken: async () => ({
				token: 'not-a-real-token',
				baseUrl: BASE_URL,
				transport: 'direct',
				relayId: null,
				fingerprint: 'bad',
			}),
		});
		runtimes.push(runtime);

		// The two failures need different recovery text, so they must not collapse
		// into one code: "your house is offline" and "your token is wrong" send the
		// user to completely different places.
		await expect(runtime.acquire(HOME_ID, USER_ID)).rejects.toMatchObject({ code: 'auth' });
		expect(runtime.stats().open).toBe(0);
	}, 60_000);
});
