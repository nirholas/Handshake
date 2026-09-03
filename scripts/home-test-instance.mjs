#!/usr/bin/env node
/**
 * A real Home Assistant, on demand, for the home lane's live tests.
 *
 * Every live test in this lane needs the same thing: an instance that is
 * onboarded, holds a long-lived token, and contains a house worth asserting on
 * (floors, areas, a lock, scenes, the MCP server). Before this script each test
 * and each developer built that by hand from the README, which is how six
 * slightly different instances came to exist and how a version difference could
 * hide as "works on my machine".
 *
 *   node scripts/home-test-instance.mjs --up --onboard --seed --json
 *   node scripts/home-test-instance.mjs --down
 *
 * Flags combine in that order, so one command takes you from nothing to a
 * seeded house and prints the URL and token. Every step is idempotent: running
 * it twice is a no-op that reprints the same connection details.
 *
 * Safety: this machine runs concurrent agents, several of which keep their own
 * Home Assistant containers alive. The harness therefore stamps every container
 * it creates with a label and REFUSES to stop, restart or remove a container
 * that does not carry it. It also never touches a config directory outside the
 * gitignored `.ha-config-*` prefix, because those directories hold real access
 * tokens.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The label that marks a container as ours. Nothing without it is ever touched. */
const LABEL = 'ws.three.home-test';
const IMAGE = 'ghcr.io/home-assistant/home-assistant';
const CLIENT_NAME = 'three.ws home lane';

const USER = { name: 'Home Lane', username: 'threews', password: 'threews-home-lane' };

/**
 * The entry point lives at the bottom of this file, below every declaration it
 * uses. A top-level call above a `class` declaration reads its binding in the
 * temporal dead zone, which throws on every engine that checks it.
 */
async function main() {
	const argv = process.argv.slice(2);
	const opts = parseArgs(argv);

	if (opts.help || !argv.length) {
		usage();
		process.exit(argv.length ? 0 : 1);
	}

	const instance = describeInstance(opts.name, opts.version);
	log = opts.json ? () => {} : (...args) => console.error(...args);
	emit = (payload) => {
		if (opts.json) console.log(JSON.stringify({ ok: true, ...payload }, null, '\t'));
		else if (payload.baseUrl) {
			console.log(`HOME_ASSISTANT_URL=${payload.baseUrl}`);
			if (payload.token) console.log(`HOME_ASSISTANT_TOKEN=${payload.token}`);
		}
	};

	try {
		// Several vitest forks reach for the same named instance at once, and two
		// simultaneous `docker run --name` calls means one of them fails. The lock
		// makes the second caller wait for the first to finish building the house
		// and then reuse it, which is what "idempotent" has to mean under
		// concurrency.
		const state = await withLock(instance, async () => {
			let current = readState(instance);

			if (opts.down) {
				const removed = await down(instance, current);
				emit({ action: 'down', name: instance.name, ...removed });
				return null;
			}

			if (opts.up) current = await up(instance, current, { seedNow: opts.seed });
			if (!current) current = requireState(instance);

			if (opts.onboard) current = await onboard(instance, current);
			if (opts.seed) current = await seed(instance, current, { alreadyInConfig: Boolean(opts.up) });
			return current;
		});
		if (!state) return;

		emit({
			action: 'ready',
			name: instance.name,
			version: state.version,
			haVersion: state.haVersion || null,
			container: instance.container,
			port: state.port,
			baseUrl: state.baseUrl,
			token: state.token || null,
			seeded: Boolean(state.seeded),
			seed: state.seedResult || null,
			configDir: path.relative(ROOT, instance.configDir),
		});
	} catch (err) {
		if (opts.json) console.log(JSON.stringify({ ok: false, error: err.message }, null, '\t'));
		console.error(`home-test-instance: ${err.message}`);
		process.exitCode = 1;
	}
}

/** Progress goes to stderr so --json owns stdout. Bound by main(). */
let log = () => {};
let emit = () => {};

// ---------------------------------------------------------------- lifecycle

/**
 * Start a container on a free port and wait until Home Assistant answers.
 * Reuses a running instance rather than replacing it, so two tests that both
 * ask for the same named instance share one house instead of racing.
 */
async function up(inst, state, { seedNow }) {
	const existing = await inspect(inst.container);
	if (existing?.running && state?.port) {
		log(`[up] reusing ${inst.container} on :${state.port}`);
		await waitForHomeAssistant(state.baseUrl);
		return writeState(inst, { ...state, running: true });
	}
	if (existing && !existing.running) {
		assertOurs(existing, inst.container);
		await docker(['rm', '-f', inst.container]);
	}

	fs.mkdirSync(inst.configDir, { recursive: true });
	// Writing configuration.yaml before the first boot is the difference between
	// a 40s start and a 40s start plus a 40s restart. When --up and --seed are
	// asked for together the demo house is therefore configured up front; a
	// later standalone --seed appends and restarts instead.
	writeConfiguration(inst, { demo: seedNow });

	const port = await freePort();
	log(`[up] starting ${inst.image} on :${port}`);
	await docker([
		'run', '-d',
		'--name', inst.container,
		'--label', `${LABEL}=1`,
		'--label', `${LABEL}.name=${inst.name}`,
		'-p', `127.0.0.1:${port}:8123`,
		'-v', `${inst.configDir}:/config`,
		'-e', 'TZ=UTC',
		inst.image,
	]);

	const baseUrl = `http://127.0.0.1:${port}`;
	const next = writeState(inst, { name: inst.name, version: inst.version, port, baseUrl, running: true, demoInConfig: Boolean(seedNow) });
	const haVersion = await waitForHomeAssistant(baseUrl);
	log(`[up] ${inst.container} is up, Home Assistant ${haVersion || 'unknown'}`);
	return writeState(inst, { ...next, haVersion });
}

/**
 * Remove the container and its config directory. Refuses anything it did not
 * create, and reports honestly when there was nothing to remove.
 */
async function down(inst, state) {
	const existing = await inspect(inst.container);
	let removedContainer = false;
	if (existing) {
		assertOurs(existing, inst.container);
		await docker(['rm', '-f', inst.container]);
		removedContainer = true;
		log(`[down] removed ${inst.container}`);
	}

	let removedConfig = false;
	const dir = inst.configDir;
	if (fs.existsSync(dir)) {
		if (!path.basename(dir).startsWith('.ha-config-') || path.dirname(dir) !== ROOT) {
			throw new Error(`refusing to delete ${dir}: not a harness config directory`);
		}
		// Home Assistant runs as root in the container, so /config comes back
		// owned by root and an ordinary rm cannot clear it. Hand ownership back
		// through a throwaway container on the image we already have locally,
		// then delete from here. A config directory left behind is not litter:
		// it holds a working access token.
		await docker([
			'run', '--rm',
			'-v', `${dir}:/target`,
			'--entrypoint', 'chown',
			inst.image,
			'-R', `${process.getuid()}:${process.getgid()}`, '/target',
		]).catch((err) => log(`[down] could not reclaim ownership of ${path.relative(ROOT, dir)}: ${err.message}`));
		fs.rmSync(dir, { recursive: true, force: true });
		removedConfig = true;
		log(`[down] removed ${path.relative(ROOT, dir)}`);
	}
	if (!removedContainer && !removedConfig) log(`[down] nothing to remove for "${inst.name}"`);
	return { removedContainer, removedConfig };
}

// ---------------------------------------------------------------- onboarding

/**
 * Walk Home Assistant's real onboarding API and mint a long-lived token.
 *
 * This is the flow the browser performs on a fresh install: create the owner,
 * exchange the returned auth code for a session, finish the remaining steps,
 * then ask the WebSocket API for a long-lived token. No file is edited to fake
 * a user into existence.
 */
async function onboard(inst, state) {
	if (state.token && (await tokenWorks(state.baseUrl, state.token))) {
		log('[onboard] already onboarded, token still valid');
		return state;
	}

	const clientId = `${state.baseUrl}/`;
	const steps = await json(`${state.baseUrl}/api/onboarding`);
	const done = new Set(steps.filter((s) => s.done).map((s) => s.step));

	// An instance can be onboarded while the harness holds no token: an
	// interrupted run, or a config directory that outlived its state file. The
	// owner account is one this harness created and whose password it knows, so
	// the recovery is a real login rather than a dead end.
	let session;
	if (done.has('user')) {
		log('[onboard] already onboarded, signing in as the owner');
		session = await exchangeCode(state.baseUrl, clientId, await login(state.baseUrl, clientId));
	} else {
		log('[onboard] creating the owner account');
		const { auth_code: userCode } = await json(`${state.baseUrl}/api/onboarding/users`, {
			method: 'POST',
			body: { client_id: clientId, ...USER, language: 'en' },
		});
		session = await exchangeCode(state.baseUrl, clientId, userCode);
	}

	// core_config and analytics are separate steps and each has appeared and
	// moved between releases, so a missing one is skipped rather than fatal.
	for (const step of done.has('user') ? [] : ['core_config', 'analytics']) {
		if (done.has(step)) continue;
		await json(`${state.baseUrl}/api/onboarding/${step}`, {
			method: 'POST',
			token: session.access_token,
			body: step === 'analytics' ? { preferences: { base: false } } : {},
			optional: true,
		});
	}
	if (!done.has('integration')) {
		await json(`${state.baseUrl}/api/onboarding/integration`, {
			method: 'POST',
			token: session.access_token,
			body: { client_id: clientId, redirect_uri: clientId },
			optional: true,
		});
	}

	log('[onboard] minting a long-lived access token');
	const ws = await WsSession.open(state.baseUrl, session.access_token);
	let token;
	try {
		token = await ws.send({
			type: 'auth/long_lived_access_token',
			client_name: `${CLIENT_NAME} ${Date.now()}`,
			lifespan: 30,
		});
	} finally {
		ws.close();
	}

	return writeState(inst, { ...state, token, haVersion: ws.haVersion || state.haVersion });
}

/**
 * Home Assistant's real username/password login flow, which is what the login
 * page performs. Returns the authorization code to exchange for a session.
 */
async function login(baseUrl, clientId) {
	const flow = await json(`${baseUrl}/auth/login_flow`, {
		method: 'POST',
		body: { client_id: clientId, handler: ['homeassistant', null], redirect_uri: clientId, type: 'authorize' },
	});
	const result = await json(`${baseUrl}/auth/login_flow/${flow.flow_id}`, {
		method: 'POST',
		body: { client_id: clientId, username: USER.username, password: USER.password },
	});
	if (result?.type !== 'create_entry' || !result.result) {
		throw new Error(`login as ${USER.username} did not produce an auth code: ${JSON.stringify(result).slice(0, 200)}`);
	}
	return result.result;
}

async function exchangeCode(baseUrl, clientId, code) {
	const res = await fetch(`${baseUrl}/auth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId }),
	});
	if (!res.ok) throw new Error(`token exchange returned ${res.status}: ${await res.text()}`);
	return res.json();
}

// ---------------------------------------------------------------- seeding

/**
 * Turn a bare instance into a house: demo entities, a floor, three areas with
 * entities assigned, two scenes, the MCP server, and a lock exposed to Assist.
 *
 * Everything is created through the real APIs and everything is idempotent, so
 * a second --seed finds what the first one made and changes nothing.
 */
async function seed(inst, state, { alreadyInConfig }) {
	if (!state.token) throw new Error('seed needs a token: run --onboard first.');

	if (!state.demoInConfig && !alreadyInConfig) {
		log('[seed] enabling the demo integration and restarting');
		writeConfiguration(inst, { demo: true });
		const existing = await inspect(inst.container);
		assertOurs(existing, inst.container);
		await docker(['restart', inst.container]);
		await waitForHomeAssistant(state.baseUrl);
		state = writeState(inst, { ...state, demoInConfig: true });
	}

	const ws = await WsSession.open(state.baseUrl, state.token);
	const created = { floors: 0, areas: 0, assigned: 0, scenes: 0, exposed: 0, mcp: false };
	try {
		await waitFor(
			async () => {
				const states = await ws.send({ type: 'get_states' });
				return states.some((s) => s.entity_id.startsWith('light.')) && states.some((s) => s.entity_id.startsWith('lock.'));
			},
			{ timeout: 120_000, label: 'demo entities to appear' },
		);

		const floor = await ensureFloor(ws, 'Ground Floor');
		created.floors = floor.created ? 1 : 0;

		const states = await ws.send({ type: 'get_states' });
		const byDomain = (domain) => states.filter((s) => s.entity_id.startsWith(`${domain}.`)).map((s) => s.entity_id);
		const lights = byDomain('light');
		const locks = byDomain('lock');
		const climate = byDomain('climate');

		// Three real rooms with real entities in them, which is the minimum the
		// room graph, the 3D scene and the per-room rollups all need to mean
		// anything. Entities are taken from whatever the demo actually provides
		// rather than hardcoded, so a demo-integration change does not break this.
		const plan = [
			{ name: 'Living Room', entities: [lights[0], climate[0]].filter(Boolean) },
			{ name: 'Bedroom', entities: [lights[1]].filter(Boolean) },
			{ name: 'Front Door', entities: [locks[0], lights[2]].filter(Boolean) },
		];

		for (const room of plan) {
			const area = await ensureArea(ws, room.name, floor.floor_id);
			if (area.created) created.areas += 1;
			for (const entityId of room.entities) {
				// A demo entity with no unique_id never reaches the entity registry
				// and cannot hold an area. Count what actually landed, so the seed
				// report is a measurement rather than a count of attempts.
				const assigned = await ws
					.send({ type: 'config/entity_registry/update', entity_id: entityId, area_id: area.area_id })
					.then(() => true)
					.catch(() => false);
				if (assigned) created.assigned += 1;
				else created.unregistered = [...(created.unregistered || []), entityId];
			}
		}

		// The two scenes every intent test in the lane resolves against. Bedtime
		// deliberately touches the lock, because "good night locks the door" is
		// the case where the confirmation gate has to fire on a macro.
		const scenes = [
			{ id: 'threews_bedtime', name: 'Bedtime', entities: sceneEntities({ lights: lights.slice(0, 2), off: true, lock: locks[0], lockState: 'locked' }) },
			{ id: 'threews_away_mode', name: 'Away Mode', entities: sceneEntities({ lights, off: true, lock: locks[0], lockState: 'locked' }) },
		];
		for (const scene of scenes) {
			const res = await fetch(`${state.baseUrl}/api/config/scene/config/${scene.id}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ id: scene.id, name: scene.name, entities: scene.entities }),
			});
			if (res.ok) created.scenes += 1;
			else log(`[seed] scene ${scene.name} returned ${res.status}`);
		}
		await ws.send({ type: 'call_service', domain: 'scene', service: 'reload', service_data: {} }).catch(() => {});

		// Expose the lock to Assist. This is the configuration that makes Home
		// Assistant's own intent__HassTurnOff unlock a door, which is the finding
		// the whole safety gate exists for: the lane must test against a house
		// where that is actually reachable.
		if (locks[0]) {
			created.exposed = (await exposeToAssist(ws, [locks[0], ...lights.slice(0, 1)])) ? 1 : 0;
			created.exposeCommand = ws.exposeCommand || null;
		}

		created.mcp = await ensureMcpServer(state);
		created.entities = { lights: lights.length, locks: locks.length, climate: climate.length };
		created.lock = locks[0] || null;
		created.light = lights[0] || null;
	} finally {
		ws.close();
	}

	log(
		`[seed] ${created.areas} areas created, ${created.assigned} entities assigned, ${created.scenes} scenes, mcp_server ${created.mcp ? 'enabled' : 'unavailable'}`,
	);
	return writeState(inst, { ...state, seeded: true, seedResult: created });
}

function sceneEntities({ lights = [], off = true, lock, lockState = 'locked' }) {
	const entities = {};
	for (const id of lights) entities[id] = off ? 'off' : 'on';
	if (lock) entities[lock] = lockState;
	return entities;
}

async function ensureFloor(ws, name) {
	const floors = await ws.send({ type: 'config/floor_registry/list' }).catch(() => []);
	const found = floors.find((f) => f.name === name);
	if (found) return { ...found, created: false };
	const made = await ws.send({ type: 'config/floor_registry/create', name, level: 0 });
	return { ...made, created: true };
}

async function ensureArea(ws, name, floorId) {
	const areas = await ws.send({ type: 'config/area_registry/list' });
	const found = areas.find((a) => a.name === name);
	if (found) {
		if (floorId && found.floor_id !== floorId) {
			await ws.send({ type: 'config/area_registry/update', area_id: found.area_id, floor_id: floorId }).catch(() => {});
		}
		return { ...found, created: false };
	}
	const made = await ws.send({ type: 'config/area_registry/create', name, ...(floorId ? { floor_id: floorId } : {}) });
	if (floorId && !made.floor_id) {
		await ws.send({ type: 'config/area_registry/update', area_id: made.area_id, floor_id: floorId }).catch(() => {});
	}
	return { ...made, created: true };
}

/**
 * Set up the `mcp_server` integration through its real config flow. It is a
 * config-entry integration with no YAML form, so this drives the same HTTP flow
 * the Settings UI drives. Returns false when the release does not ship it,
 * which is a supported outcome: the MCP channel is an upgrade, not a
 * requirement.
 */
async function ensureMcpServer(state) {
	const headers = { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' };
	const entries = await fetch(`${state.baseUrl}/api/config/config_entries/entry`, { headers })
		.then((r) => (r.ok ? r.json() : []))
		.catch(() => []);
	if (entries.some((e) => e.domain === 'mcp_server')) return true;

	const start = await fetch(`${state.baseUrl}/api/config/config_entries/flow`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ handler: 'mcp_server', show_advanced_options: false }),
	});
	if (!start.ok) return false;
	const flow = await start.json();
	if (flow.type === 'create_entry') return true;
	if (!flow.flow_id) return false;

	// The single step asks which LLM API to expose. Releases disagree on the
	// shape: a single-value select in the release the integration landed in, a
	// multi-select since. Read the flow's own schema rather than sniffing a
	// version string, and send whichever shape this instance asked for.
	const finish = await fetch(`${state.baseUrl}/api/config/config_entries/flow/${flow.flow_id}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ llm_hass_api: llmApiValue(flow.data_schema) }),
	});
	if (!finish.ok) return false;
	const result = await finish.json();
	return result.type === 'create_entry';
}

/**
 * "assist" in the shape this instance's config flow asks for.
 *
 * @param {Array} schema the flow's own data_schema
 */
function llmApiValue(schema) {
	const field = (Array.isArray(schema) ? schema : []).find((f) => f.name === 'llm_hass_api');
	const options = field?.selector?.select?.options || [];
	const assist = options.find((o) => (o?.value ?? o) === 'assist');
	const value = assist ? (assist.value ?? assist) : 'assist';
	return field?.selector?.select?.multiple ? [value] : value;
}

/**
 * Expose entities to Assist, which is what makes Home Assistant's own
 * `intent__HassTurnOff` able to unlock a real door. The command was
 * `homeassistant/expose_entity/set` when exposure settings landed and is
 * `homeassistant/expose_entity` now, so ask the instance which one it answers
 * to instead of branching on a version number.
 */
async function exposeToAssist(ws, entityIds) {
	const ids = entityIds.filter(Boolean);
	if (!ids.length) return false;
	const candidates = ['homeassistant/expose_entity', 'homeassistant/expose_entity/set'];
	for (const type of candidates) {
		try {
			await ws.send({ type, assistants: ['conversation'], entity_ids: ids, should_expose: true });
			ws.exposeCommand = type;
			return true;
		} catch (err) {
			if (!/unknown_command/.test(err.message)) throw err;
		}
	}
	return false;
}

// ---------------------------------------------------------------- websocket

/** A minimal authenticated Home Assistant WebSocket session. */
class WsSession {
	static async open(baseUrl, token) {
		const url = `${baseUrl.replace(/^http/, 'ws')}/api/websocket`;
		const socket = new WebSocket(url);
		const session = new WsSession(socket);
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`websocket handshake to ${url} timed out`)), 30_000);
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error(`could not open ${url}`));
			};
			socket.onclose = () => {
				clearTimeout(timer);
				reject(new Error(`${url} closed during the handshake`));
			};
			socket.onmessage = (event) => {
				const msg = JSON.parse(event.data);
				if (msg.type === 'auth_required') {
					session.haVersion = msg.ha_version || null;
					socket.send(JSON.stringify({ type: 'auth', access_token: token }));
					return;
				}
				if (msg.type === 'auth_ok') {
					session.haVersion = msg.ha_version || session.haVersion;
					clearTimeout(timer);
					socket.onclose = null;
					session.listen();
					resolve();
					return;
				}
				if (msg.type === 'auth_invalid') {
					clearTimeout(timer);
					reject(new Error('Home Assistant rejected the token.'));
				}
			};
		});
		return session;
	}

	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		this.haVersion = null;
	}

	listen() {
		this.socket.onmessage = (event) => {
			const msg = JSON.parse(event.data);
			if (msg.type !== 'result') return;
			const entry = this.pending.get(msg.id);
			if (!entry) return;
			this.pending.delete(msg.id);
			if (msg.success) entry.resolve(msg.result);
			else entry.reject(new Error(`${msg.error?.code || 'error'}: ${msg.error?.message || 'unknown'}`));
		};
		this.socket.onclose = () => {
			for (const entry of this.pending.values()) entry.reject(new Error('websocket closed'));
			this.pending.clear();
		};
	}

	send(message) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${message.type} timed out`));
			}, 30_000);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
			this.socket.send(JSON.stringify({ ...message, id }));
		});
	}

	close() {
		try {
			this.socket.close();
		} catch {
			// A socket that is already gone needs no closing.
		}
	}
}

// ---------------------------------------------------------------- helpers

async function waitForHomeAssistant(baseUrl) {
	let version = null;
	await waitFor(
		async () => {
			const res = await fetch(`${baseUrl}/api/onboarding`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
			if (res && res.ok) return true;
			// A fully onboarded instance answers /api/onboarding with 401 rather
			// than 200, and that is just as good a readiness signal.
			return Boolean(res && res.status === 401);
		},
		{ timeout: 180_000, label: `${baseUrl} to answer` },
	);
	const cfg = await fetch(`${baseUrl}/manifest.json`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
	if (cfg?.ok) {
		const body = await cfg.json().catch(() => null);
		version = body?.version || null;
	}
	return version;
}

async function tokenWorks(baseUrl, token) {
	const res = await fetch(`${baseUrl}/api/`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
	return Boolean(res?.ok);
}

/**
 * Poll a condition to a deadline. Every wait in this harness is a wait for a
 * condition, never a sleep for a guessed duration: a sleep is the seed of every
 * flaky test this lane could grow.
 */
async function waitFor(condition, { timeout = 60_000, interval = 1000, label = 'condition' } = {}) {
	const deadline = Date.now() + timeout;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			if (await condition()) return true;
			lastError = null;
		} catch (err) {
			lastError = err;
		}
		await new Promise((r) => setTimeout(r, interval));
	}
	throw new Error(`timed out after ${Math.round(timeout / 1000)}s waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function json(url, { method = 'GET', body, token, optional = false } = {}) {
	const headers = {};
	if (body) headers['content-type'] = 'application/json';
	if (token) headers.authorization = `Bearer ${token}`;
	const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
	if (!res.ok) {
		if (optional) return null;
		throw new Error(`${method} ${new URL(url).pathname} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

function docker(args) {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		child.on('error', (e) => reject(new Error(`docker is not usable: ${e.message}`)));
		child.on('close', (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(`docker ${args[0]} failed: ${(err || out).trim().split('\n').slice(-3).join(' ')}`));
		});
	});
}

async function inspect(container) {
	const out = await docker(['inspect', container]).catch(() => null);
	if (!out) return null;
	const [info] = JSON.parse(out);
	return { running: Boolean(info?.State?.Running), labels: info?.Config?.Labels || {} };
}

/**
 * The guard that makes this safe to run on a machine full of other people's
 * Home Assistant containers. Nothing without our label is ever acted on.
 */
function assertOurs(info, container) {
	if (!info || info.labels?.[LABEL] !== '1') {
		throw new Error(
			`refusing to touch container "${container}": it was not created by this harness (missing ${LABEL} label). Pick another --name.`,
		);
	}
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function writeConfiguration(inst, { demo }) {
	// The three !include lines are not decoration. Home Assistant's scene, script
	// and automation config APIs write to these files, and without the includes
	// the write succeeds, the file appears, and no entity is ever created: a seed
	// that reports two scenes and produces none. That is exactly the silent
	// half-success this harness exists to stop.
	const lines = [
		'# Written by scripts/home-test-instance.mjs. Throwaway instance.',
		'default_config:',
		'logger:',
		'  default: warning',
		'scene: !include scenes.yaml',
		'script: !include scripts.yaml',
		'automation: !include automations.yaml',
	];
	if (demo) lines.push('demo:');
	fs.writeFileSync(path.join(inst.configDir, 'configuration.yaml'), `${lines.join('\n')}\n`);
	for (const store of ['scenes.yaml', 'scripts.yaml', 'automations.yaml']) {
		const file = path.join(inst.configDir, store);
		if (!fs.existsSync(file)) fs.writeFileSync(file, store === 'scripts.yaml' ? '{}\n' : '[]\n');
	}
}

function describeInstance(name, version) {
	const slug = String(name).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
	return {
		name: slug,
		version,
		image: `${IMAGE}:${version}`,
		container: `three-ws-home-test-${slug}`,
		configDir: path.join(ROOT, `.ha-config-test-${slug}`),
	};
}

/**
 * An exclusive lock around one named instance, held for the whole up/onboard/
 * seed sequence. `mkdir` is the atomic primitive here: it either creates the
 * directory or fails, with no window between the two.
 */
async function withLock(inst, fn) {
	const lock = `${inst.configDir}.lock`;
	const deadline = Date.now() + 900_000;
	for (;;) {
		try {
			fs.mkdirSync(lock);
			break;
		} catch (err) {
			if (err.code !== 'EEXIST') throw err;
			// A killed run leaves its lock behind. Nothing here takes longer than
			// a cold Home Assistant boot, so a much older lock is abandoned.
			const age = Date.now() - (fs.statSync(lock).mtimeMs || 0);
			if (age > 900_000) {
				fs.rmSync(lock, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`another run has held the lock on "${inst.name}" for 15 minutes`);
			log(`[lock] waiting for another run to finish with "${inst.name}"`);
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
	try {
		return await fn();
	} finally {
		fs.rmSync(lock, { recursive: true, force: true });
	}
}

function statePath(inst) {
	return path.join(inst.configDir, '.harness.json');
}

function readState(inst) {
	try {
		return JSON.parse(fs.readFileSync(statePath(inst), 'utf8'));
	} catch {
		return null;
	}
}

function requireState(inst) {
	const state = readState(inst);
	if (!state) throw new Error(`no instance named "${inst.name}" is up. Run --up first.`);
	return state;
}

function writeState(inst, state) {
	fs.mkdirSync(inst.configDir, { recursive: true });
	fs.writeFileSync(statePath(inst), `${JSON.stringify(state, null, '\t')}\n`);
	return state;
}

function parseArgs(args) {
	const out = { name: 'default', version: 'stable', json: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--up') out.up = true;
		else if (arg === '--onboard') out.onboard = true;
		else if (arg === '--seed') out.seed = true;
		else if (arg === '--down') out.down = true;
		else if (arg === '--json') out.json = true;
		else if (arg === '--help' || arg === '-h') out.help = true;
		else if (arg === '--name') out.name = args[++i];
		else if (arg === '--version') out.version = args[++i];
		else throw new Error(`unknown argument "${arg}"`);
	}
	return out;
}

function usage() {
	console.log(`Usage: node scripts/home-test-instance.mjs [--up] [--onboard] [--seed] [--down] [options]

  --up                start a container on a free port and wait for readiness
  --onboard           complete onboarding and mint a long-lived access token
  --seed              demo entities, a floor, areas, scenes, mcp_server, an exposed lock
  --down              remove the container and its config directory
  --name <slug>       run more than one instance side by side (default: default)
  --version <tag>     Home Assistant image tag (default: stable)
  --json              machine-readable output for a test to consume

Everything is idempotent. The usual call is:
  node scripts/home-test-instance.mjs --up --onboard --seed --json`);
}

await main();
