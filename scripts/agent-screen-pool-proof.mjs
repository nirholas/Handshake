// Core-path proof for the on-demand caster pool (workers/agent-screen-pool).
//
// Runs the REAL worker binary (node workers/agent-screen-pool/index.js) as a
// child process against a real HTTP server that speaks the exact wire contract
// the production API speaks: the watch-wanted read side, the frame push sink and
// the control drain. Nothing inside the worker is stubbed, it launches real
// Chromium, navigates real pages, and pushes real JPEG bytes.
//
// What it proves, end to end:
//   1. the worker authenticates its watch-wanted poll with the shared secret,
//   2. a wanted agent gets a real Chromium page and real JPEG frames on the sink,
//   3. the task narration leads its action and the screenshot lands after it,
//   4. the control channel is drained for exactly the agents being cast,
//   5. the liveness endpoint reports what is casting (the Cloud Run probe path),
//   6. dropping the agent out of the watch set tears its browser down and the
//      frames stop.
//
//   node scripts/agent-screen-pool-proof.mjs
//
// Exit 0 = every assertion passed. Exit 1 = a failure (prints which).
// Needs outbound network: the task library browses real public sites, which is
// the whole point of the "watch an agent do real web work" moment.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pickTask } from '../workers/agent-screen-pool/tasks/index.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(__dir, '../workers/agent-screen-pool');

const SECRET = 'proof-secret-0123456789abcdef';
const AGENT_ID = '3a7c1f52-9d4e-4b61-8f20-2c5e7a91d0b4';
const AGENT_NAME = 'Proof Agent';
const CAST_MS = Number(process.env.PROOF_CAST_MS || 45_000);   // how long to watch the cast
const TEARDOWN_MS = 8_000;                                      // grace for the pool to drop the page

const results = [];
const ok = (name, cond, detail = '') => {
	results.push({ name, pass: !!cond, detail });
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The page the harness serves as the agent's home, so the first navigation and
// first frame land against a real HTTP page before the task takes over.
const HOME_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Proof agent home</title>
<style>body{margin:0;font:20px system-ui;background:#0b0d12;color:#e6e9ef;display:grid;place-items:center;height:100vh}</style>
</head><body><main><h1>Proof agent home</h1><p>Standing by for the cast.</p></main></body></html>`;

// ── the harness API: the real wire contract, nothing else ──────────────────────
const state = {
	wanted: [{ agentId: AGENT_ID, name: AGENT_NAME, homeUrl: null }], // homeUrl filled once the port is known
	frames: [],        // every push: { at, hasPixels, bytes, activity, type }
	wantedPolls: 0,
	authFailures: 0,
	drainPolls: 0,
	drainedIds: new Set(),
	brainCalls: 0,
};

function readBody(req) {
	return new Promise((done) => {
		let buf = '';
		req.on('data', (c) => { buf += c; });
		req.on('end', () => done(buf));
	});
}

function bearer(req) {
	const h = req.headers.authorization || '';
	return h.startsWith('Bearer ') ? h.slice(7) : '';
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1');
	const send = (code, obj) => {
		res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(JSON.stringify(obj));
	};

	if (url.pathname === '/home') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		return res.end(HOME_PAGE);
	}

	if (url.pathname === '/api/agent/watch-wanted') {
		state.wantedPolls++;
		if (bearer(req) !== SECRET) { state.authFailures++; return send(401, { error: 'unauthorized' }); }
		return send(200, { agents: state.wanted, ts: Date.now() });
	}

	if (url.pathname === '/api/agent-screen-push') {
		if (bearer(req) !== SECRET) { state.authFailures++; return send(401, { error: 'unauthorized' }); }
		const body = JSON.parse((await readBody(req)) || '{}');
		const data = body?.frame?.data || null;
		state.frames.push({
			at: Date.now(),
			agentId: body?.agentId || null,
			hasPixels: typeof data === 'string' && data.startsWith('data:image/jpeg;base64,'),
			bytes: typeof data === 'string' ? Buffer.from(data.split(',')[1] || '', 'base64') : null,
			activity: body?.frame?.activity || '',
			type: body?.frame?.type || '',
		});
		return send(200, { ok: true });
	}

	if (url.pathname === '/api/agent-screen-control-drain') {
		state.drainPolls++;
		if (bearer(req) !== SECRET) { state.authFailures++; return send(401, { error: 'unauthorized' }); }
		const body = JSON.parse((await readBody(req)) || '{}');
		for (const id of body?.agentIds || []) state.drainedIds.add(id);
		// Nobody is holding the wheel in this proof: no lease, no queued input.
		return send(200, { agents: {} });
	}

	// The narration brain is deliberately absent here, so the worker must fall back
	// to the task's own declarative lines. That fallback is what the ordering
	// assertions below are pinned against.
	if (url.pathname === '/api/brain/chat') {
		state.brainCalls++;
		return send(503, { error: 'brain offline for the proof' });
	}

	return send(404, { error: 'not found' });
});

function listen() {
	return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
}

async function main() {
	const port = await listen();
	const base = `http://127.0.0.1:${port}`;
	state.wanted[0].homeUrl = `${base}/home`;
	const healthPort = port + 1;

	const child = spawn(process.execPath, ['index.js'], {
		cwd: WORKER_DIR,
		env: {
			...process.env,
			SCREEN_WORKER_SECRET: SECRET,
			BASE_URL: base,
			PORT: String(healthPort),
			MAX_BROWSERS: '1',
			POLL_MS: '1000',
			FRAME_MS: '500',
			CONTROL_POLL_MS: '500',
			LEAD_MS: '400',
			DWELL_MS: '2000',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const workerLog = [];
	child.stdout.on('data', (b) => { workerLog.push(String(b)); process.stdout.write(`  [worker] ${b}`); });
	child.stderr.on('data', (b) => { workerLog.push(String(b)); process.stderr.write(`  [worker!] ${b}`); });

	let exited = null;
	child.on('exit', (code) => { exited = code; });

	try {
		// 1. The worker comes up and authenticates its poll.
		const pollDeadline = Date.now() + 15_000;
		while (state.wantedPolls === 0 && Date.now() < pollDeadline && exited === null) await sleep(200);
		ok('worker polls watch-wanted', state.wantedPolls > 0, `${state.wantedPolls} polls`);
		ok('worker survived boot', exited === null, exited === null ? '' : `exited ${exited}`);

		// 2. Real Chromium pixels land on the sink.
		const frameDeadline = Date.now() + CAST_MS;
		while (Date.now() < frameDeadline && exited === null) {
			const pix = state.frames.filter((f) => f.hasPixels).length;
			const done = state.frames.some((f) => /^Done/.test(f.activity)) || state.frames.some((f) => f.activity.startsWith('Found:'));
			if (pix >= 5 && done) break;
			await sleep(500);
		}

		const pixelFrames = state.frames.filter((f) => f.hasPixels);
		ok('real JPEG frames pushed', pixelFrames.length >= 5, `${pixelFrames.length} frames`);
		const jpegMagic = pixelFrames.filter((f) => f.bytes && f.bytes[0] === 0xff && f.bytes[1] === 0xd8 && f.bytes.length > 2000);
		ok('frames are decodable JPEG payloads', jpegMagic.length === pixelFrames.length && jpegMagic.length > 0,
			`${jpegMagic.length}/${pixelFrames.length} valid`);
		ok('every frame is attributed to the watched agent',
			state.frames.length > 0 && state.frames.every((f) => f.agentId === AGENT_ID));

		// 3. Narration leads the action, the screenshot lands after it. With the
		// brain offline the lines are the task's own declarative narration, so the
		// exact expected sequence is known.
		const task = pickTask(AGENT_ID);
		const narrations = state.frames.filter((f) => f.type === 'analysis' && f.activity);
		const firstLine = task.steps[0].narration;
		const leadIdx = state.frames.findIndex((f) => f.activity === firstLine);
		ok('the brain fallback narration is used when the router is down',
			state.brainCalls > 0 && leadIdx >= 0, `brain calls: ${state.brainCalls}, lead line: ${firstLine}`);
		const landedAfter = leadIdx >= 0 && state.frames.slice(leadIdx + 1).some((f) => f.hasPixels);
		ok('a screenshot lands after the narration that leads it', landedAfter);
		ok('narration lines reach the activity log', narrations.length >= 2, `${narrations.length} lines`);
		const read = state.frames.find((f) => f.activity.startsWith('Found:'));
		ok('the task reads real text back off the live page', !!read,
			read ? read.activity.slice(0, 60) : `task ${task.id} produced no read`);

		// 4. The control channel is drained for exactly what is casting.
		ok('control channel drained for the casting agent',
			state.drainPolls > 0 && state.drainedIds.has(AGENT_ID), `${state.drainPolls} drains`);
		ok('no request was ever rejected for bad auth', state.authFailures === 0, `${state.authFailures} failures`);

		// 5. The Cloud Run liveness endpoint reports the live pool.
		const health = await fetch(`http://127.0.0.1:${healthPort}/`).then((r) => r.json()).catch(() => null);
		ok('liveness endpoint answers on $PORT', !!health?.ok, health ? `worker=${health.worker}` : 'no response');
		ok('liveness endpoint lists the casting agent',
			Array.isArray(health?.casting) && health.casting.some((c) => c.agentId === AGENT_ID),
			health ? JSON.stringify(health.casting) : '');

		// 6. Nobody is watching anymore: the browser is torn down and frames stop.
		state.wanted = [];
		await sleep(TEARDOWN_MS);
		const cutoff = Date.now() - 3_000;
		const afterTeardown = state.frames.filter((f) => f.at > cutoff).length;
		ok('frames stop once nobody is watching', afterTeardown === 0, `${afterTeardown} late frames`);
		ok('teardown is logged by the worker', workerLog.join('').includes('stopped'));
	} finally {
		child.kill('SIGTERM');
		await sleep(1_000);
		if (exited === null) child.kill('SIGKILL');
		server.close();
	}

	const failed = results.filter((r) => !r.pass);
	console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
	if (failed.length) {
		console.log('failed:', failed.map((f) => f.name).join(', '));
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error('proof crashed:', err);
	process.exit(1);
});
