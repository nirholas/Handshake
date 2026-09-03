#!/usr/bin/env node
/**
 * A fleet of real Home Assistant instances, for the Home lane's load and chaos work.
 *
 * Every measurement in docs/home-operations.md is taken against containers this
 * script starts: real Home Assistant, real onboarding, real long-lived access
 * tokens, real WebSocket handshakes. Nothing here simulates Home Assistant, and
 * nothing here ever points at somebody's house. The only hosts it touches are
 * containers on this machine.
 *
 *   node scripts/home-fleet.mjs up --homes 10          # a small-house fleet
 *   node scripts/home-fleet.mjs up --homes 4 --big 1 --slow 1
 *   node scripts/home-fleet.mjs status
 *   node scripts/home-fleet.mjs down
 *
 * `up` writes a manifest to tasks/home/fleet.local.json (gitignored: it holds
 * live tokens to running containers). scripts/home-load.mjs reads it.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect as netConnect } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'tasks', 'home', 'fleet.local.json');
const CONFIG_ROOT = path.join(ROOT, '.home-fleet');
const IMAGE = 'ghcr.io/home-assistant/home-assistant:stable';
const NAME_PREFIX = 'threews-ha-';
const BASE_PORT = 18200;
const PASSWORD = 'threews-load-harness';

/** A "large house": the entity count order 14 measures the expensive end against. */
const BIG_HOUSE_ENTITIES = 500;

// ---------------------------------------------------------------- shell helpers

function run(cmd, args, { capture = true } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
		let out = '';
		let err = '';
		child.stdout?.on('data', (d) => (out += d));
		child.stderr?.on('data', (d) => (err += d));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${err.trim() || out.trim()}`));
		});
	});
}

const docker = (...args) => run('docker', args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Home Assistant runs as root inside the container and writes root-owned files
 * into the bind-mounted config directory (blueprints, .storage, the database),
 * so the host user cannot unlink them. Deleting them therefore has to happen as
 * root too, and the cheapest root on this machine is the image we already have.
 */
async function removeAsRoot(target) {
	const parent = path.dirname(target);
	const leaf = path.basename(target);
	await mkdir(parent, { recursive: true });
	await docker('run', '--rm', '-v', `${parent}:/scrub`, '--entrypoint', 'rm', IMAGE, '-rf', `/scrub/${leaf}`).catch(() => null);
	await rm(target, { recursive: true, force: true }).catch(() => null);
}

// ---------------------------------------------------------------- configuration

/**
 * Home Assistant's configuration for one fixture house.
 *
 * `demo:` is the integration the home-bridge tests already use: it produces a
 * realistic mix of lights, covers, locks, climate and sensors that changes on
 * its own, which is what makes the state-burst measurements honest. The extra
 * helper entities exist only on the big house, and they are the ones the load
 * harness drives when it needs a controlled update rate.
 */
function configurationYaml({ big }) {
	const lines = [
		'# Written by scripts/home-fleet.mjs. This is a load fixture, not a home.',
		'default_config:',
		'demo:',
		'logger:',
		'  default: warning',
		'http:',
		'  server_port: 8123',
	];
	if (!big) return `${lines.join('\n')}\n`;

	const booleans = [];
	const numbers = [];
	const texts = [];
	const per = Math.ceil(BIG_HOUSE_ENTITIES / 3);
	for (let i = 0; i < per; i++) {
		booleans.push(`  load_switch_${i}:\n    name: Load Switch ${i}`);
		numbers.push(`  load_level_${i}:\n    name: Load Level ${i}\n    min: 0\n    max: 100\n    step: 1\n    mode: box`);
		texts.push(`  load_note_${i}:\n    name: Load Note ${i}\n    max: 60`);
	}
	lines.push('input_boolean:', ...booleans, 'input_number:', ...numbers, 'input_text:', ...texts);
	return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- onboarding

async function waitForHttp(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastError = 'no response';
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { redirect: 'manual' });
			if (res.status < 500) return true;
			lastError = `status ${res.status}`;
		} catch (err) {
			lastError = err.message;
		}
		await sleep(1000);
	}
	throw new Error(`${url} never came up within ${timeoutMs}ms (${lastError})`);
}

async function postJson(url, body, token) {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${text.slice(0, 200)}`);
	return text ? JSON.parse(text) : null;
}

/**
 * Walk Home Assistant's real onboarding API, exactly as the browser does, and
 * come back with an access token. There is no shortcut here and there should
 * not be: an instance that has not been onboarded rejects every other call.
 */
async function onboard(baseUrl, username) {
	const clientId = `${baseUrl}/`;
	const { auth_code: code } = await postJson(`${baseUrl}/api/onboarding/users`, {
		client_id: clientId,
		name: 'Load Harness Owner',
		username,
		password: PASSWORD,
		language: 'en',
	});

	const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId });
	const res = await fetch(`${baseUrl}/auth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: form,
	});
	if (!res.ok) throw new Error(`token exchange -> ${res.status} ${await res.text()}`);
	const { access_token: accessToken } = await res.json();

	await postJson(
		`${baseUrl}/api/onboarding/core_config`,
		{ client_id: clientId },
		accessToken,
	).catch(() => null);
	await postJson(`${baseUrl}/api/onboarding/analytics`, {}, accessToken).catch(() => null);
	await postJson(`${baseUrl}/api/onboarding/integration`, { client_id: clientId, redirect_uri: clientId }, accessToken).catch(() => null);

	return accessToken;
}

// ---------------------------------------------------------------- websocket work

/**
 * A minimal authenticated WebSocket session against one instance.
 *
 * home-assistant-js-websocket is the client the product uses, but it is built to
 * hold a connection open and reconnect forever, which is the wrong shape for a
 * three-message provisioning errand. This is the errand-sized version and it is
 * used for exactly two things: minting the long-lived token and seeding the area
 * registry.
 */
async function wsSession(baseUrl, token, work) {
	const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/websocket`;
	const socket = new WebSocket(wsUrl);
	const pending = new Map();
	let id = 1;

	const ready = new Promise((resolve, reject) => {
		socket.on('error', reject);
		socket.on('close', () => reject(new Error('socket closed before auth completed')));
		socket.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === 'auth_required') {
				socket.send(JSON.stringify({ type: 'auth', access_token: token }));
				return;
			}
			if (msg.type === 'auth_ok') {
				resolve();
				return;
			}
			if (msg.type === 'auth_invalid') {
				reject(new Error(`auth rejected: ${msg.message}`));
				return;
			}
			const waiter = pending.get(msg.id);
			if (!waiter) return;
			pending.delete(msg.id);
			if (msg.success === false) waiter.reject(new Error(msg.error?.message || 'command failed'));
			else waiter.resolve(msg.result);
		});
	});

	await ready;
	const send = (payload) =>
		new Promise((resolve, reject) => {
			const messageId = id++;
			pending.set(messageId, { resolve, reject });
			socket.send(JSON.stringify({ ...payload, id: messageId }));
		});

	try {
		return await work(send);
	} finally {
		socket.close();
	}
}

/**
 * Home Assistant's demo integration ships entities but no areas, and the room
 * graph the 3D scene renders is built from the area registry. A fixture house
 * with zero areas would understate the graph rebuild cost, so every house in the
 * fleet gets a real floor and real areas through the real registry API.
 */
const FLOORS = [
	{ name: 'Ground floor', areas: ['Kitchen', 'Living Room', 'Hallway', 'Garage'] },
	{ name: 'Upstairs', areas: ['Bedroom', 'Bathroom', 'Study'] },
];

async function seedRegistry(send) {
	const areas = [];
	for (const floor of FLOORS) {
		let floorId = null;
		try {
			const created = await send({ type: 'config/floor_registry/create', name: floor.name });
			floorId = created?.floor_id ?? null;
		} catch {
			// Instances older than the floor registry are still valid fixtures; the
			// areas below simply land unassigned, which the graph already handles.
		}
		for (const name of floor.areas) {
			try {
				const area = await send({ type: 'config/area_registry/create', name, ...(floorId ? { floor_id: floorId } : {}) });
				areas.push(area);
			} catch {
				// A duplicate name on a re-run is not a failure.
			}
		}
	}

	// Spread the house's entities across those areas, so the graph has real rooms
	// with real rollups rather than one giant unassigned bucket.
	const entities = await send({ type: 'config/entity_registry/list' });
	const assignable = entities.filter((e) => !e.area_id);
	let assigned = 0;
	for (let i = 0; i < assignable.length && areas.length; i++) {
		const area = areas[i % areas.length];
		try {
			await send({ type: 'config/entity_registry/update', entity_id: assignable[i].entity_id, area_id: area.area_id });
			assigned++;
		} catch {
			// Some entities are not registry entries and cannot carry an area.
		}
	}
	return { floors: FLOORS.length, areas: areas.length, entitiesAssigned: assigned };
}

async function mintLongLivedToken(send, clientName) {
	return send({ type: 'auth/long_lived_access_token', client_name: clientName, lifespan: 3650 });
}

// ---------------------------------------------------------------- latency shim

/**
 * A TCP proxy that delays every byte in both directions by a fixed amount.
 *
 * Chaos scenario 6 needs a genuinely slow house, and slowing one is the only
 * honest way to prove the fast one beside it is unaffected. Delaying at the
 * socket rather than inside Home Assistant means the slowness looks exactly like
 * a distant house on a bad link, which is the real-world failure being modelled.
 */
export function startLatencyShim({ listenPort, targetPort, delayMs, targetHost = '127.0.0.1' }) {
	const server = createServer((client) => {
		const upstream = netConnect(targetPort, targetHost);
		const pipeDelayed = (from, to) => {
			from.on('data', (chunk) => {
				setTimeout(() => {
					if (!to.destroyed) to.write(chunk);
				}, delayMs);
			});
			from.on('close', () => setTimeout(() => to.destroy(), delayMs + 50));
			from.on('error', () => to.destroy());
		};
		pipeDelayed(client, upstream);
		pipeDelayed(upstream, client);
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(listenPort, '127.0.0.1', () => resolve(server));
	});
}

// ---------------------------------------------------------------- fleet lifecycle

async function listContainers() {
	const out = await docker('ps', '-a', '--filter', `name=${NAME_PREFIX}`, '--format', '{{.Names}}\t{{.Status}}');
	return out
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [name, status] = line.split('\t');
			return { name, status };
		});
}

async function startHouse({ index, big }) {
	const name = `${NAME_PREFIX}${index}`;
	const port = BASE_PORT + index;
	const configDir = path.join(CONFIG_ROOT, String(index));

	await docker('rm', '-f', name).catch(() => null);
	await removeAsRoot(configDir);
	await mkdir(configDir, { recursive: true });
	await writeFile(path.join(configDir, 'configuration.yaml'), configurationYaml({ big }));
	await writeFile(path.join(configDir, 'automations.yaml'), '[]\n');

	await docker(
		'run', '-d',
		'--name', name,
		'-p', `127.0.0.1:${port}:8123`,
		'-e', 'TZ=UTC',
		'-v', `${configDir}:/config`,
		IMAGE,
	);

	const baseUrl = `http://127.0.0.1:${port}`;
	const startedAt = Date.now();
	await waitForHttp(`${baseUrl}/`, big ? 300_000 : 180_000);
	const bootMs = Date.now() - startedAt;

	const accessToken = await onboard(baseUrl, `owner${index}`);
	const registry = await wsSession(baseUrl, accessToken, seedRegistry);
	const token = await wsSession(baseUrl, accessToken, (send) => mintLongLivedToken(send, `three.ws load harness ${index}`));

	const states = await fetch(`${baseUrl}/api/states`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());

	return {
		index,
		name,
		baseUrl,
		port,
		token,
		big: Boolean(big),
		bootMs,
		entityCount: states.length,
		registry,
	};
}

async function up({ homes, big, slow }) {
	await mkdir(path.dirname(MANIFEST), { recursive: true });
	console.log(`starting ${homes} Home Assistant container(s) (${big} large), image ${IMAGE}`);

	// Home Assistant's first boot is CPU heavy and largely serial inside the
	// container, so starting them in one wave is faster than in sequence but a
	// full parallel storm on a 16 core box starves each one. Four at a time is
	// the measured sweet spot on this machine.
	const specs = Array.from({ length: homes }, (_, i) => ({ index: i, big: i < big }));
	const houses = [];
	const WAVE = 4;
	for (let i = 0; i < specs.length; i += WAVE) {
		const wave = specs.slice(i, i + WAVE);
		const settled = await Promise.all(
			wave.map((spec) =>
				startHouse(spec).then(
					(house) => ({ ok: true, house }),
					(error) => ({ ok: false, index: spec.index, error: error.message }),
				),
			),
		);
		for (const result of settled) {
			if (result.ok) {
				houses.push(result.house);
				console.log(`  up  ${result.house.name}  ${result.house.baseUrl}  ${result.house.entityCount} entities  boot ${result.house.bootMs}ms`);
			} else {
				console.error(`  FAIL house ${result.index}: ${result.error}`);
			}
		}
	}

	if (!houses.length) throw new Error('no house came up; nothing to measure');

	const manifest = {
		createdAt: new Date().toISOString(),
		image: IMAGE,
		slowShim: slow ? { listenPort: BASE_PORT + 900, delayMs: 2000, targetIndex: houses[houses.length - 1].index } : null,
		houses,
	};
	await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`\nmanifest: ${path.relative(ROOT, MANIFEST)}  (${houses.length} houses)`);
	return manifest;
}

async function down() {
	const containers = await listContainers();
	for (const { name } of containers) {
		await docker('rm', '-f', name).catch(() => null);
		console.log(`  removed ${name}`);
	}
	await removeAsRoot(CONFIG_ROOT);
	await rm(MANIFEST, { force: true });
	console.log(containers.length ? `\n${containers.length} container(s) removed` : 'nothing running');
}

/**
 * Rebuild one house in place and re-record it in the manifest.
 *
 * A fleet is not immutable: a chaos run that revokes a credential, or a
 * container that dies badly, leaves one house unusable while the other eleven
 * are fine. Rebuilding the whole fleet to fix one of them costs minutes, so this
 * replaces exactly the house named and leaves the rest alone.
 */
async function repair({ index, big }) {
	const manifest = await readFleet();
	const existing = manifest.houses.find((h) => h.index === index);
	if (!existing) throw new Error(`no house ${index} in the manifest`);
	console.log(`rebuilding house ${index} (${existing.name})`);

	const rebuilt = await startHouse({ index, big: big ?? existing.big });
	manifest.houses = manifest.houses.map((h) => (h.index === index ? rebuilt : h));
	manifest.repairedAt = new Date().toISOString();
	await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`  up  ${rebuilt.name}  ${rebuilt.baseUrl}  ${rebuilt.entityCount} entities  boot ${rebuilt.bootMs}ms`);
	return rebuilt;
}

async function status() {
	const containers = await listContainers();
	if (!containers.length) {
		console.log('no fleet containers');
		return;
	}
	for (const { name, status: state } of containers) console.log(`  ${name}\t${state}`);
	const manifest = await readFile(MANIFEST, 'utf8').then(JSON.parse).catch(() => null);
	if (manifest) {
		console.log(`\nmanifest from ${manifest.createdAt}: ${manifest.houses.length} houses, ${manifest.houses.reduce((n, h) => n + h.entityCount, 0)} entities total`);
	}
}

export async function readFleet() {
	const raw = await readFile(MANIFEST, 'utf8').catch(() => null);
	if (!raw) throw new Error(`no fleet manifest at ${path.relative(ROOT, MANIFEST)}. Run: node scripts/home-fleet.mjs up --homes 10`);
	return JSON.parse(raw);
}

export { MANIFEST, NAME_PREFIX, BASE_PORT };

// ---------------------------------------------------------------- cli

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
	const command = args._[0] || 'status';
	const run = {
		up: () => up({ homes: Number(args.homes || 10), big: Number(args.big || 0), slow: Boolean(args.slow) }),
		repair: () => repair({ index: Number(args.index), big: args.big === undefined ? undefined : Boolean(args.big) }),
		down,
		status,
	}[command];
	if (!run) {
		console.error(`unknown command "${command}". Use: up | repair --index N | down | status`);
		process.exit(2);
	}
	run().then(
		() => process.exit(0),
		(err) => {
			console.error(err.stack || err.message);
			process.exit(1);
		},
	);
}
