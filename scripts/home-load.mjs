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

	closeAll(bridges);
	await sleep(1500);
	const afterClose = heapNow();

	return {
		requested: count,
		connected: bridges.length,
		failures: failures.slice(0, 5),
		house: big ? 'large' : 'small',
		entitiesHeld: entities,
		entitiesPerConnection: bridges.length ? Math.round(entities / bridges.length) : null,
		roomsHeld: rooms,
		openMs: Number(openMs.toFixed(1)),
		openMsPerConnection: bridges.length ? Number((openMs / bridges.length).toFixed(2)) : null,
		heapUsedDelta: after.heapUsed - before.heapUsed,
		heapPerConnection: bytesPer(after.heapUsed - before.heapUsed, bridges.length),
		rssDelta: after.rss - before.rss,
		rssPerConnection: bytesPer(after.rss - before.rss, bridges.length),
		externalDelta: after.external - before.external,
		fdBefore,
		fdAfter,
		fdPerConnection: bridges.length && fdAfter != null && fdBefore != null ? Number(((fdAfter - fdBefore) / bridges.length).toFixed(2)) : null,
		openCpuMs: Number(((idleCpu.user + idleCpu.system) / 1000).toFixed(1)),
		idleCpuMsPer10s: Number(((idleWindow.user + idleWindow.system) / 1000).toFixed(1)),
		idleCpuMsPerConnectionPerMinute: bridges.length
			? Number((((idleWindow.user + idleWindow.system) / 1000 / bridges.length) * 6).toFixed(3))
			: null,
		actionLatencyMs: actions,
		heapAfterCloseDelta: afterClose.heapUsed - before.heapUsed,
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

	await Promise.all(
		targets.map((entityId, i) => driver.call('input_number', 'set_value', { entity_id: entityId, value: (i % 100) + 1 })),
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

	const cpuBefore = process.cpuUsage();
	await sleep(seconds * 1000);
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
		fdPerSubscriber: attached && fdAfter != null ? Number(((fdAfter - fdBefore) / attached).toFixed(2)) : null,
		framesWritten,
		bytesWritten,
		windowSeconds: seconds,
		cpuMsInWindow: Number(((cpu.user + cpu.system) / 1000).toFixed(1)),
		cpuMsPerSubscriberPerMinute: attached ? Number((((cpu.user + cpu.system) / 1000 / attached) * (60 / seconds)).toFixed(3)) : null,
		note: 'One live house fanning its real room graph to N real HTTP subscribers over a real socket each. Both halves of the cost, the held response and the per-frame serialization, are in these numbers.',
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

async function all({ out, counts, sseSubscribers }) {
	const fleet = await readFleet();
	const machine = {
		node: process.version,
		platform: `${os.platform()} ${os.release()}`,
		cpus: os.cpus().length,
		cpuModel: os.cpus()[0]?.model ?? null,
		totalMemBytes: os.totalmem(),
		ulimitNofile: Number(process.report?.getReport()?.userLimits?.open_files?.soft ?? 0) || null,
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
		process.stderr.write(`  measuring ${count} connections...\n`);
		result.connections.push(await measureConnections(fleet, { count }));
		await sleep(2000);
	}

	process.stderr.write('  measuring the large house...\n');
	result.largeHouse = await measureConnections(fleet, { count: 10, big: true });

	process.stderr.write('  measuring a 100 entity update burst...\n');
	result.burst = await measureBurst(fleet, { updates: 100 });

	process.stderr.write('  measuring SSE subscribers...\n');
	result.sse = await measureSse(fleet, { subscribers: sseSubscribers });

	process.stderr.write('  asserting the gate under saturation...\n');
	result.gate = await measureGateUnderSaturation(fleet);

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

export { demonstrateLadder, measureBurst, measureColdStart, measureConnections, measureGateUnderSaturation, measureSse, openBridges, closeAll, pickHouses, summarize, requiresConfirmation };

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
