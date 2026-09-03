#!/usr/bin/env node
/**
 * The home lane's correctness depends on a third party's monthly release.
 *
 * Home Assistant ships every month and moves WebSocket commands, config-flow
 * schemas and entity attributes between releases. Nothing used to notice: the
 * lane's live tests ran against whatever `stable` happened to be that day, so a
 * command renamed in the next release would first be reported by a user whose
 * front door stopped answering. This runs the lane's real client library
 * against every release we claim to support and prints what each one does.
 *
 *   node scripts/home-version-matrix.mjs                  # the derived version set
 *   node scripts/home-version-matrix.mjs --versions 2026.8,2026.7
 *   node scripts/home-version-matrix.mjs --keep-images    # skip the disk reclaim
 *
 * The version set is DERIVED, never hardcoded: Home Assistant's own analytics
 * (https://analytics.home-assistant.io/data.json, ~676k opted-in installs)
 * carries the live install share per release, and the set is the current
 * stable, the two releases before it, and the oldest release still in
 * contiguous wide use at or above one percent of installs. That last one is the
 * supported floor, and it moves on its own as the world upgrades.
 *
 * Each version is pulled, tested and removed one at a time, because four Home
 * Assistant images is thirteen gigabytes and this machine does not have it.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectHomeMcp, ERR, flattenEntities, HomeBridge } from '../packages/home-bridge/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'scripts', 'home-test-instance.mjs');
const IMAGE = 'ghcr.io/home-assistant/home-assistant';
const ANALYTICS = 'https://analytics.home-assistant.io/data.json';
const OUT_JSON = path.join(ROOT, 'docs', 'ops', 'home-version-matrix.json');

/**
 * The entry point sits below every declaration it uses. A top-level driver
 * above a `const` helper reads it in the temporal dead zone and throws, which
 * is the same trap `npm run check:tdz-bootstrap` exists to catch in browser
 * modules.
 */
async function main() {
	const args = parse(process.argv.slice(2));
	const versions = args.versions || (await deriveVersions());
	console.error(`[matrix] testing ${versions.map((v) => v.tag).join(', ')}`);

	const results = [];
	for (const version of versions) {
		results.push(await runVersion(version));
		if (!args.keepImages) await reclaim(version.tag);
	}

	const report = { measuredAt: new Date().toISOString(), source: ANALYTICS, results };
	fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
	fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, '\t')}\n`);

	console.log(renderTable(results));
	console.error(`\n[matrix] wrote ${path.relative(ROOT, OUT_JSON)}`);

	// A version that cannot connect at all is the finding this runner exists to
	// surface, so it fails the command rather than printing a quiet FAIL cell.
	const broken = results.filter((r) => !r.cells.connect?.ok);
	process.exitCode = broken.length && !args.allowFailures ? 1 : 0;
}

// ---------------------------------------------------------------- versions

/**
 * The releases to hold, read from Home Assistant's live install share rather
 * than from a list somebody typed six months ago.
 */
async function deriveVersions() {
	const res = await fetch(ANALYTICS, { signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`${ANALYTICS} returned ${res.status}`);
	const body = await res.json();
	const raw = body?.current?.versions || {};
	const total = Object.values(raw).reduce((a, b) => a + b, 0);
	if (!total) throw new Error('Home Assistant analytics returned no version histogram.');

	// Patch releases within a month are the same code for our purposes: what
	// moves a WebSocket command is the monthly release.
	const byMinor = new Map();
	for (const [full, count] of Object.entries(raw)) {
		const [year, month] = full.split('.');
		if (!/^\d+$/.test(year) || !/^\d+$/.test(month)) continue;
		const key = `${year}.${month}`;
		byMinor.set(key, (byMinor.get(key) || 0) + count);
	}
	const ordered = [...byMinor.entries()]
		.map(([tag, count]) => ({ tag, count, share: (100 * count) / total }))
		.sort((a, b) => compareVersions(b.tag, a.tag));

	// The newest release with a real user base is "current": the very newest tag
	// in the histogram is often a handful of early upgraders on a release that
	// is barely out.
	const startIndex = ordered.findIndex((v) => v.share >= 1);
	const recent = ordered.slice(startIndex, startIndex + 3);

	// The floor is the end of the CONTIGUOUS run at or above one percent. An
	// isolated old release above the line is a pinned island, not a version the
	// world is still on, and treating it as the floor would overstate support.
	let floor = recent[recent.length - 1];
	for (let i = startIndex; i < ordered.length; i += 1) {
		if (ordered[i].share < 1) break;
		floor = ordered[i];
	}

	const picked = [...recent];
	if (!picked.some((v) => v.tag === floor.tag)) picked.push(floor);
	return picked.map((v, i) => ({
		tag: v.tag,
		share: v.share,
		role: i === 0 ? 'current stable' : v.tag === floor.tag && i === picked.length - 1 ? 'oldest in wide use' : 'previous release',
		installs: v.count,
	}));
}

function compareVersions(a, b) {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const diff = (pa[i] || 0) - (pb[i] || 0);
		if (diff) return diff;
	}
	return 0;
}

// ---------------------------------------------------------------- one version

async function runVersion(version) {
	const name = `mx-${version.tag.replace(/\./g, '-')}`;
	const cells = blankCells();
	const notes = [];
	let instance = null;

	console.error(`\n[matrix] ${version.tag} (${version.role}, ${version.share.toFixed(2)}% of installs)`);
	try {
		instance = await harness(['--up', '--onboard', '--seed', '--json', '--name', name, '--version', version.tag]);
		if (!instance.ok) throw new Error(instance.error);
		if (instance.seed?.exposeCommand) notes.push(`exposes via \`${instance.seed.exposeCommand}\``);
		if (instance.seed && !instance.seed.scenes) notes.push('the scene config API created nothing');
		await probe(instance, cells, notes);
	} catch (err) {
		// A version that cannot even be built is a finding, not a crash.
		if (!cells.connect) cells.connect = fail(err.message);
		notes.push(err.message);
	} finally {
		await harness(['--down', '--json', '--name', name]).catch(() => {});
	}

	return { ...version, haVersion: instance?.haVersion || null, cells, notes };
}

/** Every capability the lane depends on, exercised through the real library. */
async function probe(instance, cells, notes) {
	const { baseUrl, token } = instance;
	const home = new HomeBridge({ baseUrl, token });

	await home.connect();
	cells.connect = ok(home.haVersion || instance.haVersion || '');

	const { floors, areas, devices, entities } = home.registries;
	cells.registries = floors.length && areas.length && entities.length
		? ok(`${floors.length}f/${areas.length}a/${devices.length}d/${entities.length}e`)
		: fail(`${floors.length}f/${areas.length}a/${devices.length}d/${entities.length}e`);
	if (!floors.length) notes.push('no floor registry: the 3D scene renders a single level');

	try {
		const light = Object.keys(home.states).find((id) => id.startsWith('light.'));
		if (!light) throw new Error('no light entity in the seeded house');
		const before = home.states[light].state;
		await home.call('light', 'toggle', { entity_id: light });
		await until(() => home.states[light].state !== before, 20_000, `${light} to change on the socket`);
		cells.stream = ok('push');
	} catch (err) {
		cells.stream = fail(err.message);
	}

	try {
		const lock = Object.keys(home.states).find((id) => id.startsWith('lock.') && home.states[id].state === 'locked');
		if (!lock) throw new Error('no locked door in the seeded house');
		let refused = false;
		await home.call('lock', 'unlock', { entity_id: lock }).catch((err) => (refused = err.code === ERR.NEEDS_CONFIRMATION));
		if (!refused) throw new Error('the gate did not refuse an unconfirmed unlock');
		if ((await readState(instance, lock)) !== 'locked') throw new Error('the door moved on a refused call');

		await home.call('lock', 'unlock', { entity_id: lock }, { confirmed: true });
		await untilState(instance, lock, ['unlocked', 'unlocking', 'open', 'opening']);
		await home.call('lock', 'lock', { entity_id: lock });
		await untilState(instance, lock, ['locked', 'locking']);
		cells.call = ok('gated');
	} catch (err) {
		cells.call = fail(err.message);
	}

	try {
		const { match } = await home.activate('good night', { dryRun: true });
		cells.scenes = match ? ok(match.kind) : fail('no scene matched "good night"');
	} catch (err) {
		cells.scenes = fail(err.message);
	}

	try {
		const mcp = await connectHomeMcp({
			baseUrl,
			token,
			entities: () => flattenEntities(home.graph),
			isAllowed: () => false,
		});
		cells.mcp = ok(`${mcp.tools.length} tools`);
		await mcp.close();
	} catch (err) {
		// NO_MCP on a release that predates the integration is the correct
		// answer, not a failure: the MCP channel is an upgrade, never a
		// requirement, and the library already degrades to the WebSocket channel.
		cells.mcp = err.code === ERR.NO_MCP ? { ok: true, note: 'absent', degraded: true } : fail(err.message);
		if (err.code === ERR.NO_MCP) notes.push('no mcp_server: the WebSocket channel carries the house alone');
	}

	home.close();
}

// ---------------------------------------------------------------- rendering

function renderTable(rows) {
	const head = ['Version', 'Share', 'Connect', 'Registries', 'State stream', 'Service call', 'Scenes', '`mcp_server`', 'Notes'];
	const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
	for (const r of rows) {
		lines.push(
			`| \`${r.tag}\` (${r.role}) | ${r.share.toFixed(2)}% | ${cell(r.cells.connect)} | ${cell(r.cells.registries)} | ${cell(r.cells.stream)} | ${cell(r.cells.call)} | ${cell(r.cells.scenes)} | ${cell(r.cells.mcp)} | ${r.notes.length ? r.notes.join('; ') : 'none'} |`,
		);
	}
	return lines.join('\n');
}

function cell(value) {
	if (!value) return 'not run';
	const mark = value.ok ? (value.degraded ? 'degraded' : 'pass') : 'FAIL';
	return value.note ? `${mark} (${value.note})` : mark;
}

function blankCells() {
	return { connect: null, registries: null, stream: null, call: null, scenes: null, mcp: null };
}

function ok(note) {
	return { ok: true, note };
}

function fail(note) {
	return { ok: false, note: String(note).slice(0, 120) };
}

// ---------------------------------------------------------------- plumbing

async function readState(instance, entityId) {
	const res = await fetch(`${instance.baseUrl}/api/states/${encodeURIComponent(entityId)}`, {
		headers: { authorization: `Bearer ${instance.token}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`GET /api/states/${entityId} returned ${res.status}`);
	return (await res.json()).state;
}

function untilState(instance, entityId, expected, timeout = 25_000) {
	const wanted = new Set(expected);
	return until(async () => wanted.has(await readState(instance, entityId)), timeout, `${entityId} to reach ${expected.join('/')}`);
}

async function until(condition, timeout, label) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		// The condition may be sync (a socket-backed state read) or async (an HTTP
		// read), and both must be tolerated without the caller thinking about it.
		const met = await Promise.resolve()
			.then(condition)
			.catch(() => false);
		if (met) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${label}`);
}

function harness(argv) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [HARNESS, ...argv], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.on('error', reject);
		child.on('close', () => {
			try {
				resolve(JSON.parse(out));
			} catch {
				reject(new Error(`home-test-instance produced no JSON for ${argv.join(' ')}`));
			}
		});
	});
}

/**
 * Four Home Assistant images do not fit on this disk, so each one goes as soon
 * as its column is filled in.
 */
async function reclaim(tag) {
	await new Promise((resolve) => {
		const child = spawn('docker', ['image', 'rm', `${IMAGE}:${tag}`], { stdio: 'ignore' });
		child.on('error', resolve);
		child.on('close', resolve);
	});
}

function parse(argv) {
	const out = { keepImages: false, allowFailures: false };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--versions') {
			out.versions = argv[++i]
				.split(',')
				.map((tag) => ({ tag: tag.trim(), share: 0, role: 'requested', installs: 0 }));
		} else if (argv[i] === '--keep-images') out.keepImages = true;
		else if (argv[i] === '--allow-failures') out.allowFailures = true;
		else throw new Error(`unknown argument "${argv[i]}"`);
	}
	return out;
}

await main();
