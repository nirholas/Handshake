// The backpressure ladder, rung by rung, plus the one property that must hold
// at every rung: a saturated instance never waves a guarded action through.
//
// The controller is a pure counter with no timers and no I/O, which is exactly
// why the safety property is testable exhaustively here rather than argued about
// in a design document. The load-and-chaos runs in tasks/home/ prove it again
// against real Home Assistant containers; this file proves it at every state the
// controller can reach.

import { describe, expect, it, vi } from 'vitest';

import {
	ADMISSION_DEFAULTS,
	createAdmissionController,
	describeLadder,
	READ_SOURCE,
	requiresConfirmation,
	RUNG,
} from '../api/_lib/home/admission.js';
import { createHomeRuntime, HOME_RUNTIME_ERR } from '../api/_lib/home/runtime.js';
import { HOME_STATUS } from '../api/_lib/home/store.js';

const HOME_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_HOME_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_HOME_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '33333333-3333-4333-8333-333333333333';

const small = (over = {}) =>
	createAdmissionController({ maxPooled: 4, maxUnpooled: 2, maxStreams: 6, maxInflightActions: 8, ...over });

describe('the ladder, rung by rung', () => {
	it('rung 1: hands out pooled connections under the cap', () => {
		const admission = small();
		for (let i = 0; i < 4; i++) {
			const slot = admission.acquire();
			expect(slot).toMatchObject({ admitted: true, rung: RUNG.NORMAL, connection: 'pooled' });
		}
		expect(admission.snapshot()).toMatchObject({ pooled: 4, unpooled: 0, rung: RUNG.UNPOOLED });
	});

	it('rung 2: past the cap the connection is unpooled, and it is still a connection', () => {
		const admission = small();
		for (let i = 0; i < 4; i++) admission.acquire();

		const overflow = admission.acquire();
		expect(overflow.admitted).toBe(true);
		expect(overflow.connection).toBe('unpooled');
		expect(overflow.rung).toBe(RUNG.UNPOOLED);
		// It says so in words a user can read, because this is the rung where the
		// product gets slower and somebody has to be told why.
		expect(overflow.reason).toMatch(/short-lived/i);
		expect(admission.snapshot().counters.unpooledOpened).toBe(1);
	});

	it('rung 2: releasing gives the capacity back to the right pool', () => {
		const admission = small();
		for (let i = 0; i < 4; i++) admission.acquire();
		admission.acquire();
		expect(admission.snapshot()).toMatchObject({ pooled: 4, unpooled: 1 });

		admission.release('unpooled');
		expect(admission.snapshot()).toMatchObject({ pooled: 4, unpooled: 0 });
		admission.release('pooled');
		expect(admission.snapshot()).toMatchObject({ pooled: 3, unpooled: 0, rung: RUNG.NORMAL });
	});

	it('rung 3: with the database down, reads come from the live graph and writes still go through', () => {
		const admission = small();
		expect(admission.admitRead()).toMatchObject({ admitted: true, source: READ_SOURCE.DATABASE });

		admission.setDatabaseHealthy(false);
		const read = admission.admitRead();
		expect(read).toMatchObject({ admitted: true, rung: RUNG.DEGRADED_READ, source: READ_SOURCE.GRAPH });

		// The half that matters: a write is somebody pressing a button and is
		// attempted regardless. Only its audit row waits.
		expect(admission.writePolicy()).toEqual({ attempt: true, persistAudit: false });
		expect(admission.admitAction({ guarded: false }).admitted).toBe(true);

		admission.setDatabaseHealthy(true);
		expect(admission.writePolicy()).toEqual({ attempt: true, persistAudit: true });
	});

	it('rung 4: a stream is shed while an action at the same instant is still admitted', () => {
		const admission = small({ streamYieldRatio: 0.5 });
		// Below the yield floor, both are served.
		for (let i = 0; i < 3; i++) admission.admitAction({ guarded: false });
		expect(admission.admitStream().admitted).toBe(true);

		// At the floor (4 of 8 in flight), the dashboard yields to the door.
		admission.admitAction({ guarded: false });
		const stream = admission.admitStream();
		const action = admission.admitAction({ guarded: false });

		expect(stream.admitted).toBe(false);
		expect(stream.rung).toBe(RUNG.SHED_STREAMS);
		expect(stream.retryAfterSeconds).toBeGreaterThan(0);
		expect(action.admitted).toBe(true);
	});

	it('rung 4: streams also stop at their own ceiling, independent of actions', () => {
		const admission = small();
		for (let i = 0; i < 6; i++) expect(admission.admitStream().admitted).toBe(true);
		expect(admission.admitStream()).toMatchObject({ admitted: false, rung: RUNG.SHED_STREAMS });
		admission.closeStream();
		expect(admission.admitStream().admitted).toBe(true);
	});

	it('rung 5: a full instance refuses with a retry-after instead of hanging', () => {
		const admission = small();
		for (let i = 0; i < 8; i++) admission.admitAction({ guarded: false });

		const shed = admission.admitAction({ guarded: false });
		expect(shed).toMatchObject({ admitted: false, rung: RUNG.SHED });
		expect(shed.retryAfterSeconds).toBe(ADMISSION_DEFAULTS.retryAfterSeconds);
		// Nothing half applied: the refusal is BEFORE anything was sent to a house.
		expect(shed.reason).toMatch(/nothing was sent to your home/i);

		admission.finishAction();
		expect(admission.admitAction({ guarded: false }).admitted).toBe(true);
	});

	it('rung 5: acquisition refuses once even the overflow is gone', () => {
		const admission = small();
		for (let i = 0; i < 6; i++) admission.acquire();
		const refused = admission.acquire();
		expect(refused).toMatchObject({ admitted: false, rung: RUNG.SHED, connection: null });
		expect(refused.retryAfterSeconds).toBeGreaterThan(0);
		expect(admission.snapshot().counters.acquisitionsShed).toBe(1);
	});

	it('the ladder describes itself from the same numbers it enforces', () => {
		const rows = describeLadder({ maxPooled: 4, maxInflightActions: 8, streamYieldRatio: 0.5, maxStreams: 6 });
		expect(rows.map((r) => r.id)).toEqual([RUNG.NORMAL, RUNG.UNPOOLED, RUNG.DEGRADED_READ, RUNG.SHED_STREAMS, RUNG.SHED]);
		expect(rows[3].trigger).toContain('4 of 8');
		expect(rows[1].trigger).toContain('4');
	});

	it('refuses to be built with a nonsense limit rather than silently admitting everything', () => {
		expect(() => createAdmissionController({ maxPooled: -1 })).toThrow(/maxPooled/);
		expect(() => createAdmissionController({ maxStreams: Number.NaN })).toThrow(/maxStreams/);
	});
});

describe('the gate never degrades', () => {
	it('demands a human for a guarded action at every rung the controller can reach', () => {
		const admission = small({ streamYieldRatio: 0.25 });
		const rungsSeen = new Set();

		// Walk the whole state space this controller has: every combination of
		// connections held, streams open, actions in flight and database health.
		for (let pooled = 0; pooled <= 6; pooled++) {
			for (let streams = 0; streams <= 6; streams++) {
				for (let inflight = 0; inflight <= 8; inflight++) {
					for (const healthy of [true, false]) {
						const probe = small({ streamYieldRatio: 0.25 });
						probe.setDatabaseHealthy(healthy);
						for (let i = 0; i < pooled; i++) probe.acquire();
						for (let i = 0; i < streams; i++) probe.admitStream();
						for (let i = 0; i < inflight; i++) probe.admitAction({ guarded: false });

						const verdict = probe.admitAction({ guarded: true, confirmed: false });
						rungsSeen.add(verdict.rung);
						expect(verdict.requiresConfirmation).toBe(true);
					}
				}
			}
		}

		// The sweep really did reach the shed rung, or it proved nothing about it.
		expect(rungsSeen.has(RUNG.SHED)).toBe(true);
		expect(rungsSeen.has(RUNG.SHED_STREAMS)).toBe(true);
		expect(admission.snapshot().rung).toBe(RUNG.NORMAL);
	});

	it('sheds a guarded action rather than admitting it unconfirmed', () => {
		const admission = small();
		for (let i = 0; i < 8; i++) admission.admitAction({ guarded: false });

		const verdict = admission.admitAction({ guarded: true, confirmed: false });
		expect(verdict.admitted).toBe(false);
		expect(verdict.requiresConfirmation).toBe(true);
	});

	it('confirmation depends on the request alone, never on a counter', () => {
		expect(requiresConfirmation({ guarded: true, confirmed: false })).toBe(true);
		expect(requiresConfirmation({ guarded: true, confirmed: true })).toBe(false);
		// A standing per-entity grant is the user's earlier yes, not the load's.
		expect(requiresConfirmation({ guarded: true, allowed: true })).toBe(false);
		expect(requiresConfirmation({ guarded: false })).toBe(false);
		expect(requiresConfirmation()).toBe(false);
		// It takes the request and nothing else, so there is no load state a caller
		// could pass it even by accident. Extra arguments change nothing.
		const admission = small();
		for (let i = 0; i < 8; i++) admission.admitAction({ guarded: false });
		expect(requiresConfirmation({ guarded: true, confirmed: false }, admission, admission.snapshot())).toBe(true);
	});
});

// ------------------------------------------------------------------ runtime

/** The same fake bridge shape tests/home-runtime.test.js uses. */
function makeFakeBridge(options, behaviour = {}) {
	const listeners = new Map();
	const bridge = {
		options,
		connected: false,
		closed: false,
		closeCount: 0,
		graph: { floors: [], rooms: [{ id: 'kitchen', name: 'Kitchen', entities: [] }], unassigned: [] },
		states: { 'light.kitchen': { state: 'on', attributes: {} } },
		haVersion: '2026.9.0',
		on(event, handler) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event).add(handler);
			return () => listeners.get(event)?.delete(handler);
		},
		async connect() {
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

function storeDeps(overrides = {}) {
	return {
		getConnection: vi.fn(async (id, userId) =>
			userId === USER_ID && (id === HOME_ID || id === OTHER_HOME_ID || id === THIRD_HOME_ID)
				? { id, user_id: userId, label: 'Home', base_url: 'https://home.example.com', status: HOME_STATUS.CONNECTED }
				: null,
		),
		getDecryptedToken: vi.fn(async () => ({ token: 'llat', baseUrl: 'https://home.example.com', transport: 'direct', relayId: null, fingerprint: 'fp' })),
		listAllowedEntities: vi.fn(async () => []),
		recordHandshake: vi.fn(async () => null),
		...overrides,
	};
}

describe('the runtime climbs the ladder it was given', () => {
	it('refuses a new home with a retry-after once the pool and its overflow are both full', async () => {
		const built = [];
		const runtime = createHomeRuntime({
			createBridge: (options) => {
				const bridge = makeFakeBridge(options);
				built.push(bridge);
				return bridge;
			},
			...storeDeps(),
			maxConnections: 1,
			admissionLimits: { maxUnpooled: 1 },
		});

		const pooled = await runtime.acquire(HOME_ID, USER_ID);
		const overflow = await runtime.acquire(OTHER_HOME_ID, USER_ID);
		expect(runtime.stats().admission).toMatchObject({ pooled: 1, unpooled: 1 });

		// A third, perfectly valid home: it is refused for capacity, not because
		// anything is wrong with it, and the refusal carries a retry-after. The
		// refusal also lands BEFORE the credential is read, so a full instance does
		// not spend a database round trip telling somebody to come back later.
		const refusal = await runtime.acquire(THIRD_HOME_ID, USER_ID).catch((err) => err);
		expect(refusal).toMatchObject({ code: HOME_RUNTIME_ERR.AT_CAPACITY });
		expect(refusal.retryAfterSeconds).toBeGreaterThan(0);

		pooled.release();
		overflow.release();
		// The unpooled one closed on release; the pooled one is still cached.
		expect(runtime.stats().admission).toMatchObject({ unpooled: 0 });
		runtime.closeAll();
		expect(runtime.stats().admission).toMatchObject({ pooled: 0, unpooled: 0 });
	});

	it('gives the ladder slot back when the house fails to answer', async () => {
		const runtime = createHomeRuntime({
			createBridge: (options) => makeFakeBridge(options, { failWith: () => new Error('house is dark') }),
			...storeDeps(),
			maxConnections: 2,
		});

		for (let i = 0; i < 5; i++) {
			await expect(runtime.acquire(HOME_ID, USER_ID)).rejects.toThrow();
		}

		// Five failed connects must not have consumed five slots, or a house that
		// is merely offline reports the whole instance as full.
		expect(runtime.stats().admission).toMatchObject({ pooled: 0, unpooled: 0 });
	});

	it('sheds a live stream before it sheds an action', async () => {
		const runtime = createHomeRuntime({
			createBridge: makeFakeBridge,
			...storeDeps(),
			maxConnections: 4,
			admissionLimits: { maxInflightActions: 4, streamYieldRatio: 0.5 },
		});

		// Two actions in flight is the yield floor for this configuration.
		runtime.admitAction({ guarded: false });
		runtime.admitAction({ guarded: false });

		await expect(runtime.subscribe(HOME_ID, USER_ID, () => {})).rejects.toMatchObject({
			code: HOME_RUNTIME_ERR.STREAM_SHED,
		});
		// The action path is still open at exactly the same moment.
		expect(runtime.admitAction({ guarded: true, confirmed: false })).toMatchObject({
			admitted: true,
			requiresConfirmation: true,
		});
		runtime.closeAll();
	});

	it('releases a stream seat when the subscriber leaves', async () => {
		const runtime = createHomeRuntime({ createBridge: makeFakeBridge, ...storeDeps(), maxConnections: 4 });

		const stop = await runtime.subscribe(HOME_ID, USER_ID, () => {});
		expect(runtime.stats().admission.streams).toBe(1);
		stop();
		expect(runtime.stats().admission.streams).toBe(0);
		// Idempotent: a browser that disconnects twice must not free a seat twice.
		stop();
		expect(runtime.stats().admission.streams).toBe(0);
		runtime.closeAll();
	});

	it('falls back to the live graph for reads when the store stops answering', async () => {
		const runtime = createHomeRuntime({
			createBridge: makeFakeBridge,
			...storeDeps({ getConnection: vi.fn(async () => { throw new Error('connection terminated'); }) }),
			maxConnections: 4,
		});

		expect(runtime.readPlan().source).toBe(READ_SOURCE.DATABASE);
		await expect(runtime.acquire(HOME_ID, USER_ID)).rejects.toThrow(/connection terminated/);

		// One failed query is the signal. There is no poll interval to wait out.
		expect(runtime.readPlan()).toMatchObject({ rung: RUNG.DEGRADED_READ, source: READ_SOURCE.GRAPH });
		expect(runtime.stats().admission.databaseHealthy).toBe(false);
	});

	it('always returns the action slot, including when the action throws', async () => {
		const runtime = createHomeRuntime({ createBridge: makeFakeBridge, ...storeDeps(), maxConnections: 4 });

		await expect(runtime.withAction({ guarded: false }, async () => { throw new Error('house refused'); })).rejects.toThrow('house refused');
		expect(runtime.stats().admission.inflightActions).toBe(0);

		await runtime.withAction({ guarded: false }, async () => 'ok');
		expect(runtime.stats().admission.inflightActions).toBe(0);
	});
});
