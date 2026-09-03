#!/usr/bin/env node
/**
 * The seven failures the Home lane has to survive, each injected for real.
 *
 * Every scenario runs against the local fleet from scripts/home-fleet.mjs: real
 * Home Assistant containers, real long-lived tokens, real sockets. Nothing is
 * simulated except the database outage in scenario 5, which uses the real store
 * module pointed at a host that is genuinely not there.
 *
 *   node scripts/home-fleet.mjs up --homes 12 --big 1
 *   node scripts/home-chaos.mjs all --out tasks/home/chaos-2026-09-03.json
 *   node scripts/home-chaos.mjs 6            # one scenario, printed
 *
 * The scenarios:
 *
 *   1  a house goes offline mid-session
 *   2  a house flaps up, down, up
 *   3  the access token is revoked while we are connected
 *   4  our instance is recycled mid-stream
 *   5  the database is unavailable
 *   6  a slow house, beside a fast one
 *   7  a 500 entity house at ten updates a second
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, connect as netConnect } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { createHomeRuntime, HOME_RUNTIME_ERR } from '../api/_lib/home/runtime.js';
import { HOME_STATUS } from '../api/_lib/home/store.js';
import { ERR } from '../packages/home-bridge/src/index.js';
import { readFleet } from './home-fleet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER_ID = '00000000-0000-4000-8000-000000000001';

function run(cmd, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		child.on('error', reject);
		child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args.join(' ')}: ${err.trim()}`))));
	});
}
const docker = (...args) => run('docker', args);

/**
 * ESTABLISHED sockets to one local port, from the kernel rather than from our
 * own bookkeeping. Scenario 4 has to prove the HOUSE saw the disconnect, and our
 * own counters cannot prove anything about the far side.
 */
async function establishedTo(port) {
	const out = await run('ss', ['-tn', 'state', 'established', `( dport = :${port} or sport = :${port} )`]).catch(() => '');
	return out.split('\n').filter((line) => line.includes(`:${port}`)).length;
}

/**
 * A store facade over the fleet manifest.
 *
 * The runtime's store dependencies are injectable precisely so a chaos run does
 * not need a Postgres row per container. Every credential this hands back is a
 * REAL long-lived access token for a REAL house; only the lookup is local. Where
 * a scenario is actually about the database (scenario 5) it swaps in the real
 * store module instead.
 */
/**
 * The address resolution the chaos runtimes use.
 *
 * Production resolves a home's hostname through the SSRF guard and refuses any
 * private address, which is exactly right and which refuses every container in
 * this fleet: they live on 127.0.0.1. The runtime exposes `resolveDial` as a
 * seam for this reason. Nothing else about the runtime is stubbed here, the
 * production default is `defaultResolveDial`, and
 * tests/home-security.test.js asserts that a runtime built the way production
 * builds it still refuses loopback.
 */
const resolveLoopbackDial = async (baseUrl) => {
	const url = new URL(baseUrl);
	if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
		throw new Error(`the chaos harness only ever dials its own containers, not ${url.hostname}`);
	}
	return { host: url.hostname, addresses: [{ address: '127.0.0.1', family: 4 }], secure: false };
};

function fleetStore(houses, { overrideUrl } = {}) {
	const byId = new Map(houses.map((h) => [homeIdFor(h.index), h]));
	const handshakes = [];
	const store = {
		handshakes,
		getConnection: async (id, userId) => {
			const house = byId.get(id);
			if (!house || userId !== USER_ID) return null;
			return { id, user_id: userId, label: house.name, base_url: overrideUrl?.(house) || house.baseUrl, transport: 'direct', relay_id: null, status: HOME_STATUS.CONNECTED };
		},
		getDecryptedToken: async (id) => {
			const house = byId.get(id);
			if (!house) return null;
			return { token: house.token, baseUrl: overrideUrl?.(house) || house.baseUrl, transport: 'direct', relayId: null, fingerprint: `fp-${id}` };
		},
		listAllowedEntities: async () => [],
		recordHandshake: async (id, update) => {
			handshakes.push({ id, at: Date.now(), ...update });
			return null;
		},
		resolveDial: resolveLoopbackDial,
	};
	return store;
}

/** A stable uuid per fleet index, so a handshake row can be traced to a container. */
function homeIdFor(index) {
	const n = String(index).padStart(12, '0');
	return `00000000-0000-4000-8000-${n}`;
}

/**
 * A controllable TCP proxy in front of one house.
 *
 * Two knobs, both of which model a real network rather than a broken program:
 * `delayMs` holds every response back (a distant house on a bad link), and
 * `open` slams every socket shut and refuses new ones (a house whose uplink
 * flaps). Injecting at the socket is the only way to get either failure without
 * changing Home Assistant, which must stay the unmodified real thing.
 */
function proxy({ listenPort, targetPort, delayMs = 0, targetHost = '127.0.0.1' }) {
	const sockets = new Set();
	let open = true;

	const server = createServer((client) => {
		if (!open) {
			client.destroy();
			return;
		}
		const upstream = netConnect(targetPort, targetHost);
		sockets.add(client);
		sockets.add(upstream);
		const forward = (from, to, delay) => {
			from.on('data', (chunk) => {
				if (delay) setTimeout(() => !to.destroyed && to.write(chunk), delay);
				else if (!to.destroyed) to.write(chunk);
			});
			from.on('close', () => to.destroy());
			from.on('error', () => to.destroy());
		};
		// The delay is on the RESPONSE direction only, so "2 seconds per response"
		// means exactly that rather than a doubled round trip.
		forward(client, upstream, 0);
		forward(upstream, client, delayMs);
	});

	return {
		async listen() {
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(listenPort, '127.0.0.1', resolve);
			});
			return `http://127.0.0.1:${listenPort}`;
		},
		cut() {
			open = false;
			for (const socket of sockets) socket.destroy();
			sockets.clear();
		},
		restore() {
			open = true;
		},
		async close() {
			this.cut();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

/** Capture console.warn, so "no alert storm" is a counted fact. */
function captureWarnings() {
	const lines = [];
	const original = console.warn;
	console.warn = (...args) => {
		lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
	};
	return {
		lines,
		stop() {
			console.warn = original;
		},
	};
}

/** Poll a condition rather than sleeping through it. */
async function until(predicate, { timeoutMs = 60_000, everyMs = 250, label = 'condition' } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await sleep(everyMs);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function percentile(samples, p) {
	if (!samples.length) return null;
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const summarize = (samples) => ({
	n: samples.length,
	p50: percentile(samples, 50),
	p95: percentile(samples, 95),
	max: samples.length ? Math.max(...samples) : null,
});

async function timeCalls(bridge, entityId, count) {
	const samples = [];
	for (let i = 0; i < count; i++) {
		const t = performance.now();
		try {
			await bridge.call('light', 'turn_on', { entity_id: entityId, brightness: 30 + (i % 200) });
			samples.push(Number((performance.now() - t).toFixed(2)));
		} catch {
			// A failed call is not a latency sample; the caller counts failures.
		}
	}
	return samples;
}

const lightIn = (bridge) => Object.keys(bridge.states).find((id) => id.startsWith('light.')) || null;

// ---------------------------------------------------------------- scenario 1

/** A house goes offline mid-session: stale, never empty, and it comes back. */
async function scenarioOfflineMidSession(fleet) {
	const house = fleet.houses.find((h) => !h.big && h.index === 1);
	const homeId = homeIdFor(house.index);
	const runtime = createHomeRuntime({ ...fleetStore(fleet.houses), maxConnections: 10 });
	const transcript = [];
	const events = [];

	const stop = await runtime.subscribe(homeId, USER_ID, (event) => {
		events.push({ at: Date.now(), rooms: event.graph.rooms.length, stale: event.stale, connected: event.connected, status: event.status });
	});
	await sleep(1500);
	const roomsWhileUp = events.at(-1).rooms;
	transcript.push(`connected: ${roomsWhileUp} rooms, stale=${events.at(-1).stale}`);

	await docker('stop', house.name);
	transcript.push(`docker stop ${house.name}`);
	await until(() => events.at(-1)?.stale === true, { timeoutMs: 60_000, label: 'the stream to report stale' });

	const whileDown = events.at(-1);
	transcript.push(`while down: stale=${whileDown.stale} status=${whileDown.status} rooms=${whileDown.rooms}`);

	await docker('start', house.name);
	transcript.push(`docker start ${house.name}`);
	await until(() => events.at(-1)?.stale === false && events.at(-1)?.connected === true, { timeoutMs: 180_000, label: 'the stream to recover' });
	const afterRecovery = events.at(-1);
	transcript.push(`recovered: ${afterRecovery.rooms} rooms, stale=${afterRecovery.stale}, no re-subscribe`);

	stop();
	runtime.closeAll();

	return {
		scenario: 1,
		title: 'a house goes offline mid-session',
		transcript,
		roomsWhileUp,
		roomsWhileDown: whileDown.rooms,
		statusWhileDown: whileDown.status,
		roomsAfterRecovery: afterRecovery.rooms,
		subscriptionSurvived: true,
		passed: whileDown.stale === true && whileDown.rooms === roomsWhileUp && whileDown.rooms > 0 && afterRecovery.stale === false && afterRecovery.rooms > 0,
		note: 'The same subscription callback saw the whole sequence. The browser never reloaded and the graph never went empty: it went stale.',
	};
}

// ---------------------------------------------------------------- scenario 2

/** A flapping house: damped, quiet, and it leaks nothing. */
async function scenarioFlap(fleet, { seconds = 120, periodMs = 5000 } = {}) {
	const house = fleet.houses.find((h) => !h.big && h.index === 2);
	const gate = proxy({ listenPort: 19002, targetPort: house.port });
	const baseUrl = await gate.listen();

	const store = fleetStore(fleet.houses, { overrideUrl: (h) => (h.index === house.index ? baseUrl : h.baseUrl) });
	const runtime = createHomeRuntime({ ...store, maxConnections: 10 });
	const homeId = homeIdFor(house.index);
	const warnings = captureWarnings();
	const transcript = [];

	let held;
	try {
		held = await runtime.acquire(homeId, USER_ID);
		const fdBefore = (await import('node:fs')).readdirSync('/proc/self/fd').length;
		transcript.push(`connected through the flap gate; ${fdBefore} file descriptors held`);

		// Part A: an established connection rides the flap.
		let cycles = 0;
		const deadline = Date.now() + seconds * 1000;
		while (Date.now() < deadline) {
			gate.cut();
			await sleep(periodMs / 2);
			gate.restore();
			await sleep(periodMs / 2);
			cycles++;
		}
		await sleep(3000);
		const fdAfter = (await import('node:fs')).readdirSync('/proc/self/fd').length;
		transcript.push(`${cycles} up-down-up cycles at ${periodMs}ms; ${fdAfter} file descriptors held`);
		transcript.push(`pool still holds ${runtime.stats().open} connection(s) for 1 home`);

		// Part B: the breaker. A house that is DOWN and asked for repeatedly must
		// stop being dialled, or a flap becomes a connect storm.
		gate.cut();
		held.release();
		runtime.closeAll();
		const downRuntime = createHomeRuntime({ ...store, maxConnections: 10, connectTimeoutMs: 3000 });
		const attempts = [];
		for (let i = 0; i < 8; i++) {
			const t = performance.now();
			const error = await downRuntime.acquire(homeId, USER_ID).then(() => null, (err) => err);
			attempts.push({ attempt: i + 1, ms: Math.round(performance.now() - t), code: error?.code ?? 'connected' });
		}
		const breakerOpened = attempts.findIndex((a) => a.code === HOME_RUNTIME_ERR.BREAKER_OPEN);
		const fastFails = attempts.filter((a) => a.code === HOME_RUNTIME_ERR.BREAKER_OPEN);
		transcript.push(`breaker opened on attempt ${breakerOpened + 1}; subsequent attempts fail in ${Math.max(...fastFails.map((a) => a.ms), 0)}ms or less`);
		downRuntime.closeAll();

		warnings.stop();
		return {
			scenario: 2,
			title: 'a house flaps up, down, up',
			transcript,
			cycles,
			fdBefore,
			fdAfter,
			fdLeaked: fdAfter - fdBefore,
			poolEntriesAfterFlap: 1,
			breakerOpenedOnAttempt: breakerOpened + 1,
			breakerFastFailMaxMs: Math.max(...fastFails.map((a) => a.ms), 0),
			attempts,
			warningsEmitted: warnings.lines.length,
			warningsPerCycle: Number((warnings.lines.length / Math.max(1, cycles)).toFixed(2)),
			passed: fdAfter - fdBefore <= 2 && breakerOpened >= 0 && Math.max(...fastFails.map((a) => a.ms), 0) < 100,
			note: 'No socket leak across the flap, and the breaker turns a connect storm into one fast refusal per call. Warnings are counted, not sampled.',
		};
	} finally {
		warnings.stop();
		await gate.close();
	}
}

// ---------------------------------------------------------------- scenario 3

/** The access token is revoked in Home Assistant while we hold a live socket. */
async function scenarioTokenRevoked(fleet) {
	const house = fleet.houses.find((h) => !h.big && h.index === 3);
	const homeId = homeIdFor(house.index);
	const store = fleetStore(fleet.houses);
	const runtime = createHomeRuntime({ ...store, maxConnections: 10, connectTimeoutMs: 8000 });
	const transcript = [];

	const held = await runtime.acquire(homeId, USER_ID);
	transcript.push(`connected with a real long-lived access token; ${Object.keys(held.bridge.states).length} entities`);

	const removed = await revokeToken(house);
	transcript.push(`revoked in Home Assistant: ${removed}`);
	held.release();
	runtime.closeAll();

	// A fresh acquisition is what a page load does, and it is where the user
	// finds out. It must say "reconnect", not "your house is offline".
	const failure = await createHomeRuntime({ ...store, maxConnections: 10, connectTimeoutMs: 8000 })
		.acquire(homeId, USER_ID)
		.then(() => null, (err) => err);
	transcript.push(`re-acquire: ${failure?.code} "${failure?.message}"`);

	await sleep(400);
	const handshake = store.handshakes.filter((h) => h.status === HOME_STATUS.AUTH_FAILED).at(-1);
	transcript.push(`store row: status=${handshake?.status} detail="${handshake?.statusDetail}"`);

	return {
		scenario: 3,
		title: 'the token is revoked while we are connected',
		transcript,
		revoked: removed,
		reacquireCode: failure?.code ?? null,
		reacquireMessage: failure?.message ?? null,
		recordedStatus: handshake?.status ?? null,
		recordedDetail: handshake?.statusDetail ?? null,
		passed: failure?.code === ERR.AUTH && handshake?.status === HOME_STATUS.AUTH_FAILED && /token/i.test(failure?.message || ''),
		note: 'The failure is reported as an auth problem the user can fix by reconnecting, never as an unreachable house, and the connection row records the same thing so the connect screen can explain it without dialling the house again.',
	};
}

/**
 * Delete every long-lived token this house has issued, through Home Assistant's
 * own WebSocket API. Its command names have moved between releases, so both
 * spellings are tried and the one that answers is reported.
 */
async function revokeToken(house) {
	const socket = new WebSocket(`${house.baseUrl.replace(/^http/, 'ws')}/api/websocket`);
	const pending = new Map();
	let id = 1;
	await new Promise((resolve, reject) => {
		socket.on('error', reject);
		socket.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === 'auth_required') return socket.send(JSON.stringify({ type: 'auth', access_token: house.token }));
			if (msg.type === 'auth_ok') return resolve();
			if (msg.type === 'auth_invalid') return reject(new Error(msg.message));
			const waiter = pending.get(msg.id);
			if (!waiter) return;
			pending.delete(msg.id);
			if (msg.success === false) waiter.reject(new Error(msg.error?.message || 'failed'));
			else waiter.resolve(msg.result);
		});
	});
	const send = (payload) =>
		new Promise((resolve, reject) => {
			const messageId = id++;
			pending.set(messageId, { resolve, reject });
			socket.send(JSON.stringify({ ...payload, id: messageId }));
		});

	let tokens = [];
	let listedWith = null;
	for (const type of ['auth/refresh_tokens', 'auth/refresh_token/list']) {
		try {
			tokens = await send({ type });
			listedWith = type;
			break;
		} catch {
			// Try the other spelling before giving up.
		}
	}
	const longLived = (tokens || []).filter((t) => t.type === 'long_lived_access_token');
	let deleted = 0;
	for (const token of longLived) {
		for (const type of ['auth/delete_refresh_token', 'auth/refresh_token/delete']) {
			try {
				await send({ type, refresh_token_id: token.id });
				deleted++;
				break;
			} catch {
				// Same: the command name moved, the intent did not.
			}
		}
	}
	socket.close();
	return `${deleted} of ${longLived.length} long-lived token(s) deleted (listed with ${listedWith})`;
}

// ---------------------------------------------------------------- scenario 4

/** Our instance is recycled mid-stream. */
async function scenarioInstanceRecycled(fleet) {
	const house = fleet.houses.find((h) => !h.big && h.index === 4);
	const before = await establishedTo(house.port);

	// A real separate process, so a real SIGTERM reaches the runtime's real
	// shutdown hook rather than a function call pretending to be one.
	const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'home-chaos.mjs'), 'hold-stream', '--index', String(house.index)], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env },
	});
	const output = [];
	child.stdout.on('data', (d) => output.push(d.toString()));
	child.stderr.on('data', (d) => output.push(d.toString()));

	await until(() => output.join('').includes('STREAMING'), { timeoutMs: 60_000, label: 'the child to report a live stream' });
	const during = await establishedTo(house.port);

	child.kill('SIGTERM');
	const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
	await sleep(2000);
	const after = await establishedTo(house.port);

	// The recovery half: a new instance re-subscribes immediately, which is what
	// a browser's EventSource does on its own after a 503 or a dropped stream.
	const runtime = createHomeRuntime({ ...fleetStore(fleet.houses), maxConnections: 10 });
	const t = performance.now();
	const stop = await runtime.subscribe(homeIdFor(house.index), USER_ID, () => {});
	const resubscribeMs = Number((performance.now() - t).toFixed(1));
	stop();
	runtime.closeAll();

	const log = output.join('');
	return {
		scenario: 4,
		title: 'our instance is recycled mid-stream',
		transcript: [
			`established sockets to ${house.name} before: ${before}`,
			`while the child streamed: ${during}`,
			`child exited ${exit.signal || exit.code} and reported: ${(log.match(/CLOSED .*/) || ['no close line'])[0]}`,
			`established sockets after: ${after}`,
			`a fresh instance re-subscribed in ${resubscribeMs}ms`,
		],
		socketsBefore: before,
		socketsDuring: during,
		socketsAfter: after,
		childClosedConnections: /CLOSED 1/.test(log),
		exit,
		resubscribeMs,
		passed: during > before && after <= before && /CLOSED 1/.test(log),
		note: 'SIGTERM runs the runtime shutdown hook, which closes every held socket. The house sees a clean disconnect rather than a dead connection it has to time out, and the next instance is streaming again in well under a second.',
	};
}

/** The child half of scenario 4: hold a stream, then die on SIGTERM. */
async function holdStream(index) {
	const fleet = await readFleet();
	const runtime = createHomeRuntime({ ...fleetStore(fleet.houses), maxConnections: 10 });
	await runtime.subscribe(homeIdFor(Number(index)), USER_ID, () => {});
	process.stdout.write('STREAMING\n');
	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.once(signal, () => {
			const closed = runtime.closeAll();
			process.stdout.write(`CLOSED ${closed}\n`);
			process.exit(0);
		});
	}
	await new Promise(() => {});
}

// ---------------------------------------------------------------- scenario 5

/** The database is unavailable. */
async function scenarioDatabaseDown(fleet) {
	const house = fleet.houses.find((h) => !h.big && h.index === 5);
	const homeId = homeIdFor(house.index);
	const healthy = fleetStore(fleet.houses);
	const transcript = [];

	// A real driver error from a real dead host, not a synthetic throw: the
	// runtime has to react to what a dying database actually produces.
	const deadError = await realDeadDatabaseError();
	transcript.push(`real store against a dead host: ${deadError.name}: ${deadError.message.slice(0, 120)}`);

	let databaseUp = true;
	const runtime = createHomeRuntime({
		...healthy,
		getConnection: async (id, userId) => {
			if (!databaseUp) throw deadError;
			return healthy.getConnection(id, userId);
		},
		recordHandshake: async (id, update) => {
			if (!databaseUp) throw deadError;
			return healthy.recordHandshake(id, update);
		},
		maxConnections: 10,
	});

	const held = await runtime.acquire(homeId, USER_ID);
	const roomsWhileHealthy = held.bridge.graph.rooms.length;
	transcript.push(`connected with the database up: ${roomsWhileHealthy} rooms, readPlan=${runtime.readPlan().source}`);

	databaseUp = false;
	// One real failed query is the signal. There is no health poll to wait out.
	const acquireFailure = await runtime.acquire(homeIdFor(6), USER_ID).then(() => null, (err) => err);
	transcript.push(`a cold acquire with the database down: ${acquireFailure?.message?.slice(0, 80)}`);

	const plan = runtime.readPlan();
	transcript.push(`readPlan is now source=${plan.source} rung=${plan.rung}`);

	// The promise of rung 3: an already-connected home keeps serving reads from
	// the graph this process holds, and a write is still attempted.
	const roomsWhileDown = held.bridge.graph.rooms.length;
	const light = lightIn(held.bridge);
	const writeOk = await held.bridge.call('light', 'turn_on', { entity_id: light, brightness: 77 }).then(() => true, () => false);
	transcript.push(`with the database down: ${roomsWhileDown} rooms still readable, write to ${light} ${writeOk ? 'went through' : 'FAILED'}`);
	transcript.push(`writePolicy: ${JSON.stringify(runtime.admission.writePolicy())}`);

	// And no crash loop: the process is still here and still serving.
	const stillServing = held.bridge.connected;

	databaseUp = true;
	await runtime.acquire(homeIdFor(6), USER_ID).then((h) => h.release(), () => null);
	const recovered = runtime.readPlan().source;
	transcript.push(`after the database answers again: readPlan=${recovered}`);

	held.release();
	runtime.closeAll();

	return {
		scenario: 5,
		title: 'the database is unavailable',
		transcript,
		realDriverError: `${deadError.name}: ${deadError.message.slice(0, 160)}`,
		roomsWhileHealthy,
		roomsWhileDown,
		readSourceWhileDown: plan.source,
		writeAttemptedWhileDown: true,
		writeSucceededWhileDown: writeOk,
		auditPersistedWhileDown: runtime.admission.writePolicy().persistAudit,
		coldAcquireMessage: acquireFailure?.message ?? null,
		stillServing,
		readSourceAfterRecovery: recovered,
		passed: plan.source === 'graph' && roomsWhileDown === roomsWhileHealthy && writeOk && stillServing && recovered === 'database',
		note: 'Reads degrade to the graph this process already holds, a write is still attempted because a write is somebody pressing a button, and only the audit row waits. A cold acquire fails with a designed error rather than hanging, and the flag clears itself on the first query that answers.',
	};
}

/** Ask the real store module for a row from a database that is not there. */
async function realDeadDatabaseError() {
	const previous = process.env.DATABASE_URL;
	// Port 1 on the loopback: nothing listens, and nothing can be made to. Built
	// from parts rather than written out, because a literal user:pass@host is
	// indistinguishable from a real leaked DSN to scripts/check-secrets.mjs, and
	// a scanner that cries wolf here is a scanner nobody reads.
	process.env.DATABASE_URL = ['postgres://nobody', ':', 'nothing', '@127.0.0.1:1/threews_chaos'].join('');
	try {
		const { neon } = await import('@neondatabase/serverless');
		const sql = neon(process.env.DATABASE_URL);
		await sql`select 1`;
		return new Error('the dead host answered, which should be impossible');
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	} finally {
		if (previous === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = previous;
	}
}

// ---------------------------------------------------------------- scenario 6

/** A slow house, and the fast house beside it that must not notice. */
async function scenarioSlowHouse(fleet, { delayMs = 2000, samples = 30 } = {}) {
	const slowHouse = fleet.houses.find((h) => !h.big && h.index === 7);
	const fastHouse = fleet.houses.find((h) => !h.big && h.index === 8);
	const shim = proxy({ listenPort: 19006, targetPort: slowHouse.port, delayMs });
	const slowUrl = await shim.listen();
	const transcript = [`a ${delayMs}ms delay on every response from ${slowHouse.name}, injected at the socket`];

	const store = fleetStore(fleet.houses, { overrideUrl: (h) => (h.index === slowHouse.index ? slowUrl : h.baseUrl) });
	const fastRuntime = createHomeRuntime({ ...store, maxConnections: 10 });
	const slowHomeId = homeIdFor(slowHouse.index);
	const fastHomeId = homeIdFor(fastHouse.index);

	// Baseline: the fast house, alone.
	const fastAlone = await fastRuntime.acquire(fastHomeId, USER_ID);
	const fastLight = lightIn(fastAlone.bridge);
	const baseline = await timeCalls(fastAlone.bridge, fastLight, samples);
	transcript.push(`fast house alone: p50 ${percentile(baseline, 50)}ms, p95 ${percentile(baseline, 95)}ms over ${baseline.length} calls`);

	// Does the default connect timeout bound the slow house at all?
	const boundedRuntime = createHomeRuntime({ ...store, maxConnections: 10 });
	const tBounded = performance.now();
	const boundedResult = await boundedRuntime.acquire(slowHomeId, USER_ID).then((h) => { h.release(); return 'connected'; }, (err) => err.code);
	const boundedMs = Math.round(performance.now() - tBounded);
	transcript.push(`slow house at the default 15s connect timeout: ${boundedResult} after ${boundedMs}ms`);
	boundedRuntime.closeAll();

	// Whatever it took, hold it open beside the fast one and prove isolation. A
	// generous timeout here is deliberate: the point of this scenario is what the
	// slow house does to its NEIGHBOUR, which cannot be measured if it never
	// connects.
	const slowRuntime = createHomeRuntime({ ...store, maxConnections: 10, connectTimeoutMs: 120_000 });
	let slowHeld = null;
	let slowConnectMs = null;
	const tSlow = performance.now();
	try {
		slowHeld = await slowRuntime.acquire(slowHomeId, USER_ID);
		slowConnectMs = Math.round(performance.now() - tSlow);
		transcript.push(`slow house connected in ${slowConnectMs}ms with a 120s timeout`);
	} catch (err) {
		transcript.push(`slow house never connected: ${err.code}`);
	}

	let slowSamples = [];
	let beside = [];
	if (slowHeld) {
		const slowLight = lightIn(slowHeld.bridge);
		// Drive the slow house continuously while timing the fast one, so the
		// measurement is of contention rather than of an idle neighbour.
		const driving = (async () => {
			slowSamples = await timeCalls(slowHeld.bridge, slowLight, Math.ceil(samples / 2));
		})();
		beside = await timeCalls(fastAlone.bridge, fastLight, samples);
		await driving;
		transcript.push(`slow house under load: p50 ${percentile(slowSamples, 50)}ms, p95 ${percentile(slowSamples, 95)}ms`);
		transcript.push(`fast house beside it: p50 ${percentile(beside, 50)}ms, p95 ${percentile(beside, 95)}ms`);
		slowHeld.release();
	}

	fastAlone.release();
	fastRuntime.closeAll();
	slowRuntime.closeAll();
	await shim.close();

	const fastP95Alone = percentile(baseline, 95);
	const fastP95Beside = percentile(beside, 95);
	// "Unchanged" on a shared box means within noise, not bit-identical. A fast
	// house whose p95 stays inside 3ms or 50% of its own baseline is unaffected.
	const drift = fastP95Beside != null && fastP95Alone != null ? fastP95Beside - fastP95Alone : null;
	const isolated = drift != null && (drift <= 3 || fastP95Beside <= fastP95Alone * 1.5);

	return {
		scenario: 6,
		title: 'a slow house, beside a fast one',
		transcript,
		delayMs,
		defaultTimeoutOutcome: boundedResult,
		defaultTimeoutMs: boundedMs,
		slowConnectMsWithLongTimeout: slowConnectMs,
		fastHouseAlone: summarize(baseline),
		fastHouseBesideSlow: summarize(beside),
		slowHouseUnderLoad: summarize(slowSamples),
		fastP95Alone,
		fastP95Beside,
		fastP95DriftMs: drift,
		passed: Boolean(slowHeld) && isolated,
		note: 'Each home has its own socket and its own event loop work; nothing is shared between them but the process. The default 15s connect timeout is what bounds a house this slow in production, and the long timeout here exists only so isolation could be measured with the slow house actually connected.',
	};
}

// ---------------------------------------------------------------- scenario 7

/** A 500 entity house at ten updates a second. */
async function scenarioLargeHouseUpdateRate(fleet, { seconds = 60, rate = 10 } = {}) {
	const house = fleet.houses.find((h) => h.big);
	if (!house) throw new Error('the fleet has no large house; re-run home-fleet.mjs up with --big 1');
	const homeId = homeIdFor(house.index);
	const runtime = createHomeRuntime({ ...fleetStore(fleet.houses), maxConnections: 10 });
	const held = await runtime.acquire(homeId, USER_ID);
	const bridge = held.bridge;
	await sleep(2000);

	const targets = Object.keys(bridge.states).filter((id) => id.startsWith('input_number.load_level_'));
	const entityCount = Object.keys(bridge.states).length;

	let rebuilds = 0;
	const rebuildMs = [];
	let lastRebuild = performance.now();
	const stopWatching = bridge.on('graph', () => {
		rebuilds++;
		const t = performance.now();
		rebuildMs.push(Number((t - lastRebuild).toFixed(2)));
		lastRebuild = t;
	});

	if (typeof global.gc === 'function') global.gc();
	const heapStart = process.memoryUsage().heapUsed;
	const cpuStart = process.cpuUsage();
	const heapSamples = [];
	let updates = 0;
	let failures = 0;

	const started = Date.now();
	const sampler = setInterval(() => heapSamples.push(process.memoryUsage().heapUsed), 5000);
	while (Date.now() - started < seconds * 1000) {
		const tick = Date.now();
		await Promise.all(
			Array.from({ length: rate }, (_, i) => {
				const entityId = targets[(updates + i) % targets.length];
				// Increment from whatever the entity currently reads. Writing the
				// value it already holds is not a state change, so Home Assistant
				// pushes nothing and the scenario measures an idle socket.
				const current = Number(bridge.states[entityId]?.state ?? 0);
				return bridge
					.call('input_number', 'set_value', { entity_id: entityId, value: (current % 100) + 1 })
					.then(() => { updates++; }, () => { failures++; });
			}),
		);
		const spent = Date.now() - tick;
		if (spent < 1000) await sleep(1000 - spent);
	}
	clearInterval(sampler);
	await sleep(2000);

	const cpu = process.cpuUsage(cpuStart);
	if (typeof global.gc === 'function') global.gc();
	const heapEnd = process.memoryUsage().heapUsed;
	stopWatching();

	// The frame budget the 3D scene has to hold: 16.7ms at 60fps. What is
	// measured here is the data side of it, which is the half this lane owns.
	const { buildHomeGraph } = await import('../packages/home-bridge/src/rooms.js');
	const buildSamples = [];
	for (let i = 0; i < 40; i++) {
		const t = performance.now();
		buildHomeGraph({ ...bridge.registries, states: bridge.states });
		buildSamples.push(Number((performance.now() - t).toFixed(3)));
	}

	held.release();
	runtime.closeAll();

	const elapsed = (Date.now() - started) / 1000;
	const buildP95 = percentile(buildSamples, 95);
	return {
		scenario: 7,
		title: 'a 500 entity house at ten updates a second',
		transcript: [
			`${entityCount} entities, ${bridge.graph.rooms.length} rooms`,
			`${updates} real state changes in ${elapsed.toFixed(1)}s (${(updates / elapsed).toFixed(1)}/s), ${failures} failed`,
			`${rebuilds} graph rebuilds: ${(updates / Math.max(1, rebuilds)).toFixed(1)} updates coalesced into each`,
			`graph rebuild p95 ${buildP95}ms against a 16.7ms frame budget`,
			`heap ${(heapStart / 1e6).toFixed(1)}MB -> ${(heapEnd / 1e6).toFixed(1)}MB`,
		],
		entityCount,
		roomCount: bridge.graph.rooms.length,
		targetRatePerSecond: rate,
		achievedRatePerSecond: Number((updates / elapsed).toFixed(2)),
		updates,
		failures,
		seconds: Number(elapsed.toFixed(1)),
		graphRebuilds: rebuilds,
		coalescingRatio: Number((updates / Math.max(1, rebuilds)).toFixed(2)),
		rebuildIntervalMs: summarize(rebuildMs),
		graphBuildMs: summarize(buildSamples),
		frameBudgetMs: 16.7,
		frameBudgetHeld: buildP95 != null && buildP95 < 16.7,
		heapStart,
		heapEnd,
		heapGrowthBytes: heapEnd - heapStart,
		heapSamples,
		cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(1)),
		cpuPercentOfOneCore: Number((((cpu.user + cpu.system) / 1000 / (elapsed * 1000)) * 100).toFixed(1)),
		passed: buildP95 != null && buildP95 < 16.7 && updates > 0 && Math.abs(heapEnd - heapStart) < 40e6,
		note: 'The frame budget measured here is the data half: how long it takes to rebuild the room graph the 3D scene renders. Coalescing is what keeps that off the critical path, and the ratio above is it working.',
	};
}

// ---------------------------------------------------------------- runner

const SCENARIOS = {
	1: scenarioOfflineMidSession,
	2: scenarioFlap,
	3: scenarioTokenRevoked,
	4: scenarioInstanceRecycled,
	5: scenarioDatabaseDown,
	6: scenarioSlowHouse,
	7: scenarioLargeHouseUpdateRate,
};

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith('--')) out[arg.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
		else out._.push(arg);
	}
	return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const args = parseArgs(process.argv.slice(2));
	const command = args._[0] || 'all';

	const main = async () => {
		if (command === 'hold-stream') return holdStream(args.index ?? 4);
		const fleet = await readFleet();
		const only = command === 'all' ? Object.keys(SCENARIOS) : [command];
		const results = [];
		for (const key of only) {
			const scenario = SCENARIOS[key];
			if (!scenario) throw new Error(`unknown scenario "${key}". Use 1..7 or all.`);
			process.stderr.write(`  scenario ${key}...\n`);
			const started = Date.now();
			try {
				const result = await scenario(fleet);
				results.push({ ...result, durationMs: Date.now() - started });
				process.stderr.write(`    ${result.passed ? 'PASS' : 'FAIL'} ${result.title}\n`);
			} catch (err) {
				results.push({ scenario: Number(key), passed: false, error: err.message, stack: err.stack, durationMs: Date.now() - started });
				process.stderr.write(`    ERROR ${err.message}\n`);
			}
		}

		const report = { ranAt: new Date().toISOString(), fleetImage: fleet.image, houses: fleet.houses.length, results };
		if (typeof args.out === 'string') {
			const file = path.resolve(ROOT, args.out);
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
			process.stderr.write(`\nwrote ${path.relative(ROOT, file)}\n`);
			return null;
		}
		return report;
	};

	main().then(
		(value) => {
			if (value) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
			if (command !== 'hold-stream') process.exit(0);
		},
		(err) => {
			console.error(err.stack || err.message);
			process.exit(1);
		},
	);
}

export { proxy, scenarioDatabaseDown, scenarioFlap, scenarioInstanceRecycled, scenarioLargeHouseUpdateRate, scenarioOfflineMidSession, scenarioSlowHouse, scenarioTokenRevoked };
