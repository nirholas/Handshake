// Drive N concurrent /play sessions at the live multiplayer world and report
// what bends. Written for event-day readiness: the number that decides whether a
// community launch survives is not "does one player connect" but "does the
// world still accept and serve the 400th one while the first 399 are walking".
//
// Why not Playwright: a browser costs ~200-300 MB and a CPU share, so a laptop
// tops out around 20 real pages. As far as the world server is concerned a
// player is one Colyseus session plus the move traffic it produces, and that is
// exactly what this opens. Every client here does the real handshake the browser
// does (HTTP matchmake -> seat reservation -> WS upgrade -> schema handshake),
// so a broken join contract fails here the same way it fails a real visitor.
//
// Two Node-specific details this depends on, both load-bearing:
//   1. The world server rejects origin-less WS upgrades in production
//      (multiplayer/src/index.js verifyClient). colyseus.js only forwards custom
//      headers when its transport resolves to the `ws` package, and Node >= 22
//      ships a global WebSocket that shadows it and silently drops them. We
//      delete the global before importing colyseus.js so the Origin header
//      actually reaches the server.
//   2. No root-schema class is passed to joinOrCreate, so state decodes from the
//      server's reflected schema. A harness pinned to a local schema build
//      desyncs the moment the deployed server adds an append-only field.
//
// Usage:
//   node scripts/play-capacity-smoke.mjs --n 400 --hold 120
//   node scripts/play-capacity-smoke.mjs --n 50 --host ws://localhost:2567 --origin http://localhost:3000
//   node scripts/play-capacity-smoke.mjs --n 600 --ramp 60 --hold 180 --json report.json
//
// Flags:
//   --n <int>        concurrent players                     (default 200)
//   --host <url>     multiplayer server ws(s) URL           (default prod)
//   --origin <url>   Origin header sent on the WS upgrade   (default https://three.ws)
//   --coin <mint>    community world to join                (default $THREE)
//   --tier <t>       '' for the open General world, or 'holders'  (default '')
//   --ramp <sec>     spread the joins over this window      (default 30)
//   --hold <sec>     keep everyone walking this long        (default 120)
//   --rate <hz>      move messages per player per second    (default 8)
//   --json <path>    also write the full report as JSON
//
// Exit code is 0 only when every threshold in THRESHOLDS below holds, so this
// can gate a release as well as inform one.

import { writeFileSync } from 'node:fs';
import process from 'node:process';

// See note 1 above: must happen before colyseus.js is loaded.
delete globalThis.WebSocket;
const { Client } = await import('colyseus.js');

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const DEFAULT_HOST = 'wss://three-ws-multiplayer-93741856042.us-central1.run.app';

// Pass/fail bar for the run. These are event-day numbers, not aspirational ones:
// a join that takes longer than 8 s is a player who has already reloaded, and a
// world that drops more than 2% of its sessions mid-event looks broken from the
// inside even when every dashboard is green.
const THRESHOLDS = {
	joinFailPct: 2,
	dropPct: 2,
	joinP95Ms: 8000,
	silentPct: 5, // sessions that joined but never received a state patch
};

function parseArgs(argv) {
	const out = {
		n: 200,
		host: DEFAULT_HOST,
		origin: 'https://three.ws',
		coin: THREE_MINT,
		tier: '',
		ramp: 30,
		hold: 120,
		rate: 8,
		json: '',
	};
	for (let i = 2; i < argv.length; i += 1) {
		const key = argv[i].replace(/^--/, '');
		if (!(key in out)) continue;
		const raw = argv[i + 1];
		if (raw === undefined || raw.startsWith('--')) continue;
		out[key] = typeof out[key] === 'number' ? Number(raw) : raw;
		i += 1;
	}
	return out;
}

const args = parseArgs(process.argv);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted, p) {
	if (!sorted.length) return null;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

function summarize(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		count: sorted.length,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted.length ? sorted[sorted.length - 1] : null,
	};
}

// One virtual player: joins, then walks a slow circle so every move passes the
// server's MAX_STEP_M teleport clamp (1.2 m) and produces a real state patch
// broadcast to every other client in the room. A harness that joins and sits
// idle measures the connection count and nothing about the simulation.
class VirtualPlayer {
	constructor(index, opts) {
		this.index = index;
		this.opts = opts;
		this.room = null;
		this.joinMs = null;
		this.joinError = null;
		this.patches = 0;
		this.moves = 0;
		this.leftCode = null;
		this.leftUnexpectedly = false;
		this.done = false;
		this.angle = (index / opts.n) * Math.PI * 2;
		this.radius = 6 + (index % 7);
		this.timer = null;
	}

	position() {
		return {
			x: Math.cos(this.angle) * this.radius,
			y: 0,
			z: Math.sin(this.angle) * this.radius,
			yaw: this.angle,
			motion: 'walk',
		};
	}

	async join() {
		const started = Date.now();
		try {
			const client = new Client(this.opts.host, { headers: { Origin: this.opts.origin } });
			this.room = await client.joinOrCreate('walk_world', {
				coin: this.opts.coin,
				tier: this.opts.tier,
				coinName: 'three.ws',
				coinSymbol: 'three',
				name: `loadtest-${String(this.index).padStart(4, '0')}`,
			});
			this.joinMs = Date.now() - started;
			// The world broadcasts a wide message vocabulary (tag rounds, floor beats,
			// king-of-the-hill). A harness that registers none of them floods stderr
			// with one warning per broadcast per client, which at 400 clients drowns
			// the numbers we came for. The wildcard handler is the supported way to
			// say "receive everything, act on nothing".
			this.room.onMessage('*', () => {});
			this.room.onStateChange(() => {
				this.patches += 1;
			});
			this.room.onLeave((code) => {
				this.leftCode = code;
				if (!this.done) this.leftUnexpectedly = true;
				this.stop();
			});
			this.room.onError((code, message) => {
				this.joinError = this.joinError || `room_error:${code}:${message || ''}`;
			});
			return true;
		} catch (err) {
			this.joinMs = Date.now() - started;
			this.joinError = String(err?.message || err).slice(0, 160);
			return false;
		}
	}

	startWalking() {
		if (!this.room) return;
		const stepMs = Math.max(20, Math.round(1000 / this.opts.rate));
		// 0.5 m per step keeps every move under the server's 1.2 m clamp at any rate.
		const angularStep = 0.5 / this.radius;
		this.timer = setInterval(() => {
			this.angle += angularStep;
			try {
				this.room.send('move', this.position());
				this.moves += 1;
			} catch {
				// A send on a socket the server already closed is not a new failure;
				// onLeave has already recorded the drop.
			}
		}, stepMs);
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async leave() {
		this.done = true;
		this.stop();
		try {
			await this.room?.leave(true);
		} catch {
			// Leaving a socket the server already reaped is a no-op, not an error.
		}
	}
}

// The world server's public population count, sampled through the same path the
// /event landing page reads. Older deployed servers do not expose it; a 404 is
// reported once rather than treated as an outage, because the count is
// observability, not the thing under test.
async function samplePopulation(httpBase, coin) {
	try {
		const res = await fetch(`${httpBase}/population?coin=${encodeURIComponent(coin)}`, {
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return { ok: false, status: res.status };
		return await res.json();
	} catch (err) {
		return { ok: false, error: String(err?.message || err).slice(0, 80) };
	}
}

async function probeHttp(url) {
	const started = Date.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
		await res.arrayBuffer();
		return { ms: Date.now() - started, status: res.status };
	} catch (err) {
		return { ms: Date.now() - started, status: 0, error: String(err?.message || err).slice(0, 80) };
	}
}

async function run() {
	const httpBase = args.host.replace(/^ws/, 'http');
	const pageUrl = `${httpBase.includes('localhost') ? 'http://localhost:3000' : 'https://three.ws'}/play?coin=${args.coin}`;

	console.log(`[capacity] target      ${args.host}`);
	console.log(`[capacity] world       coin=${args.coin.slice(0, 12)}… tier=${args.tier || 'general'}`);
	console.log(`[capacity] plan        ${args.n} players, ${args.ramp}s ramp, ${args.hold}s hold, ${args.rate} moves/s each`);
	console.log(`[capacity] baseline    ${JSON.stringify(await samplePopulation(httpBase, args.coin))}`);

	const players = Array.from({ length: args.n }, (_, i) => new VirtualPlayer(i, args));
	const rampGapMs = args.n > 1 ? (args.ramp * 1000) / args.n : 0;

	const samples = [];
	const httpProbes = [];
	const sampler = setInterval(async () => {
		const live = players.filter((p) => p.room && !p.leftCode).length;
		const [pop, page] = await Promise.all([samplePopulation(httpBase, args.coin), probeHttp(pageUrl)]);
		httpProbes.push(page);
		const sample = { t: new Date().toISOString(), heldSessions: live, population: pop?.players ?? null, pageMs: page.ms, pageStatus: page.status };
		samples.push(sample);
		console.log(`[capacity] held=${live} population=${sample.population ?? 'n/a'} page=${page.status} ${page.ms}ms`);
	}, 10_000);

	const started = Date.now();
	await Promise.all(
		players.map(async (player, i) => {
			await sleep(Math.round(i * rampGapMs));
			const ok = await player.join();
			if (ok) player.startWalking();
		}),
	);
	const rampMs = Date.now() - started;
	const joined = players.filter((p) => p.room).length;
	console.log(`[capacity] ramp complete in ${(rampMs / 1000).toFixed(1)}s — ${joined}/${args.n} joined`);

	await sleep(args.hold * 1000);
	clearInterval(sampler);

	const heldAtEnd = players.filter((p) => p.room && !p.leftCode).length;
	await Promise.all(players.map((p) => p.leave()));

	const joinLatencies = players.filter((p) => p.room).map((p) => p.joinMs);
	const failures = players.filter((p) => !p.room);
	const drops = players.filter((p) => p.leftUnexpectedly);
	const silent = players.filter((p) => p.room && p.patches === 0);
	const totalMoves = players.reduce((sum, p) => sum + p.moves, 0);

	const failReasons = {};
	for (const p of failures) {
		const key = (p.joinError || 'unknown').replace(/\d{3,}/g, 'N').slice(0, 80);
		failReasons[key] = (failReasons[key] || 0) + 1;
	}

	const pageMs = httpProbes.filter((p) => p.status >= 200 && p.status < 400).map((p) => p.ms);
	const report = {
		target: args.host,
		coin: args.coin,
		tier: args.tier || 'general',
		requested: args.n,
		joined,
		heldAtEnd,
		rampSeconds: Number((rampMs / 1000).toFixed(1)),
		holdSeconds: args.hold,
		joinFailures: failures.length,
		joinFailPct: Number(((failures.length / args.n) * 100).toFixed(2)),
		failReasons,
		midRunDrops: drops.length,
		dropPct: Number(((drops.length / Math.max(1, joined)) * 100).toFixed(2)),
		silentSessions: silent.length,
		silentPct: Number(((silent.length / Math.max(1, joined)) * 100).toFixed(2)),
		joinLatencyMs: summarize(joinLatencies),
		movesSent: totalMoves,
		statePatchesReceived: players.reduce((sum, p) => sum + p.patches, 0),
		pageLatencyMs: summarize(pageMs),
		pageErrors: httpProbes.filter((p) => !(p.status >= 200 && p.status < 400)).length,
		samples,
	};

	const verdicts = [
		['join failures', report.joinFailPct, THRESHOLDS.joinFailPct, '%'],
		['mid-run drops', report.dropPct, THRESHOLDS.dropPct, '%'],
		['join p95', report.joinLatencyMs.p95 ?? 0, THRESHOLDS.joinP95Ms, 'ms'],
		['silent sessions', report.silentPct, THRESHOLDS.silentPct, '%'],
	];

	console.log('\n=== capacity smoke ===');
	console.log(`requested        ${report.requested}`);
	console.log(`joined           ${report.joined} (${(100 - report.joinFailPct).toFixed(1)}%)`);
	console.log(`held at end      ${report.heldAtEnd}`);
	console.log(`join latency     p50 ${report.joinLatencyMs.p50}ms · p95 ${report.joinLatencyMs.p95}ms · max ${report.joinLatencyMs.max}ms`);
	console.log(`moves sent       ${report.movesSent}`);
	console.log(`state patches    ${report.statePatchesReceived}`);
	console.log(`page latency     p50 ${report.pageLatencyMs.p50}ms · p95 ${report.pageLatencyMs.p95}ms (${report.pageErrors} errors)`);
	if (Object.keys(failReasons).length) console.log(`fail reasons     ${JSON.stringify(failReasons)}`);

	let pass = true;
	console.log('');
	for (const [label, value, limit, unit] of verdicts) {
		const ok = value <= limit;
		if (!ok) pass = false;
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(16)} ${value}${unit} (limit ${limit}${unit})`);
	}

	if (args.json) {
		writeFileSync(args.json, JSON.stringify(report, null, 2));
		console.log(`\nreport → ${args.json}`);
	}

	process.exit(pass ? 0 : 1);
}

run().catch((err) => {
	console.error('[capacity] FATAL', err);
	process.exit(2);
});
