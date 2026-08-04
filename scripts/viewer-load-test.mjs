// Sustain N concurrent viewers against a live endpoint and report what breaks.
//
// "1000 viewers" is not "1000 browsers". A browser costs ~150-300 MB and a CPU
// share; 1000 of them needs a fleet. A viewer, as far as the server is concerned,
// is one held connection plus the bytes it pulls. This opens that many real
// connections against a real origin and measures what the server actually does
// under them, which is the number that decides whether a live demo survives.
//
// The defect class this exists to catch: a stream endpoint that rotates its
// clients on a timer. api/feed-stream.js closes at 275s and api/oracle/stream.js
// at 90s, both by design. A load test that connects once and counts successes
// reports "1000 connected" while the real occupancy has decayed to a fraction of
// that by minute five. Every viewer here reconnects the way an EventSource does,
// so the held count is measured continuously rather than assumed, and the
// reconnect total is reported as a first-class number.
//
// Modes:
//   sse  (default) hold a text/event-stream open, count events, reconnect on close
//   get            repeat full page/asset GETs with think-time between them
//   ws             hold a WebSocket open, count frames, reconnect on close
//
// Usage:
//   node scripts/viewer-load-test.mjs --n 1000 --path /api/feed-stream --hold 300
//   node scripts/viewer-load-test.mjs --n 1000 --mode get --path / --hold 120
//   node scripts/viewer-load-test.mjs --n 200 --mode ws --path /api/chat --origin http://localhost:3000
//
// Flags:
//   --n <int>        concurrent viewers            (default 100)
//   --origin <url>   target origin                 (default https://three.ws)
//   --path <path>    path to view                  (default /api/feed-stream)
//   --mode <m>       sse | get | ws                (default sse)
//   --ramp <sec>     spread joins over this window (default 30, 0 = thundering herd)
//   --hold <sec>     how long to sustain the load  (default 120)
//   --think <sec>    get-mode delay between loads  (default 5)
//   --header k:v     extra request header, repeatable

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const require = createRequire(import.meta.url);

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function argAll(name) {
	const out = [];
	for (let i = 0; i < process.argv.length; i++) {
		if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
	}
	return out;
}

const ORIGIN = String(arg('origin', 'https://three.ws')).replace(/\/+$/, '');
const PATH = String(arg('path', '/api/feed-stream'));
const MODE = String(arg('mode', 'sse')).toLowerCase();
const N = Math.max(1, Number(arg('n', 100)) || 100);
const RAMP_MS = Math.max(0, Number(arg('ramp', 30)) || 0) * 1000;
const HOLD_MS = Math.max(1, Number(arg('hold', 120)) || 120) * 1000;
const THINK_MS = Math.max(0, Number(arg('think', 5)) || 0) * 1000;

if (!['sse', 'get', 'ws'].includes(MODE)) {
	console.error(`Unknown --mode "${MODE}". Expected sse, get, or ws.`);
	process.exit(2);
}

const EXTRA_HEADERS = {};
for (const h of argAll('header')) {
	const idx = h.indexOf(':');
	if (idx > 0) EXTRA_HEADERS[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
}

const target = new URL(PATH, ORIGIN);
const isTls = target.protocol === 'https:';
const transport = isTls ? https : http;

// maxSockets defaults to Infinity on modern Node, but a shared pool with a finite
// cap silently serialises the run into a much smaller load than requested, so it
// is pinned. keepAlive matters only in get mode, where a real viewer reuses the
// connection across loads the way a browser does.
const agent = new transport.Agent({
	keepAlive: MODE === 'get',
	maxSockets: Infinity,
	maxFreeSockets: N,
});

const stats = {
	joined: 0,
	open: 0,
	peakOpen: 0,
	connectOk: 0,
	connectFail: 0,
	reconnects: 0,
	events: 0,
	bytes: 0,
	ttfb: [],
	status: new Map(),
	errors: new Map(),
};

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => {
	if (!sorted.length) return null;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[i];
};
const ms = (v) => (v == null ? 'n/a' : `${Math.round(v)}ms`);
const human = (b) =>
	b >= 1e9
		? `${(b / 1e9).toFixed(2)} GB`
		: b >= 1e6
			? `${(b / 1e6).toFixed(1)} MB`
			: b >= 1e3
				? `${(b / 1e3).toFixed(1)} KB`
				: `${b} B`;

let stopping = false;
const deadline = () => startedAt > 0 && Date.now() >= startedAt + RAMP_MS + HOLD_MS;

// A socket we aborted ourselves at end-of-run is not a server failure. Counting
// it would print one ECONNRESET per viewer on every clean run, which at 1000
// viewers buries the handful of errors that are real.
const noteError = (err) => {
	if (stopping || deadline()) return;
	bump(stats.errors, err?.code || err?.message || 'unknown');
};

// One viewer's lifetime: connect, consume, and on any close reconnect until the
// hold window expires. A viewer that gives up early is the failure being measured,
// so it is never retried silently without being counted.
async function runSseViewer(id) {
	while (!stopping && !deadline()) {
		const opened = await openStream(id);
		if (stopping || deadline()) break;
		// A stream that closed inside the hold window means the server rotated us
		// out. Real EventSource clients reconnect after `retry:`; so do we.
		if (opened) stats.reconnects++;
		await sleep(1000);
	}
}

function openStream(id) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		let settledOpen = false;
		let sawBody = false;
		let buf = '';

		const req = transport.request(
			target,
			{
				agent,
				method: 'GET',
				headers: {
					accept: 'text/event-stream',
					'cache-control': 'no-cache',
					'accept-encoding': 'identity',
					'user-agent': `three-ws-viewer-load/${id}`,
					...EXTRA_HEADERS,
				},
			},
			(res) => {
				bump(stats.status, res.statusCode);
				if (res.statusCode !== 200) {
					stats.connectFail++;
					res.resume();
					res.on('end', () => resolve(false));
					return;
				}
				stats.connectOk++;
				stats.open++;
				settledOpen = true;
				stats.peakOpen = Math.max(stats.peakOpen, stats.open);

				res.setEncoding('utf8');
				res.on('data', (chunk) => {
					if (!sawBody) {
						sawBody = true;
						stats.ttfb.push(Date.now() - t0);
					}
					stats.bytes += chunk.length;
					buf += chunk;
					// SSE frames are separated by a blank line. Comment lines (":hb")
					// are heartbeats, not events, and are deliberately not counted as
					// payload: a stream that only heartbeats is a stream delivering
					// nothing, and that has to stay visible in the numbers.
					let sep;
					while ((sep = buf.indexOf('\n\n')) !== -1) {
						const frame = buf.slice(0, sep);
						buf = buf.slice(sep + 2);
						if (frame.split('\n').some((line) => line.startsWith('data:'))) stats.events++;
					}
					if (buf.length > 1e6) buf = buf.slice(-1e5);
				});
				const done = () => {
					if (settledOpen) stats.open--;
					resolve(true);
				};
				res.on('end', done);
				res.on('close', done);
				res.on('error', (err) => {
					noteError(err);
					done();
				});
			}
		);

		req.on('error', (err) => {
			if (settledOpen) stats.open--;
			else stats.connectFail++;
			noteError(err);
			resolve(settledOpen);
		});
		req.end();

		// Abort the socket when the run ends so the process can exit promptly
		// instead of waiting out a 900s server timeout.
		const watch = setInterval(() => {
			if (stopping || deadline()) {
				clearInterval(watch);
				req.destroy();
			}
		}, 1000);
		watch.unref?.();
	});
}

async function runGetViewer(id) {
	while (!stopping && !deadline()) {
		await oneGet(id);
		if (THINK_MS) await sleep(THINK_MS * (0.5 + Math.random()));
	}
}

function oneGet(id) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		let sawBody = false;
		const req = transport.request(
			target,
			{
				agent,
				method: 'GET',
				headers: {
					accept: 'text/html,application/json,*/*',
					'user-agent': `three-ws-viewer-load/${id}`,
					...EXTRA_HEADERS,
				},
			},
			(res) => {
				bump(stats.status, res.statusCode);
				if (res.statusCode >= 200 && res.statusCode < 400) stats.connectOk++;
				else stats.connectFail++;
				stats.open++;
				stats.peakOpen = Math.max(stats.peakOpen, stats.open);
				res.on('data', (chunk) => {
					if (!sawBody) {
						sawBody = true;
						stats.ttfb.push(Date.now() - t0);
					}
					stats.bytes += chunk.length;
				});
				const done = () => {
					stats.open--;
					stats.events++;
					resolve();
				};
				res.on('end', done);
				res.on('error', () => done());
			}
		);
		req.on('error', (err) => {
			stats.connectFail++;
			noteError(err);
			resolve();
		});
		req.setTimeout(60_000, () => {
			noteError({ code: "ETIMEDOUT" });
			req.destroy();
		});
		req.end();
	});
}

async function runWsViewer(id) {
	let WebSocket;
	try {
		WebSocket = require('ws');
	} catch {
		console.error('--mode ws needs the "ws" package. It is already a dependency; run npm install.');
		process.exit(2);
	}
	const wsUrl = `${isTls ? 'wss' : 'ws'}://${target.host}${target.pathname}${target.search}`;
	while (!stopping && !deadline()) {
		const held = await new Promise((resolve) => {
			const t0 = Date.now();
			let opened = false;
			const sock = new WebSocket(wsUrl, {
				headers: { 'user-agent': `three-ws-viewer-load/${id}`, ...EXTRA_HEADERS },
			});
			const done = () => {
				if (opened) stats.open--;
				resolve(opened);
			};
			sock.on('open', () => {
				opened = true;
				stats.connectOk++;
				stats.open++;
				stats.peakOpen = Math.max(stats.peakOpen, stats.open);
				stats.ttfb.push(Date.now() - t0);
			});
			sock.on('message', (data) => {
				stats.events++;
				stats.bytes += data.length ?? 0;
			});
			sock.on('error', (err) => {
				if (!opened) stats.connectFail++;
				noteError(err);
			});
			sock.on('close', done);
			const watch = setInterval(() => {
				if (stopping || deadline()) {
					clearInterval(watch);
					sock.close();
				}
			}, 1000);
			watch.unref?.();
		});
		if (held && !stopping && !deadline()) stats.reconnects++;
		await sleep(1000);
	}
}

function preflight() {
	const needed = Math.ceil(N * 1.2) + 64;
	// process.report does not carry rlimits on every build, so read the kernel's
	// own view. Getting this wrong is the single most common reason a 1000-viewer
	// run quietly tops out in the hundreds with EMFILE.
	let limit = null;
	try {
		const row = readFileSync('/proc/self/limits', 'utf8')
			.split('\n')
			.find((l) => l.startsWith('Max open files'));
		const soft = row?.trim().split(/\s{2,}/)[1];
		limit = soft === 'unlimited' ? Infinity : Number(soft) || null;
	} catch {
		limit = null;
	}
	if (limit && limit !== Infinity && limit < needed) {
		console.error(
			`File-descriptor limit is ${limit}, which cannot hold ${N} sockets.\n` +
				`Raise it before running: ulimit -n ${Math.max(needed, 65536)}`
		);
		process.exit(2);
	}
	return limit;
}

let startedAt = 0;

async function main() {
	const fdLimit = preflight();
	console.log(
		`Viewer load test\n` +
			`  target   ${target.href}\n` +
			`  mode     ${MODE}\n` +
			`  viewers  ${N} (ramp ${RAMP_MS / 1000}s, hold ${HOLD_MS / 1000}s)\n` +
			`  fd limit ${fdLimit === Infinity ? 'unlimited' : (fdLimit ?? 'unknown')}\n`
	);

	startedAt = Date.now();
	const runner = MODE === 'sse' ? runSseViewer : MODE === 'get' ? runGetViewer : runWsViewer;
	const gap = N > 1 ? RAMP_MS / (N - 1) : 0;

	const ticker = setInterval(() => {
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
		process.stdout.write(
			`\r  t+${elapsed}s  joined ${stats.joined}/${N}  held ${stats.open}  ` +
				`ok ${stats.connectOk}  fail ${stats.connectFail}  reconnects ${stats.reconnects}  ` +
				`events ${stats.events}   `
		);
	}, 2000);

	const viewers = [];
	for (let i = 0; i < N; i++) {
		if (stopping) break;
		stats.joined++;
		viewers.push(runner(i).catch((err) => noteError(err)));
		if (gap) await sleep(gap);
	}
	await Promise.all(viewers);
	clearInterval(ticker);
	process.stdout.write('\r');
	report();
}

function report() {
	const sorted = stats.ttfb.slice().sort((a, b) => a - b);
	const attempts = stats.connectOk + stats.connectFail;
	const successRate = attempts ? (stats.connectOk / attempts) * 100 : 0;
	const elapsed = (Date.now() - startedAt) / 1000;

	console.log(`\nResults after ${elapsed.toFixed(0)}s\n`);
	console.log(`  peak concurrent held   ${stats.peakOpen} of ${N} requested`);
	console.log(`  connections ok/failed  ${stats.connectOk} / ${stats.connectFail} (${successRate.toFixed(2)}% ok)`);
	console.log(`  reconnects             ${stats.reconnects}`);
	console.log(`  payload events         ${stats.events}`);
	console.log(`  bytes received         ${human(stats.bytes)}`);
	console.log(
		`  time to first byte     p50 ${ms(pct(sorted, 50))}  p95 ${ms(pct(sorted, 95))}  p99 ${ms(pct(sorted, 99))}  max ${ms(sorted.at(-1))}`
	);

	if (stats.status.size) {
		const line = [...stats.status.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([code, n]) => `${code}:${n}`)
			.join('  ');
		console.log(`  http status            ${line}`);
	}
	if (stats.errors.size) {
		const line = [...stats.errors.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([code, n]) => `${code}:${n}`)
			.join('  ');
		console.log(`  socket errors          ${line}`);
	}

	const heldEnough = stats.peakOpen >= N * 0.99;
	const cleanEnough = successRate >= 99;

	// The trap this branch exists to close: a run plateaus far below --n and reads
	// like a server that fell over, when in fact the load generator's own host ran
	// out of outbound sockets. A NAT-ed VM or Codespace commonly ceilings near 512
	// concurrent egress connections REGARDLESS of destination. The tell is that the
	// target never once said no: every answered request was 2xx and no socket
	// errored. Reporting that as target capacity is a false outage.
	const targetRejected =
		[...stats.status.keys()].some((code) => Number(code) >= 400) || stats.errors.size > 0;
	const generatorBound = !heldEnough && !targetRejected;

	console.log('');
	if (generatorBound) {
		console.log(
			`  INCONCLUSIVE: plateaued at ${stats.peakOpen} concurrent, but the target never rejected\n` +
				`  anything (no 4xx/5xx, no socket errors). ${N - stats.peakOpen} requests were still\n` +
				`  unanswered locally when the run ended, which is this host's outbound connection\n` +
				`  ceiling, not the server's capacity.\n` +
				`  Confirm: node scripts/viewer-load-test.mjs --n ${stats.peakOpen} (should PASS cleanly).\n` +
				`  To exceed it, split the load across hosts: ${Math.ceil(N / Math.max(1, stats.peakOpen))} machines\n` +
				`  running --n ${Math.ceil(N / Math.ceil(N / Math.max(1, stats.peakOpen)))} each.`
		);
	} else if (heldEnough && cleanEnough) {
		console.log(`  PASS: sustained ${stats.peakOpen} concurrent viewers with ${successRate.toFixed(2)}% clean connects.`);
	} else {
		if (!heldEnough) console.log(`  FAIL: peaked at ${stats.peakOpen} concurrent, short of the ${N} requested.`);
		if (!cleanEnough) console.log(`  FAIL: connect success ${successRate.toFixed(2)}% is under the 99% bar.`);
	}
	process.exitCode = heldEnough && cleanEnough ? 0 : generatorBound ? 2 : 1;
}

process.on('SIGINT', () => {
	if (stopping) process.exit(130);
	stopping = true;
	console.log('\nStopping, draining viewers...');
});

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
