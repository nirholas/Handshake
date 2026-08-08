// The event-day watch. One terminal, one command, and it stays quiet until
// something an operator would act on actually changes.
//
// Why this exists alongside `npm run triage:gcp`: the triage sweep is the deeper
// tool, but it needs a live gcloud credential, and gcloud in this environment
// expires its auth on its own schedule (it did on 2026-08-07, mid-preparation).
// A watch that can go blind because a CLI wants a browser re-login is not a watch
// you can lean on during a live event. Everything here is plain HTTPS against
// public production surfaces, so it keeps working with no cloud credential at
// all - and it watches the two things a community event actually dies from: the
// world server going away, and the release changing under you.
//
// Usage:
//   npm run event:watch                    # poll forever, 30s
//   npm run event:watch -- --interval 15   # tighter during the opening rush
//   npm run event:watch -- --once          # single sweep, for a cron or a script
//
// Output discipline: a healthy cycle prints one compact line. A state CHANGE
// (anything up→down or down→up, or the live release SHA moving) prints a loud
// block, because that is the only moment an operator needs to look up.
//
// Exit codes: 0 clean, 1 something was down when --once ran, 2 the watch itself
// could not run.

import process from 'node:process';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SITE = process.env.EVENT_BASE_URL || 'https://three.ws';
const WORLD = process.env.EVENT_WORLD_URL || 'https://three-ws-multiplayer-93741856042.us-central1.run.app';

function flag(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const v = process.argv[i + 1];
	return v && !v.startsWith('--') ? v : true;
}

const once = process.argv.includes('--once');
const intervalMs = Math.max(5, Number(flag('interval', 30))) * 1000;

async function probe(name, url, check) {
	const started = Date.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
		const ms = Date.now() - started;
		if (!res.ok) return { name, up: false, ms, detail: `http ${res.status}` };
		const detail = check ? await check(res) : `${res.status}`;
		return { name, up: detail !== false, ms, detail: detail === false ? 'content check failed' : detail };
	} catch (err) {
		return { name, up: false, ms: Date.now() - started, detail: String(err?.message || err).slice(0, 70) };
	}
}

async function sweep() {
	const playUrl = `${SITE}/play?coin=${THREE_MINT}`;
	const checks = await Promise.all([
		probe('api', `${SITE}/api/healthz`, async (r) => {
			const j = await r.json();
			return j.status === 'ok' ? 'ok' : `status=${j.status}`;
		}),
		probe('version', `${SITE}/api/version`, async (r) => {
			const j = await r.json();
			return `${j.commitShort} · ${j.runtime?.revision || '?'}`;
		}),
		probe('play page', playUrl, async (r) => {
			const html = await r.text();
			// A 200 that lost its game bootstrap is the failure mode a status-code
			// check cannot see, and it is exactly what a bad deploy produces.
			return /game-server/.test(html) ? `${Math.round(html.length / 1024)}kb` : false;
		}),
		probe('world server', `${WORLD}/health`, async (r) => {
			const j = await r.json();
			return j.ok ? 'ok' : 'not ok';
		}),
		probe('world population', `${WORLD}/population?coin=${THREE_MINT}`, async (r) => {
			const j = await r.json();
			return `${j.players} player(s) in ${j.rooms} room(s)`;
		}),
	]);
	return checks;
}

const previous = new Map();
let consecutiveBad = 0;

function render(checks) {
	const stamp = new Date().toISOString().slice(11, 19);
	const changes = [];
	for (const c of checks) {
		const before = previous.get(c.name);
		// The population count and latency move every cycle by design; only their
		// up/down state and the release identity are worth shouting about.
		const identity = c.name === 'version' ? `${c.up}:${c.detail}` : String(c.up);
		if (before !== undefined && before !== identity) changes.push(c);
		previous.set(c.name, identity);
	}

	const down = checks.filter((c) => !c.up);
	// The population endpoint only exists on world servers built after 2026-08-07.
	// An older deployed world answering 404 is stale code, not an outage, so it
	// never counts toward the failure streak that gates the exit code.
	const realDown = down.filter((c) => !(c.name === 'world population' && /http 404/.test(c.detail)));

	if (changes.length) {
		console.log(`\n${'='.repeat(64)}`);
		for (const c of changes) {
			console.log(`${stamp}  CHANGED  ${c.name}: ${c.up ? 'UP' : 'DOWN'} - ${c.detail}`);
		}
		console.log(`${'='.repeat(64)}\n`);
	}

	console.log(
		`${stamp}  ` +
			checks.map((c) => `${c.name}=${c.up ? c.detail : `DOWN(${c.detail})`}`).join('  ·  '),
	);

	if (realDown.length) consecutiveBad += 1;
	else consecutiveBad = 0;

	if (consecutiveBad >= 3) {
		console.log(`\n  ${realDown.map((c) => c.name).join(', ')} has been down for ${consecutiveBad} cycles.`);
		console.log('  Rollback and escalation commands: docs/event-readiness/LIVE-OPS.md\n');
	}
	return realDown.length;
}

async function run() {
	console.log(`[watch] site  ${SITE}`);
	console.log(`[watch] world ${WORLD}`);
	console.log(`[watch] every ${intervalMs / 1000}s - a quiet line per cycle means healthy\n`);

	if (once) {
		const bad = render(await sweep());
		process.exit(bad ? 1 : 0);
	}

	for (;;) {
		render(await sweep());
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

run().catch((err) => {
	console.error('[watch] FATAL', err);
	process.exit(2);
});
