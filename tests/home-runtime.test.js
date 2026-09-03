// The bridge runtime's pool, proved without a network.
//
// Every test here builds its OWN runtime through `createHomeRuntime` with a
// counting bridge factory and a controllable clock. Nothing touches the module's
// process-wide singleton, so these tests cannot leak pool state into each other
// and a failure names one behaviour rather than one ordering.
//
// What is deliberately NOT faked: Home Assistant itself. The live proof that a
// real socket is reused across two `withHome` calls lives in
// tests/home-runtime-live.test.js against a real instance. What is faked here is
// the bridge, because refcounting, idle eviction, the connection cap and the
// circuit breaker are exactly the paths a real house cannot be made to exercise
// on demand: you cannot ask a working Home Assistant to fail its next five
// connects at a chosen millisecond.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeRuntime, HOME_RUNTIME_ERR } from '../api/_lib/home/runtime.js';
import { HOME_STATUS } from '../api/_lib/home/store.js';

const HOME_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_HOME_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

/** A room graph with something in it, so "the graph was emptied" is visible. */
const LIVE_GRAPH = Object.freeze({
	floors: [{ id: 'ground', name: 'Ground floor' }],
	rooms: [{ id: 'kitchen', name: 'Kitchen', entities: ['light.kitchen'] }],
	unassigned: [],
});

/**
 * A bridge that behaves like the real one at its seams (connect resolves with a
 * graph, `on` returns an unsubscribe, close is idempotent) and lets a test drive
 * the events a real house would send.
 */
function makeFakeBridge(options, behaviour = {}) {
	const listeners = new Map();
	const bridge = {
		options,
		connected: false,
		closed: false,
		closeCount: 0,
		connectCount: 0,
		graph: LIVE_GRAPH,
		states: { 'light.kitchen': { state: 'on', attributes: {} } },
		haVersion: '2026.9.0',
		on(event, handler) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event).add(handler);
			return () => listeners.get(event)?.delete(handler);
		},
		emit(event, payload) {
			for (const handler of listeners.get(event) || []) handler(payload);
		},
		async connect() {
			bridge.connectCount += 1;
			if (behaviour.stall) await new Promise(() => {});
			if (behaviour.failWith) throw behaviour.failWith();
			bridge.connected = true;
			return bridge.graph;
		},
		close() {
			bridge.closed = true;
			bridge.closeCount += 1;
			bridge.connected = false;
		},
	};
	return bridge;
}

/** A factory that records every bridge it built, which is how socket reuse is counted. */
function countingFactory(behaviour = {}) {
	const built = [];
	const factory = (options) => {
		const bridge = makeFakeBridge(options, behaviour);
		built.push(bridge);
		return bridge;
	};
	factory.built = built;
	return factory;
}

/** A clock a test moves by hand, so eviction is asserted at its boundary rather than waited out. */
function fakeClock(start = 1_000_000) {
	let t = start;
	return {
		now: () => t,
		advance(ms) {
			t += ms;
			return t;
		},
	};
}

/** The store, reduced to the four reads the runtime actually performs. */
function storeDeps(overrides = {}) {
	const handshakes = [];
	const deps = {
		getConnection: vi.fn(async (id, userId) =>
			userId === USER_ID && (id === HOME_ID || id === OTHER_HOME_ID)
				? { id, user_id: userId, label: 'Home', base_url: 'https://home.example.com', status: HOME_STATUS.CONNECTED }
				: null,
		),
		getDecryptedToken: vi.fn(async (id) => ({
			token: 'llat-token',
			baseUrl: 'https://home.example.com',
			transport: 'direct',
			relayId: null,
			fingerprint: `fp-${id}`,
		})),
		listAllowedEntities: vi.fn(async () => ['lock.office_door']),
		recordHandshake: vi.fn(async (id, update) => {
			handshakes.push({ id, ...update });
			return null;
		}),
		...overrides,
	};
	deps.handshakes = handshakes;
	return deps;
}

describe('home runtime: the pool reuses one socket', () => {
	it('opens exactly one connection for two sequential withHome calls', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps() });

		const first = await runtime.withHome(HOME_ID, USER_ID, (bridge) => bridge.graph.rooms.length);
		const second = await runtime.withHome(HOME_ID, USER_ID, (bridge) => bridge.graph.rooms.length);

		expect(first).toBe(1);
		expect(second).toBe(1);
		// The whole point of the pool: the second call rode the first socket.
		expect(createBridge.built).toHaveLength(1);
		expect(createBridge.built[0].connectCount).toBe(1);
		expect(runtime.stats().open).toBe(1);
		runtime.closeAll();
	});

	it('passes the home standing grants to the bridge, so the gate knows what is pre-approved', async () => {
		const createBridge = countingFactory();
		const deps = storeDeps();
		const runtime = createHomeRuntime({ createBridge, ...deps });

		await runtime.withHome(HOME_ID, USER_ID, () => null);

		expect(deps.listAllowedEntities).toHaveBeenCalledWith(HOME_ID);
		expect(createBridge.built[0].options.allowedEntities).toEqual(['lock.office_door']);
		runtime.closeAll();
	});

	it('opens a separate connection per home', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps() });

		await runtime.withHome(HOME_ID, USER_ID, () => null);
		await runtime.withHome(OTHER_HOME_ID, USER_ID, () => null);

		expect(createBridge.built).toHaveLength(2);
		expect(runtime.stats().open).toBe(2);
		runtime.closeAll();
	});

	it('shares one in-flight open between two concurrent acquires', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps() });

		const [a, b] = await Promise.all([runtime.acquire(HOME_ID, USER_ID), runtime.acquire(HOME_ID, USER_ID)]);

		// A second caller arriving mid-open must not race a second socket to the
		// same house: that is two connections against one user's instance.
		expect(createBridge.built).toHaveLength(1);
		expect(a.bridge).toBe(b.bridge);
		a.release();
		b.release();
		runtime.closeAll();
	});
});

describe('home runtime: references are never leaked', () => {
	it('releases when the callback throws, so the socket becomes evictable', async () => {
		const createBridge = countingFactory();
		const clock = fakeClock();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps(), now: clock.now, idleMs: 90_000 });

		await expect(
			runtime.withHome(HOME_ID, USER_ID, () => {
				throw new Error('the tool call blew up');
			}),
		).rejects.toThrow('the tool call blew up');

		expect(runtime.stats().subscribers).toBe(0);
		// A held reference would survive this sweep. Being evicted IS the proof
		// that the refcount went back to zero.
		clock.advance(90_001);
		expect(runtime.evictIdle(clock.now())).toBe(1);
		expect(runtime.stats().open).toBe(0);
		expect(createBridge.built[0].closed).toBe(true);
	});

	it('is idempotent on release, so a double release cannot evict a live socket', async () => {
		const createBridge = countingFactory();
		const clock = fakeClock();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps(), now: clock.now, idleMs: 1_000 });

		const first = await runtime.acquire(HOME_ID, USER_ID);
		const second = await runtime.acquire(HOME_ID, USER_ID);
		first.release();
		first.release();
		first.release();

		// `second` is still holding it. A double release that decremented twice
		// would drop the count to zero and evict a connection somebody is using.
		clock.advance(5_000);
		expect(runtime.evictIdle(clock.now())).toBe(0);
		expect(runtime.stats().open).toBe(1);

		second.release();
		clock.advance(5_000);
		expect(runtime.evictIdle(clock.now())).toBe(1);
	});

	it('drops the reference when a subscriber unsubscribes', async () => {
		const createBridge = countingFactory();
		const clock = fakeClock();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps(), now: clock.now, idleMs: 1_000 });

		const events = [];
		const unsubscribe = await runtime.subscribe(HOME_ID, USER_ID, (event) => events.push(event));
		expect(runtime.stats().subscribers).toBe(1);

		clock.advance(5_000);
		expect(runtime.evictIdle(clock.now())).toBe(0);

		unsubscribe();
		unsubscribe();
		expect(runtime.stats().subscribers).toBe(0);
		clock.advance(5_000);
		expect(runtime.evictIdle(clock.now())).toBe(1);
	});
});

describe('home runtime: idle eviction at its boundary', () => {
	let createBridge;
	let clock;
	let runtime;

	beforeEach(async () => {
		createBridge = countingFactory();
		clock = fakeClock();
		runtime = createHomeRuntime({ createBridge, ...storeDeps(), now: clock.now, idleMs: 90_000 });
		const held = await runtime.acquire(HOME_ID, USER_ID);
		held.release();
	});

	it('keeps a connection one millisecond before the window closes', () => {
		clock.advance(89_999);
		expect(runtime.evictIdle(clock.now())).toBe(0);
		expect(runtime.stats().open).toBe(1);
		expect(createBridge.built[0].closed).toBe(false);
	});

	it('closes it at the window', () => {
		clock.advance(90_000);
		expect(runtime.evictIdle(clock.now())).toBe(1);
		expect(runtime.stats().open).toBe(0);
		expect(createBridge.built[0].closed).toBe(true);
	});

	it('reopens on the next acquire, which is the normal cold path and not an error', async () => {
		clock.advance(90_001);
		runtime.evictIdle(clock.now());

		await runtime.withHome(HOME_ID, USER_ID, (bridge) => bridge.graph);

		expect(createBridge.built).toHaveLength(2);
		expect(runtime.stats().open).toBe(1);
		runtime.closeAll();
	});

	it('never evicts a connection that still has a holder', async () => {
		const held = await runtime.acquire(HOME_ID, USER_ID);
		clock.advance(10 * 90_000);
		expect(runtime.evictIdle(clock.now())).toBe(0);
		held.release();
		clock.advance(90_001);
		expect(runtime.evictIdle(clock.now())).toBe(1);
	});
});

describe('home runtime: the connection cap degrades latency, never correctness', () => {
	it('serves a request past the cap without admitting it to the pool', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps(), maxConnections: 1 });

		const pooled = await runtime.acquire(HOME_ID, USER_ID);
		const overflow = await runtime.acquire(OTHER_HOME_ID, USER_ID);

		// The request is served: that is the correctness half.
		expect(overflow.bridge.connected).toBe(true);
		expect(runtime.stats().open).toBe(1);
		expect(runtime.stats().pooledCap).toBe(1);

		// And it closes the moment it is done, because nothing would ever evict it.
		overflow.release();
		expect(createBridge.built[1].closed).toBe(true);
		expect(createBridge.built[0].closed).toBe(false);

		pooled.release();
		runtime.closeAll();
	});
});

describe('home runtime: the circuit breaker', () => {
	function unreachableDeps() {
		return { ...storeDeps() };
	}

	it('opens after five consecutive failures and then fails fast', async () => {
		// A stalled connect is the expensive failure: without a breaker every page
		// load would wait out the full connect timeout.
		const createBridge = countingFactory({ stall: true });
		const deps = unreachableDeps();
		const runtime = createHomeRuntime({ createBridge, ...deps, connectTimeoutMs: 200 });

		for (let attempt = 1; attempt <= 5; attempt += 1) {
			await expect(runtime.acquire(HOME_ID, USER_ID)).rejects.toMatchObject({ code: 'unreachable' });
		}

		const startedAt = Date.now();
		await expect(runtime.acquire(HOME_ID, USER_ID)).rejects.toMatchObject({
			code: HOME_RUNTIME_ERR.BREAKER_OPEN,
		});
		const elapsed = Date.now() - startedAt;

		// The sixth attempt must not pay the 200 ms timeout, let alone the 15 s
		// production one. This assertion is the whole reason the breaker exists.
		expect(elapsed).toBeLessThan(50);
		expect(runtime.stats().breakersOpen).toBe(1);
		expect(createBridge.built).toHaveLength(5);
	}, 10_000);

	it('tells the store why, so the connect screen can explain it without a socket', async () => {
		const createBridge = countingFactory({ stall: true });
		const deps = unreachableDeps();
		const runtime = createHomeRuntime({ createBridge, ...deps, connectTimeoutMs: 100 });

		for (let attempt = 1; attempt <= 5; attempt += 1) {
			await runtime.acquire(HOME_ID, USER_ID).catch(() => null);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));

		const last = deps.handshakes.at(-1);
		expect(last.status).toBe(HOME_STATUS.UNREACHABLE);
		expect(last.statusDetail).toContain('paused retries for five minutes');
	}, 10_000);

	it('closes again once the cooldown expires and the house answers', async () => {
		const clock = fakeClock();
		let stalled = true;
		const built = [];
		const createBridge = (options) => {
			const bridge = makeFakeBridge(options, { get stall() { return stalled; } });
			built.push(bridge);
			return bridge;
		};
		const runtime = createHomeRuntime({ createBridge, ...storeDeps(), now: clock.now, connectTimeoutMs: 100 });

		for (let attempt = 1; attempt <= 5; attempt += 1) {
			await runtime.acquire(HOME_ID, USER_ID).catch(() => null);
		}
		await expect(runtime.acquire(HOME_ID, USER_ID)).rejects.toMatchObject({ code: HOME_RUNTIME_ERR.BREAKER_OPEN });

		clock.advance(5 * 60_000 + 1);
		stalled = false;
		const held = await runtime.acquire(HOME_ID, USER_ID);

		expect(held.bridge.connected).toBe(true);
		// A success clears the counter outright: the next outage starts from zero
		// rather than tripping on its first failure.
		expect(runtime.stats().breakersOpen).toBe(0);
		held.release();
		runtime.closeAll();
	}, 10_000);
});

describe('home runtime: the graph goes stale, never empty', () => {
	it('keeps the last good graph when the socket drops, and marks it stale', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps() });

		const events = [];
		await runtime.subscribe(HOME_ID, USER_ID, (event) => events.push(event));
		const bridge = createBridge.built[0];

		expect(events).toHaveLength(1);
		expect(events[0].graph.rooms).toHaveLength(1);
		expect(events[0].stale).toBe(false);

		bridge.connected = false;
		bridge.emit('disconnected');

		const afterDrop = events.at(-1);
		expect(afterDrop.stale).toBe(true);
		expect(afterDrop.connected).toBe(false);
		// The house must not vanish from the 3D scene because a socket blinked.
		expect(afterDrop.graph.rooms).toHaveLength(1);
		expect(afterDrop.graph).toEqual(LIVE_GRAPH);
		runtime.closeAll();
	});

	it('comes back live on reconnect with no action from the client', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps() });

		const events = [];
		await runtime.subscribe(HOME_ID, USER_ID, (event) => events.push(event));
		const bridge = createBridge.built[0];

		bridge.emit('disconnected');
		bridge.connected = true;
		bridge.emit('reconnected');

		expect(events.at(-1).stale).toBe(false);
		expect(events.at(-1).connected).toBe(true);
		runtime.closeAll();
	});

	it('refuses to replace a real graph with nothing', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps() });

		const events = [];
		await runtime.subscribe(HOME_ID, USER_ID, (event) => events.push(event));
		const bridge = createBridge.built[0];

		bridge.emit('graph', null);

		expect(events.at(-1).graph).toEqual(LIVE_GRAPH);
		runtime.closeAll();
	});

	it('survives a subscriber that throws, and keeps serving the others', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps() });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const good = [];
		await runtime.subscribe(HOME_ID, USER_ID, () => {
			throw new Error('a dead SSE stream');
		});
		await runtime.subscribe(HOME_ID, USER_ID, (event) => good.push(event));
		createBridge.built[0].emit('disconnected');

		expect(good.at(-1).stale).toBe(true);
		warn.mockRestore();
		runtime.closeAll();
	});
});

describe('home runtime: snapshot', () => {
	it('returns the graph without holding the connection open past the call', async () => {
		const createBridge = countingFactory();
		const clock = fakeClock();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps(), now: clock.now, idleMs: 1_000 });

		const result = await runtime.snapshot(HOME_ID, USER_ID);

		expect(result.graph.rooms).toHaveLength(1);
		expect(result.connected).toBe(true);
		expect(result.stale).toBe(false);
		expect(result.status).toBe(HOME_STATUS.CONNECTED);

		clock.advance(1_001);
		expect(runtime.evictIdle(clock.now())).toBe(1);
	});
});

describe('home runtime: failures a user can act on', () => {
	it('reports a home that is not this account’s as not found, never as forbidden', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({
			createBridge,
			...storeDeps({ getConnection: vi.fn(async () => null) }),
		});

		await expect(runtime.acquire(HOME_ID, 'someone-else')).rejects.toMatchObject({
			code: HOME_RUNTIME_ERR.NOT_FOUND,
		});
		// Nothing was opened for a home the caller does not own.
		expect(createBridge.built).toHaveLength(0);
	});

	it('reports a disconnected home as revoked rather than as a broken socket', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({
			createBridge,
			...storeDeps({ getDecryptedToken: vi.fn(async () => null) }),
		});

		await expect(runtime.acquire(HOME_ID, USER_ID)).rejects.toMatchObject({
			code: HOME_RUNTIME_ERR.REVOKED,
		});
		expect(createBridge.built).toHaveLength(0);
	});

	it('turns an unreadable credential into "reconnect your home", and marks the row', async () => {
		const createBridge = countingFactory();
		const deps = storeDeps({
			getDecryptedToken: vi.fn(async () => {
				throw new Error('unsupported state or unable to authenticate data');
			}),
		});
		const runtime = createHomeRuntime({ createBridge, ...deps });

		await expect(runtime.acquire(HOME_ID, USER_ID)).rejects.toMatchObject({ code: 'auth' });
		expect(deps.handshakes.at(-1)).toMatchObject({ status: HOME_STATUS.AUTH_FAILED });
		expect(createBridge.built).toHaveLength(0);
	});
});

describe('home runtime: what the health probe reads', () => {
	it('reports open connections, subscribers, the cap and a status breakdown', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps(), maxConnections: 42 });

		await runtime.subscribe(HOME_ID, USER_ID, () => {});
		await runtime.subscribe(HOME_ID, USER_ID, () => {});
		const held = await runtime.acquire(OTHER_HOME_ID, USER_ID);

		const snapshot = runtime.stats();
		expect(snapshot).toMatchObject({
			open: 2,
			subscribers: 2,
			pooledCap: 42,
			breakersOpen: 0,
			byStatus: { [HOME_STATUS.CONNECTED]: 2 },
		});

		// The backpressure ladder rides along, because an operator asking "is this
		// instance full" and an operator asking "how many homes are open" are the
		// same person one second apart.
		expect(snapshot.admission).toMatchObject({
			rung: 'normal',
			pooled: 2,
			unpooled: 0,
			streams: 2,
			databaseHealthy: true,
		});
		expect(snapshot.admission.limits.maxPooled).toBe(42);

		held.release();
		runtime.closeAll();
	});

	it('counts a dropped home under its real status, not under connected', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps() });

		const held = await runtime.acquire(HOME_ID, USER_ID);
		createBridge.built[0].emit('disconnected');

		expect(runtime.stats().byStatus).toEqual({ [HOME_STATUS.UNREACHABLE]: 1 });
		held.release();
		runtime.closeAll();
	});
});

describe('home runtime: shutdown', () => {
	it('closes every socket the process holds, so the house is not left with dead connections', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps() });

		const a = await runtime.acquire(HOME_ID, USER_ID);
		const b = await runtime.acquire(OTHER_HOME_ID, USER_ID);

		expect(runtime.closeAll()).toBe(2);
		expect(a.bridge.closed).toBe(true);
		expect(b.bridge.closed).toBe(true);
		expect(runtime.stats().open).toBe(0);
	});

	it('is safe to call twice', async () => {
		const createBridge = countingFactory();
		const runtime = createHomeRuntime({ createBridge, ...storeDeps() });

		await runtime.acquire(HOME_ID, USER_ID);
		expect(runtime.closeAll()).toBe(1);
		expect(runtime.closeAll()).toBe(0);
		expect(createBridge.built[0].closeCount).toBe(1);
	});
});
