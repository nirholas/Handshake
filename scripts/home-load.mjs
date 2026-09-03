#!/usr/bin/env node
/**
 * The Home lane's load harness.
 *
 * Everything in docs/home-operations.md is a number this script printed. It
 * opens real WebSocket connections, with real long-lived access tokens, to real
 * Home Assistant containers started by scripts/home-fleet.mjs, and it measures
 * what they cost this process.
 *
 * It will only ever talk to the fleet manifest's containers, which live on
 * 127.0.0.1. Never point a load harness at somebody's house.
 *
 *   node scripts/home-fleet.mjs up --homes 12 --big 1
 *   node --expose-gc scripts/home-load.mjs all --out tasks/home/envelope-2026-09-03.json
 *
 * Individual measurements, all of which `all` runs:
 *
 *   coldstart    process start to first connected home, on a cold process
 *   connections  heap, RSS, file descriptors and action p95 at a connection count
 *   burst        CPU absorbed by a 100-entity update burst, and the coalescing
 *   sse          the cost of one SSE subscriber, separated from the connection
 *   gate         under saturation, a guarded action still demands a human
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createAdmissionController, requiresConfirmation } from '../api/_lib/home/admission.js';
import { HomeBridge } from '../packages/home-bridge/src/index.js';
import { classifyCall } from '../packages/home-bridge/src/safety.js';
import { readFleet } from './home-fleet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- instruments

/**
 * A heap reading that means something.
 *
 * Without a forced collection this measures garbage as readily as it measures
 * connections, and the answer moves by tens of megabytes between runs. The
 * script refuses to report a heap number at all if it was started without
 * --expose-gc, because a number nobody can reproduce is worse than no number.
 */
function heapNow() {
	if (typeof global.gc !== 'function') {
		throw new Error('run this with --expose-gc, or the heap numbers are noise: node --expose-gc scripts/home-load.mjs ...');
	}
	global.gc();
	global.gc();
	const mem = process.memoryUsage();
	return { heapUsed: mem.heapUsed, rss: mem.rss, external: mem.external, arrayBuffers: mem.arrayBuffers };
}

/** Open file descriptors held by this process, which is where sockets show up. */
function fdCount() {
	try {
		return readdirSync('/proc/self/fd').length;
	} catch {
		return null;
	}
}

function percentile(sorted, p) {
	if (!sorted.length) return null;
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)];
}

function summarize(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		n: sorted.length,
		min: sorted[0] ?? null,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		max: sorted[sorted.length - 1] ?? null,
		mean: sorted.length ? Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2)) : null,
	};
}

const bytesPer = (delta, n) => (n ? Math.round(delta / n) : null);

// ---------------------------------------------------------------- fleet helpers

function pickHouses(fleet, { big = false } = {}) {
	const houses = fleet.houses.filter((h) => Boolean(h.big) === big);
	if (!houses.length) throw new Error(`the fleet has no ${big ? 'large' : 'small'} house. Re-run home-fleet.mjs up with --big 1.`);
	return houses;
}

/**
 * Open `count` bridges spread round robin across `houses`.
 *
 * Round robin rather than one-house-per-connection because the thing being
 * measured is what a connection costs THIS process. Which container answers is
 * the fixture; how many sockets, states maps and room graphs we hold is the
 * product. Where a measurement does depend on the far side (action latency,
 * chaos isolation) the script says so.
 */
async function openBridges(houses, count, { onOpen } = {}) {
	const bridges = [];
	const failures = [];
	// A storm of simultaneous handshakes measures the handshake, not the steady
	// state. Twenty at a time keeps the containers honest without serializing.
	const WAVE = 20;
	for (let i = 0; i < count; i += WAVE) {
		const wave = [];
		for (let j = i; j < Math.min(i + WAVE, count); j++) {
			const house = houses[j % houses.length];
			const bridge = new HomeBridge({ baseUrl: house.baseUrl, token: house.token });
			wave.push(
				bridge.connect().then(
					() => {
						bridges.push(bridge);
						onOpen?.(bridges.length);
					},
					(err) => {
						failures.push(err.message);
						bridge.close();
					},
				),
			);
		}
		await Promise.all(wave);
	}
	return { bridges, failures };
}

function closeAll(bridges) {
	for (const bridge of bridges) {
		try {
			bridge.close();
		} catch {
			// A bridge whose socket already died still has to be released.
		}
	}
}

function firstEntity(bridge, prefix) {
	return Object.keys(bridge.states).find((id) => id.startsWith(prefix)) || null;
}

// ---------------------------------------------------------------- measurements

/**
 * Cold start: how long a brand new instance takes to have one live home.
 *
 * This is the number that decides whether the lane needs minScale above zero, so
 * it is measured on a genuinely cold process (the caller re-execs this script)
 * and split into the two halves that have different fixes: our module graph
 * loading, and the Home Assistant handshake.
 */
async function measureColdStart(fleet) {
	const house = pickHouses(fleet)[0];
	const processStart = performance.now() - Math.round(process.uptime() * 1000);
	const moduleReady = performance.now();

	const t0 = performance.now();
	const bridge = new HomeBridge({ baseUrl: house.baseUrl, token: house.token });
	await bridge.connect();
	const connectMs = performance.now() - t0;
	const entities = Object.keys(bridge.states).length;
	const rooms = bridge.graph.rooms.length;
	bridge.close();

	return {
		bootToModulesReadyMs: Number((moduleReady - processStart).toFixed(1)),
		connectMs: Number(connectMs.toFixed(1)),
		totalToFirstConnectedHomeMs: Number((moduleReady - processStart + connectMs).toFixed(1)),
		entities,
		rooms,
		note: 'Measured in a freshly spawned node process. bootToModulesReadyMs covers node start plus this harness module graph; the API container loads more than this and its own cold start is measured separately in docs/home-operations.md.',
	};
}

/**
 * The per-connection cost at one connection count.
 *
 * Reports the delta from an idle baseline taken in the same process moments
 * earlier, so the answer is "what did these connections add", not "how big is
 * node".
 */
async function measureConnections(fleet, { count, big = false, actionSamples = 40 }) {
	const houses = pickHouses(fleet, { big });
	const before = heapNow();
	const fdBefore = fdCount();
	const cpuBefore = process.cpuUsage();

	const t0 = performance.now();
	const { bridges, failures } = await openBridges(houses, count);
	const openMs = performance.now() - t0;

	// Let the state subscriptions settle and the graph coalescing quiesce, so the
	// heap reading is of a steady connection rather than of a handshake.
	await sleep(4000);

	const after = heapNow();
	const fdAfter = fdCount();
	const idleCpu = process.cpuUsage(cpuBefore);

	// Steady-state cost: what these connections consume while nothing is asked of
	// them. The demo integration pushes state on its own, so this is not zero and
	// should not be.
	const idleWindowStart = process.cpuUsage();
	await sleep(10_000);
	const idleWindow = process.cpuUsage(idleWindowStart);

	const entities = bridges.reduce((n, b) => n + Object.keys(b.states).length, 0);
	const rooms = bridges.reduce((n, b) => n + b.graph.rooms.length, 0);

	const actions = await measureActionLatency(bridges, actionSamples);

	// Drop every reference before the residual reading, or this array keeps all
	// N bridges (and their entity states and room graphs) alive and the harness
	// reports its own scope as a leak. That is exactly what the first run did:
	// 188KB per connection "retained" was this variable.
	closeAll(bridges);
	const connected = bridges.length;
	bridges.length = 0;
	// Two collections and a real pause, because a socket's buffers are released
	// on a later tick than its object graph. Reading straight after close reports
	// a leak that is not there.
	await sleep(4000);
	heapNow();
	await sleep(1000);
	const afterClose = heapNow();

	return {
		requested: count,
		connected,
		// Per measurement, not per run: this box is shared, and a p95 taken at load
		// 30 is a different number from the same p95 taken at load 8. A reader who
		// cannot see that cannot tell contention from a regression.
		loadAverage: os.loadavg().map((n) => Number(n.toFixed(2))),
		failures: failures.slice(0, 5),
		house: big ? 'large' : 'small',
		entitiesHeld: entities,
		entitiesPerConnection: connected ? Math.round(entities / connected) : null,
		roomsHeld: rooms,
		openMs: Number(openMs.toFixed(1)),
		openMsPerConnection: connected ? Number((openMs / connected).toFixed(2)) : null,
		heapUsedDelta: after.heapUsed - before.heapUsed,
		heapPerConnection: bytesPer(after.heapUsed - before.heapUsed, connected),
		rssDelta: after.rss - before.rss,
		rssPerConnection: bytesPer(after.rss - before.rss, connected),
		externalDelta: after.external - before.external,
		fdBefore,
		fdAfter,
		fdPerConnection: connected && fdAfter != null && fdBefore != null ? Number(((fdAfter - fdBefore) / connected).toFixed(2)) : null,
		openCpuMs: Number(((idleCpu.user + idleCpu.system) / 1000).toFixed(1)),
		idleCpuMsPer10s: Number(((idleWindow.user + idleWindow.system) / 1000).toFixed(1)),
		idleCpuMsPerConnectionPerMinute: connected
			? Number((((idleWindow.user + idleWindow.system) / 1000 / connected) * 6).toFixed(3))
			: null,
		actionLatencyMs: actions,
		heapAfterCloseDelta: afterClose.heapUsed - before.heapUsed,
		heapRetainedPerConnection: bytesPer(afterClose.heapUsed - before.heapUsed, connected),
		fdAfterClose: fdCount(),
	};
}

/**
 * Action latency, measured the way a user experiences it: the call goes out over
 * the same socket the state comes back on, and the sample is the round trip Home
 * Assistant took to acknowledge it.
 */
async function measureActionLatency(bridges, samples) {
	const usable = bridges.filter((b) => firstEntity(b, 'light.'));
	if (!usable.length) return { n: 0, note: 'no light entity in this fleet' };
	const durations = [];
	for (let i = 0; i < samples; i++) {
		const bridge = usable[i % usable.length];
		const entityId = firstEntity(bridge, 'light.');
		const t = performance.now();
		try {
			await bridge.call('light', 'turn_on', { entity_id: entityId, brightness: 20 + (i % 200) });
			durations.push(Number((performance.now() - t).toFixed(2)));
		} catch {
			// A refused or failed call is not a latency sample.
		}
	}
	return summarize(durations);
}

/**
 * CPU absorbed by a burst of 100 entity updates.
 *
 * The big house carries 500 helper entities precisely so this can drive a known
 * number of real state changes rather than waiting for the demo integration to
 * produce some. The interesting output is not only the CPU: it is how many graph
 * rebuilds 100 updates collapsed into, which is the coalescing window doing its
 * job or failing to.
 */
async function measureBurst(fleet, { updates = 100, connections = 1 } = {}) {
	const houses = pickHouses(fleet, { big: true });
	const { bridges } = await openBridges(houses, connections);
	if (!bridges.length) throw new Error('could not open a bridge to the large house');
	const driver = bridges[0];
	await sleep(2000);

	const targets = Object.keys(driver.states)
		.filter((id) => id.startsWith('input_number.load_level_'))
		.slice(0, updates);
	if (targets.length < updates) {
		throw new Error(`the large house has ${targets.length} drivable helpers, need ${updates}. Re-run home-fleet.mjs up --big 1.`);
	}

	let rebuilds = 0;
	const stops = bridges.map((b) => b.on('graph', () => rebuilds++));
	const seen = new Set();
	const watchStops = bridges.map((b) =>
		b.on('graph', () => {
			for (const id of targets) if (b.states[id]?.state !== undefined) seen.add(id);
		}),
	);

	global.gc();
	const cpuBefore = process.cpuUsage();
	const heapBefore = process.memoryUsage().heapUsed;
	const t0 = performance.now();

	// The value must DIFFER from the entity's current one or Home Assistant
	// records no state change, pushes nothing, and the burst measures an empty
	// socket. A first run happens to differ; a second run against the same house
	// writes the same numbers back and silently measures nothing, which is how
	// this harness first reported zero graph rebuilds for a hundred updates.
	await Promise.all(
		targets.map((entityId) => {
			const current = Number(driver.states[entityId]?.state ?? 0);
			return driver.call('input_number', 'set_value', { entity_id: entityId, value: (current % 100) + 1 });
		}),
	);
	const dispatchMs = performance.now() - t0;

	// Wait for the graph to stop moving, so the CPU number includes the rebuilds
	// the burst caused rather than only the calls that caused them.
	await sleep(3000);
	const cpu = process.cpuUsage(cpuBefore);
	const absorbMs = performance.now() - t0;
	global.gc();
	const heapAfter = process.memoryUsage().heapUsed;

	for (const stop of [...stops, ...watchStops]) stop();
	const entityCount = Object.keys(driver.states).length;
	const roomCount = driver.graph.rooms.length;

	// The pure cost of one rebuild, separated from everything around it, so the
	// extrapolation later has a real per-rebuild unit rather than a blended one.
	const { buildHomeGraph } = await import('../packages/home-bridge/src/rooms.js');
	const registries = driver.registries;
	const rebuildSamples = [];
	for (let i = 0; i < 30; i++) {
		const t = performance.now();
		buildHomeGraph({ ...registries, states: driver.states });
		rebuildSamples.push(Number((performance.now() - t).toFixed(3)));
	}

	closeAll(bridges);

	return {
		connectionsHeld: bridges.length,
		houseEntities: entityCount,
		houseRooms: roomCount,
		updates,
		dispatchMs: Number(dispatchMs.toFixed(1)),
		absorbMs: Number(absorbMs.toFixed(1)),
		cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(1)),
		cpuMsPerUpdate: Number(((cpu.user + cpu.system) / 1000 / updates).toFixed(3)),
		graphRebuilds: rebuilds,
		coalescingRatio: Number((updates / Math.max(1, rebuilds)).toFixed(2)),
		heapDeltaAcrossBurst: heapAfter - heapBefore,
		graphRebuildMs: summarize(rebuildSamples),
		note: 'cpuMs covers the whole absorb window: the 100 outbound service calls, the state pushes they caused, and every graph rebuild that survived coalescing.',
	};
}

/**
 * The cost of an SSE subscriber, separated from the cost of a connection.
 *
 * These are two different resources and the envelope has to price them apart: a
 * house with twelve people watching it is one WebSocket and twelve HTTP
 * responses held open. This measures the second half, with a real HTTP server,
 * real client sockets and the real serialization of a real room graph, fed by a
 * real house. The production endpoint is api/home/*; the cost measured here is
 * the shape it has, which is what the sizing decision needs.
 */
async function measureSse(fleet, { subscribers = 200, seconds = 10 } = {}) {
	const houses = pickHouses(fleet);
	const { bridges } = await openBridges(houses, 1);
	if (!bridges.length) throw new Error('could not open a bridge for the SSE measurement');
	const source = bridges[0];
	await sleep(1500);

	const clients = new Set();
	let framesWritten = 0;
	let bytesWritten = 0;

	const server = createServer((req, res) => {
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		});
		res.write(`event: ready\ndata: ${JSON.stringify({ rooms: source.graph.rooms.length })}\n\n`);
		clients.add(res);
		req.on('close', () => clients.delete(res));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;

	const stopFanout = source.on('graph', (graph) => {
		const frame = `event: graph\ndata: ${JSON.stringify(graph)}\n\n`;
		for (const res of clients) {
			res.write(frame);
			framesWritten++;
			bytesWritten += frame.length;
		}
	});

	const before = heapNow();
	const fdBefore = fdCount();
	const controllers = [];
	for (let i = 0; i < subscribers; i++) {
		const controller = new AbortController();
		controllers.push(controller);
		fetch(`http://127.0.0.1:${port}/home/stream`, { signal: controller.signal })
			.then((res) => res.body.pipeTo(new WritableStream({ write() {} }), { signal: controller.signal }))
			.catch(() => {
				// An aborted stream at teardown is the expected end, not a failure.
			});
	}
	// Give every subscriber time to actually be connected before reading a heap.
	for (let i = 0; i < 100 && clients.size < subscribers; i++) await sleep(100);

	const attached = clients.size;
	const after = heapNow();
	const fdAfter = fdCount();

	// Drive real state changes for the whole window. Without this the fixture
	// house simply does not change during a ten second sample, no graph event
	// fires, and the measurement reports the cost of holding a socket while
	// silently omitting the cost of writing to it: the first run of this measured
	// exactly zero frames and looked like a bargain.
	const driveTargets = Object.keys(source.states).filter((id) => id.startsWith('light.'));
	const cpuBefore = process.cpuUsage();
	const driveUntil = Date.now() + seconds * 1000;
	let drives = 0;
	while (Date.now() < driveUntil) {
		const entityId = driveTargets[drives % driveTargets.length];
		await source.call('light', 'turn_on', { entity_id: entityId, brightness: 20 + (drives * 17) % 220 }).catch(() => {});
		drives++;
		await sleep(500);
	}
	const cpu = process.cpuUsage(cpuBefore);

	stopFanout();
	for (const controller of controllers) controller.abort();
	for (const res of clients) res.end();
	await new Promise((resolve) => server.close(resolve));
	closeAll(bridges);

	return {
		subscribersRequested: subscribers,
		subscribersAttached: attached,
		heapDelta: after.heapUsed - before.heapUsed,
		heapPerSubscriber: bytesPer(after.heapUsed - before.heapUsed, attached),
		rssDelta: after.rss - before.rss,
		rssPerSubscriber: bytesPer(after.rss - before.rss, attached),
		// Two descriptors per subscriber here because both ends of every socket are
		// in this one process. In production the far end is a browser, so the
		// server side of a subscriber costs one.
		fdPerSubscriberBothEnds: attached && fdAfter != null ? Number(((fdAfter - fdBefore) / attached).toFixed(2)) : null,
		fdPerSubscriberServerSide: attached && fdAfter != null ? Number((((fdAfter - fdBefore) / attached) / 2).toFixed(2)) : null,
		stateChangesDriven: drives,
		framesWritten,
		framesPerSubscriber: attached ? Number((framesWritten / attached).toFixed(2)) : null,
		bytesWritten,
		bytesPerFrame: framesWritten ? Math.round(bytesWritten / framesWritten) : null,
		windowSeconds: seconds,
		cpuMsInWindow: Number(((cpu.user + cpu.system) / 1000).toFixed(1)),
		cpuMsPerSubscriberPerMinute: attached ? Number((((cpu.user + cpu.system) / 1000 / attached) * (60 / seconds)).toFixed(3)) : null,
		note: 'One live house fanning its real room graph to N real HTTP subscribers over a real socket each, with the house being changed throughout so frames actually flow. Both halves of the cost, the held response and the per-frame serialization, are in these numbers. Both ends of every socket are in this process, so the descriptor and RSS figures are an upper bound on what a server pays.',
	};
}

/**
 * The safety assertion: saturation must never buy an agent a free unlock.
 *
 * Drives the admission controller from empty to fully shed while a real guarded
 * call is classified against a real lock in a real house at every step, and
 * asserts that at no point does the verdict stop demanding a human.
 */
async function measureGateUnderSaturation(fleet, { steps = 400 } = {}) {
	const houses = pickHouses(fleet);
	const { bridges } = await openBridges(houses, 1);
	if (!bridges.length) throw new Error('could not open a bridge for the gate assertion');
	const bridge = bridges[0];
	const lock = firstEntity(bridge, 'lock.');
	if (!lock) throw new Error('the fixture house has no lock; the gate assertion needs one');

	const admission = createAdmissionController({ maxPooled: 20, maxUnpooled: 5, maxStreams: 30, maxInflightActions: 40 });
	const rungsSeen = new Set();
	const violations = [];
	let refusedByGate = 0;
	let shedByLoad = 0;

	for (let i = 0; i < steps; i++) {
		// Climb: take connection slots, open streams, start actions, and never
		// finish them, so the controller walks the whole ladder.
		if (i % 3 === 0) admission.acquire();
		if (i % 2 === 0) admission.admitStream();
		if (i % 5 === 0) admission.setDatabaseHealthy(false);

		const verdict = classifyCall({ domain: 'lock', service: 'unlock', entityId: lock, attributes: bridge.states[lock]?.attributes });
		const decision = admission.admitAction({ guarded: verdict.guarded, confirmed: false, allowed: bridge.allowList.has(lock) });
		rungsSeen.add(decision.rung);

		if (!decision.requiresConfirmation) {
			violations.push({ step: i, rung: decision.rung, snapshot: admission.snapshot() });
		}
		if (decision.admitted) {
			// The gate is what stops it, not the load: an admitted guarded action
			// still has to come back with requiresConfirmation and go no further.
			refusedByGate++;
			admission.finishAction();
			// Re-take the slot without releasing, to climb toward the shed rung.
			if (i > steps / 3) admission.admitAction({ guarded: false });
		} else {
			shedByLoad++;
		}
	}

	// The real call, at the top of the ladder, against the real lock: it must
	// still refuse, and the lock must still be locked afterwards.
	const stateBefore = bridge.states[lock]?.state;
	let liveRefusal = null;
	try {
		await bridge.call('lock', 'unlock', { entity_id: lock });
		liveRefusal = 'NOT REFUSED';
	} catch (err) {
		liveRefusal = err.code;
	}
	await sleep(1200);
	const stateAfter = bridge.states[lock]?.state;
	closeAll(bridges);

	return {
		steps,
		lock,
		rungsSeen: [...rungsSeen].sort(),
		guardedActionsSeen: steps,
		everWavedThrough: violations.length,
		violations: violations.slice(0, 3),
		refusedByGateWhileAdmitted: refusedByGate,
		shedByLoad,
		liveCallOutcome: liveRefusal,
		lockStateBefore: stateBefore,
		lockStateAfter: stateAfter,
		passed: violations.length === 0 && liveRefusal === 'needs_confirmation' && stateAfter === stateBefore,
	};
}

/**
 * What Cloud Run's CPU throttling actually does to a held SSE stream.
 *
 * This is the setting most likely to be wrong for this workload and the order it
 * comes from is explicit that it must be tested rather than reasoned about. It
 * cannot be tested on this machine: throttling is a Cloud Run behaviour, not a
 * container one. So it is tested against the running production service, using a
 * streaming endpoint that is already deployed there and already emits a ping on
 * a fixed interval (api/pump/trades-stream.js, PING_INTERVAL_MS = 15000).
 *
 * That ping is a background timer inside a held request, which is exactly the
 * shape order 03's home stream has. If `cpu-throttling=true` starved timers
 * while a stream is open, the interval between pings would drift; if the request
 * timeout cut the stream, it would end at a measurable second. Both are read off
 * the wire here rather than off the documentation.
 *
 * @param {{ url?: string, seconds?: number, expectedIntervalMs?: number }} options
 */
async function measureCloudRunStream({ url = 'https://three.ws/api/pump/trades-stream', seconds = 960, expectedIntervalMs = 15_000 } = {}) {
	const controller = new AbortController();
	const startedAt = Date.now();
	const events = [];
	let bytes = 0;
	let endedReason = 'still open at the deadline';

	const timer = setTimeout(() => {
		endedReason = 'closed by this probe at the deadline';
		controller.abort();
	}, seconds * 1000);

	const response = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
	const status = response.status;
	const served = {
		status,
		server: response.headers.get('server'),
		contentType: response.headers.get('content-type'),
		cacheControl: response.headers.get('cache-control'),
	};

	try {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) {
				endedReason = 'the server ended the stream';
				break;
			}
			bytes += value.byteLength;
			buffer += decoder.decode(value, { stream: true });
			let index;
			while ((index = buffer.indexOf('\n\n')) !== -1) {
				const frame = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				const name = (frame.match(/^event:\s*(.+)$/m) || [null, 'message'])[1].trim();
				events.push({ atMs: Date.now() - startedAt, event: name });
			}
		}
	} catch (err) {
		if (err.name !== 'AbortError') endedReason = `the stream failed: ${err.message}`;
	} finally {
		clearTimeout(timer);
	}

	const heldMs = Date.now() - startedAt;
	// Whichever event this endpoint uses for its heartbeat is the one to time.
	// The name differs between streams ("ping" here, "heartbeat" there) and the
	// probe should not need editing to point at a different one.
	const histogram = {};
	for (const e of events) histogram[e.event] = (histogram[e.event] || 0) + 1;
	const heartbeatName = Object.entries(histogram).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
	const pings = events.filter((e) => e.event === heartbeatName);
	const gaps = pings.slice(1).map((p, i) => p.atMs - pings[i].atMs);
	const drift = gaps.map((g) => g - expectedIntervalMs);

	return {
		url,
		requestedSeconds: seconds,
		heldSeconds: Number((heldMs / 1000).toFixed(1)),
		served,
		endedReason,
		bytes,
		framesReceived: events.length,
		frameHistogram: histogram,
		heartbeatEvent: heartbeatName,
		pingsReceived: pings.length,
		expectedIntervalMs,
		pingGapMs: summarize(gaps),
		pingDriftMs: summarize(drift),
		worstLatePingMs: drift.length ? Math.max(...drift) : null,
		note: 'A ping arriving on schedule for the whole hold means the interval timer inside a held streaming request kept its CPU. The end reason and heldSeconds say whether the platform request timeout cut the stream before this probe did.',
	};
}

/**
 * Does a held SSE stream occupy a Cloud Run concurrency slot?
 *
 * This decides the stream cap, and it is not a detail: `containerConcurrency` is
 * 160 on three-ws-api, so if a stream holds a slot for its whole life then the
 * platform starts refusing requests long before an admission cap of several
 * hundred would ever fire, and the ladder would be decoration.
 *
 * It is measured rather than reasoned about, against the running service, using
 * a streaming endpoint already deployed there. Cloud Run autoscales on
 * concurrency, so if streams consume slots the instance count rises with them
 * and falls again afterwards. The instance count comes from Cloud Monitoring,
 * which is the platform's own accounting rather than ours.
 *
 * @param {{ url?: string, streams?: number, seconds?: number, project?: string, service?: string }} options
 */
async function measureStreamConcurrency({
	url = 'https://three.ws/api/feed-stream',
	streams = 200,
	seconds = 240,
	project = 'aerial-vehicle-466722-p5',
	service = 'three-ws-api',
} = {}) {
	const before = await readInstanceCount({ project, service, minutesBack: 20 });

	const controllers = [];
	let opened = 0;
	let failed = 0;
	const openStream = async () => {
		const controller = new AbortController();
		controllers.push(controller);
		try {
			const response = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
			if (!response.ok) {
				failed++;
				return;
			}
			opened++;
			// Drain and discard. A stream nobody reads is a stream the kernel
			// eventually stalls, which would measure our own back pressure instead
			// of the platform's.
			response.body.pipeTo(new WritableStream({ write() {} }), { signal: controller.signal }).catch(() => {});
		} catch {
			failed++;
		}
	};

	// Open in waves, and keep reopening: the endpoint caps its own streams at 275
	// seconds, so a fixed set would drain away mid measurement.
	const started = Date.now();
	const keepAlive = setInterval(() => {
		const shortfall = streams - opened + failed;
		for (let i = 0; i < Math.min(20, Math.max(0, shortfall)); i++) openStream();
	}, 10_000);
	for (let i = 0; i < streams; i += 25) {
		await Promise.all(Array.from({ length: Math.min(25, streams - i) }, openStream));
		await sleep(500);
	}

	await sleep(Math.max(0, seconds * 1000 - (Date.now() - started)));
	const during = await readInstanceCount({ project, service, minutesBack: 8 });

	clearInterval(keepAlive);
	for (const controller of controllers) controller.abort();

	const delta = during.peakActive != null && before.peakActive != null ? during.peakActive - before.peakActive : null;
	return {
		url,
		streamsRequested: streams,
		streamsOpened: opened,
		streamsRefused: failed,
		heldSeconds: seconds,
		instancesBefore: before,
		instancesDuring: during,
		peakActiveDelta: delta,
		streamsPerAddedInstance: delta && delta > 0 ? Number((opened / delta).toFixed(1)) : null,
		occupiesConcurrencySlot: delta != null ? delta > 0 : null,
		note: 'Cloud Run autoscales on concurrent requests. An instance count that rises while N streams are held, and only while they are held, is the platform saying each stream is an in-flight request holding a concurrency slot.',
	};
}

/** Cloud Run instance counts, straight from Cloud Monitoring. */
async function readInstanceCount({ project, service, minutesBack }) {
	const token = await new Promise((resolve, reject) => {
		const child = spawn('gcloud', ['auth', 'print-access-token'], { stdio: ['ignore', 'pipe', 'ignore'] });
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.on('error', reject);
		child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('gcloud auth print-access-token failed'))));
	});

	const end = new Date();
	const start = new Date(end.getTime() - minutesBack * 60_000);
	const params = new URLSearchParams({
		filter: `metric.type="run.googleapis.com/container/instance_count" AND resource.labels.service_name="${service}"`,
		'interval.startTime': start.toISOString(),
		'interval.endTime': end.toISOString(),
		'aggregation.alignmentPeriod': '60s',
		'aggregation.perSeriesAligner': 'ALIGN_MEAN',
	});
	const response = await fetch(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${params}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const body = await response.json();
	if (body.error) return { error: body.error.message, peakActive: null };

	const byState = {};
	for (const series of body.timeSeries || []) {
		const state = series.metric.labels.state;
		const values = series.points.map((p) => Number(p.value.doubleValue ?? p.value.int64Value ?? 0));
		byState[state] = { peak: Math.max(...values, 0), mean: Number((values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)).toFixed(2)), points: values.length };
	}
	return { windowMinutes: minutesBack, byState, peakActive: byState.active?.peak ?? null };
}

/** Each rung of the ladder, demonstrated rather than described. */
function demonstrateLadder() {
	const admission = createAdmissionController({ maxPooled: 4, maxUnpooled: 2, maxStreams: 6, maxInflightActions: 8, streamYieldRatio: 0.5 });
	const rows = [];
	const record = (label, verdict) =>
		rows.push({ label, admitted: verdict.admitted, rung: verdict.rung, connection: verdict.connection ?? null, source: verdict.source ?? null, requiresConfirmation: verdict.requiresConfirmation ?? null, retryAfterSeconds: verdict.retryAfterSeconds ?? null, reason: verdict.reason || null });

	record('rung 1: acquire under the cap', admission.acquire());
	for (let i = 0; i < 3; i++) admission.acquire();
	record('rung 2: acquire at the cap', admission.acquire());
	record('rung 2: read is still from the database', admission.admitRead());
	admission.setDatabaseHealthy(false);
	record('rung 3: read with the database down', admission.admitRead());
	rows.push({ label: 'rung 3: write policy with the database down', ...admission.writePolicy() });
	admission.setDatabaseHealthy(true);
	record('rung 4: stream while 3 of 8 actions are in flight', (() => {
		for (let i = 0; i < 3; i++) admission.admitAction({ guarded: false });
		return admission.admitStream();
	})());
	record('rung 4: stream once actions pass the yield floor', (() => {
		for (let i = 0; i < 2; i++) admission.admitAction({ guarded: false });
		return admission.admitStream();
	})());
	record('rung 4: an action at the same moment', admission.admitAction({ guarded: false }));
	record('rung 5: an action with every slot taken', (() => {
		for (let i = 0; i < 8; i++) admission.admitAction({ guarded: false });
		return admission.admitAction({ guarded: false });
	})());
	record('rung 5: a GUARDED action with every slot taken', admission.admitAction({ guarded: true, confirmed: false }));

	return { rows, finalSnapshot: admission.snapshot() };
}

// ---------------------------------------------------------------- runner

/**
 * Run one measurement in a brand new process and return its JSON.
 *
 * Heap deltas do not survive being taken back to back in one process: the
 * garbage from a 400 connection tier is still resident when the next tier reads
 * its baseline, and the arithmetic comes out negative. Measuring the large house
 * that way produced -6.8MB per connection, which is not a number, it is an
 * artefact. Every heap figure in the envelope is therefore taken against a
 * baseline read moments earlier in a process that has done nothing else.
 */
function measureInChildProcess(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), ...args], {
			stdio: ['ignore', 'pipe', 'inherit'],
			env: process.env,
		});
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0) return reject(new Error(`${args.join(' ')} exited ${code}`));
			try {
				resolve(JSON.parse(out));
			} catch (err) {
				reject(new Error(`${args.join(' ')} did not print JSON: ${err.message}`));
			}
		});
	});
}

async function all({ out, counts, sseSubscribers }) {
	const fleet = await readFleet();
	const machine = {
		node: process.version,
		platform: `${os.platform()} ${os.release()}`,
		cpus: os.cpus().length,
		cpuModel: os.cpus()[0]?.model ?? null,
		totalMemBytes: os.totalmem(),
		freeMemBytes: os.freemem(),
		ulimitNofile: Number(process.report?.getReport()?.userLimits?.open_files?.soft ?? 0) || null,
		// This box is shared with other work. Load average is recorded so a reader
		// can tell a real latency number from one taken while sixteen cores were
		// already busy, instead of having to trust that the run was quiet.
		loadAverage: os.loadavg().map((n) => Number(n.toFixed(2))),
	};

	const result = {
		measuredAt: new Date().toISOString(),
		machine,
		fleet: {
			image: fleet.image,
			houses: fleet.houses.length,
			small: fleet.houses.filter((h) => !h.big).length,
			large: fleet.houses.filter((h) => h.big).length,
			entitiesPerSmallHouse: fleet.houses.find((h) => !h.big)?.entityCount ?? null,
			entitiesPerLargeHouse: fleet.houses.find((h) => h.big)?.entityCount ?? null,
			haBootMs: summarize(fleet.houses.map((h) => h.bootMs)),
			realNote: 'Every house is a real Home Assistant container with a real long-lived access token, started by scripts/home-fleet.mjs. Connections are real WebSocket sessions through home-assistant-js-websocket, the same client the product uses.',
		},
		coldStart: await measureColdStart(fleet),
		connections: [],
		ladder: demonstrateLadder(),
	};

	for (const count of counts) {
		process.stderr.write(`  measuring ${count} connections (fresh process)...\n`);
		result.connections.push(await measureInChildProcess(['connections', '--n', String(count)]));
	}

	process.stderr.write('  measuring the large house (fresh process)...\n');
	result.largeHouse = await measureInChildProcess(['connections', '--n', '10', '--big']);

	process.stderr.write('  measuring a 100 entity update burst...\n');
	result.burst = await measureInChildProcess(['burst', '--updates', '100']);

	process.stderr.write('  measuring SSE subscribers...\n');
	result.sse = await measureInChildProcess(['sse', '--subscribers', String(sseSubscribers)]);

	process.stderr.write('  asserting the gate under saturation...\n');
	result.gate = await measureInChildProcess(['gate']);

	result.machineAtEnd = { loadAverage: os.loadavg().map((n) => Number(n.toFixed(2))), freeMemBytes: os.freemem() };

	if (out) {
		const file = path.resolve(ROOT, out);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
		process.stderr.write(`\nwrote ${path.relative(ROOT, file)}\n`);
	} else {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	}
	return result;
}

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith('--')) out[arg.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
		else out._.push(arg);
	}
	return out;
}

export { demonstrateLadder, measureBurst, measureCloudRunStream, measureColdStart, measureStreamConcurrency, measureConnections, measureGateUnderSaturation, measureSse, openBridges, closeAll, pickHouses, summarize, requiresConfirmation };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const args = parseArgs(process.argv.slice(2));
	const command = args._[0] || 'all';
	const counts = String(args.counts || '10,50,100,200,400')
		.split(',')
		.map((n) => Number(n.trim()))
		.filter(Boolean);

	const commands = {
		all: () => all({ out: typeof args.out === 'string' ? args.out : null, counts, sseSubscribers: Number(args.subscribers || 200) }),
		coldstart: async () => measureColdStart(await readFleet()),
		connections: async () => measureConnections(await readFleet(), { count: Number(args.n || 50), big: Boolean(args.big) }),
		burst: async () => measureBurst(await readFleet(), { updates: Number(args.updates || 100) }),
		sse: async () => measureSse(await readFleet(), { subscribers: Number(args.subscribers || 200) }),
		gate: async () => measureGateUnderSaturation(await readFleet()),
		ladder: async () => demonstrateLadder(),
		cloudrun: async () => measureCloudRunStream({ seconds: Number(args.seconds || 960), url: typeof args.url === 'string' ? args.url : undefined }),
		concurrency: async () => measureStreamConcurrency({ streams: Number(args.streams || 200), seconds: Number(args.seconds || 240) }),
	};

	const run = commands[command];
	if (!run) {
		console.error(`unknown command "${command}". Use: ${Object.keys(commands).join(' | ')}`);
		process.exit(2);
	}
	run().then(
		(value) => {
			if (command !== 'all' || !args.out) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
			process.exit(0);
		},
		(err) => {
			console.error(err.stack || err.message);
			process.exit(1);
		},
	);
}
