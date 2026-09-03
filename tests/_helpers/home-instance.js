/**
 * One way for a live test to get a real Home Assistant.
 *
 * Before this helper each live test in the home lane carried its own paragraph
 * of setup instructions, and the instances they described had drifted apart:
 * one had scenes, one had a lock exposed to Assist, one had neither, so a test
 * could pass for a reason nobody had written down. Every live test in the lane
 * now calls `acquireHomeInstance()` and gets the same seeded house.
 *
 * Two ways in, and neither runs by default, because `npm test` must not need
 * Docker:
 *
 *   HOME_ASSISTANT_URL=... HOME_ASSISTANT_TOKEN=...   point at a house you have
 *   HOME_LIVE=1                                        let the harness make one
 *
 * The harness path shares ONE named container across every test file in the
 * run (vitest gives each file its own fork, and building a Home Assistant per
 * fork would cost minutes and a gigabyte each). Nothing here ever tears that
 * instance down: it is the caller's, and `npm run home:instance:down` removes
 * it when the run is over.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = path.join(ROOT, 'scripts', 'home-test-instance.mjs');

/** The shared instance every live test in the lane reuses. */
const INSTANCE_NAME = process.env.HOME_LIVE_NAME || 'lane';

/**
 * Whether the live tier should run at all. Synchronous on purpose: vitest needs
 * the skip decision before any hook has had a chance to start a container.
 */
export function liveHomeAvailable() {
	if (process.env.HOME_ASSISTANT_URL && process.env.HOME_ASSISTANT_TOKEN) return true;
	return isTruthy(process.env.HOME_LIVE);
}

/**
 * A connected-ready house: `{ baseUrl, token, version, seed }`.
 *
 * Call it from `beforeAll` with a generous timeout. A cold Home Assistant boot
 * plus seeding is around two minutes; every subsequent caller in the same run
 * reuses the container and returns in about a second.
 */
export async function acquireHomeInstance({ timeout = 600_000 } = {}) {
	if (process.env.HOME_ASSISTANT_URL && process.env.HOME_ASSISTANT_TOKEN) {
		return {
			baseUrl: process.env.HOME_ASSISTANT_URL.replace(/\/+$/, ''),
			token: process.env.HOME_ASSISTANT_TOKEN,
			version: null,
			seed: null,
			managed: false,
		};
	}
	if (!isTruthy(process.env.HOME_LIVE)) {
		throw new Error('No live Home Assistant: set HOME_ASSISTANT_URL + HOME_ASSISTANT_TOKEN, or HOME_LIVE=1.');
	}

	const result = await runHarness(['--up', '--onboard', '--seed', '--json', '--name', INSTANCE_NAME], { timeout });
	if (!result.ok) throw new Error(`home-test-instance failed: ${result.error}`);
	return {
		baseUrl: result.baseUrl,
		token: result.token,
		version: result.haVersion,
		seed: result.seed || null,
		managed: true,
	};
}

/**
 * A live entity id of the given domain, read from the house itself rather than
 * assumed. A test that hardcodes `light.bed_light` is a test that breaks the
 * day someone points the lane at their own home.
 */
export async function pickEntity(instance, domain, predicate = () => true) {
	const states = await readStates(instance);
	const found = states.find((s) => s.entity_id.startsWith(`${domain}.`) && predicate(s));
	return found ? found.entity_id : null;
}

/** Every state in the house, straight from the REST API. */
export async function readStates(instance) {
	const res = await fetch(`${instance.baseUrl}/api/states`, {
		headers: { authorization: `Bearer ${instance.token}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`GET /api/states returned ${res.status}`);
	return res.json();
}

/**
 * One entity's state, read back from Home Assistant.
 *
 * The lane's confirmation tests assert on this and never on our own UI text: a
 * card that says "unlocked" proves nothing about a door.
 */
export async function readState(instance, entityId) {
	const res = await fetch(`${instance.baseUrl}/api/states/${encodeURIComponent(entityId)}`, {
		headers: { authorization: `Bearer ${instance.token}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`GET /api/states/${entityId} returned ${res.status}`);
	const body = await res.json();
	return body.state;
}

/**
 * Wait until an entity reaches one of the given states, polling Home Assistant.
 *
 * This is the only correct way to wait in this lane. A fixed sleep is how a
 * suite that guards a door becomes a suite people ignore.
 */
export async function waitForState(instance, entityId, expected, { timeout = 20_000, interval = 250 } = {}) {
	const wanted = new Set(Array.isArray(expected) ? expected : [expected]);
	const deadline = Date.now() + timeout;
	let last = null;
	while (Date.now() < deadline) {
		last = await readState(instance, entityId).catch(() => null);
		if (last && wanted.has(last)) return last;
		await new Promise((r) => setTimeout(r, interval));
	}
	throw new Error(`${entityId} was "${last}" after ${Math.round(timeout / 1000)}s, expected one of ${[...wanted].join(', ')}`);
}

/** Put an entity back the way the test found it, for the next test in the file. */
export async function setState(instance, domain, service, entityId) {
	const res = await fetch(`${instance.baseUrl}/api/services/${domain}/${service}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ entity_id: entityId }),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`${domain}.${service} on ${entityId} returned ${res.status}`);
}

function isTruthy(value) {
	return Boolean(value) && value !== '0' && value !== 'false';
}

function runHarness(args, { timeout }) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [HARNESS, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`home-test-instance timed out after ${Math.round(timeout / 1000)}s`));
		}, timeout);
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		child.on('error', reject);
		child.on('close', () => {
			clearTimeout(timer);
			try {
				resolve(JSON.parse(out));
			} catch {
				reject(new Error(`home-test-instance produced no JSON. stderr: ${err.trim().split('\n').slice(-4).join(' ')}`));
			}
		});
	});
}
