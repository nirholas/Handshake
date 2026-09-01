// The multiplayer package's main export (multiplayer/src/index.js) is the whole
// product: it is what Cloud Run runs, what /play, /walk, /irl, /ar/studio,
// /agora and /play/war all connect to. Every other suite in this repo imports a
// leaf module out of multiplayer/src and tests it in isolation, so a change that
// leaves the process unable to BOOT (a bad import, a room that throws at define
// time, a broken Express mount) passes the whole test run and is only caught by
// a deploy or a person opening the world.
//
// This suite boots the real entry point as a child process on a free port and
// talks to it over real HTTP and a real WebSocket. No mocks, no fakes: the
// server here is byte-for-byte the one the Dockerfile runs.
//
// The wire-level reconnect contract has its own deeper proof
// (scripts/play-reconnect-proof.mjs, nine assertions about session eviction);
// this suite covers the boot + public surface that proof takes for granted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'multiplayer-boot-suite-secret';
const COIN = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

let child;
let port;
let base;

/** Ask the OS for a port nobody is using, so concurrent suites never collide. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port: p } = srv.address();
			srv.close(() => resolve(p));
		});
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attempt a raw WebSocket upgrade carrying `origin` and report what the
 * transport's verifyClient decided. A rejected handshake never opens, it comes
 * back as an HTTP response, so the status code is the answer either way.
 * Resolves 101 when the upgrade was accepted.
 */
async function upgradeStatus(origin, targetPort = port) {
	const { WebSocket } = await import('ws');
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${targetPort}`, {
			headers: origin === null ? {} : { origin },
		});
		const done = (v) => { try { sock.close(); } catch { /* already closed */ } resolve(v); };
		sock.on('open', () => done(101));
		sock.on('unexpected-response', (_req, res) => { res.resume(); done(res.statusCode); });
		sock.on('error', (err) => {
			// An accepted upgrade that the Colyseus protocol then closes still proves
			// verifyClient said yes; only a refused handshake surfaces a status here.
			if (/Unexpected server response: (\d+)/.test(err?.message || '')) {
				return resolve(Number(RegExp.$1));
			}
			reject(err);
		});
		setTimeout(() => reject(new Error(`upgrade to ${origin} never settled`)), 10_000).unref?.();
	});
}

/**
 * Boot the entry point with an arbitrary env overlay and resolve once it either
 * reports it is listening or exits. Used for the production-posture checks,
 * which are about what the process does at boot, not about serving traffic.
 */
function bootWith(env, targetPort) {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, ['multiplayer/src/index.js'], {
			cwd: root,
			env: {
				...process.env,
				PORT: String(targetPort),
				HOST: '127.0.0.1',
				UPSTASH_REDIS_REST_URL: '',
				UPSTASH_REDIS_REST_TOKEN: '',
				REDIS_URI: '',
				REDIS_URL: '',
				...env,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		const settle = (exitCode) => resolve({ proc, out, exitCode });
		proc.stdout.on('data', (b) => {
			out += b;
			if (/listening on ws:/.test(out)) settle(null);
		});
		proc.stderr.on('data', (b) => { out += b; });
		proc.on('exit', (code) => settle(code));
		proc.on('error', reject);
		setTimeout(() => reject(new Error(`boot never settled: ${out.slice(-400)}`)), 30_000).unref?.();
	});
}

/**
 * Sign an /internal/notify webhook exactly the way the three.ws API does
 * (api/_lib/presence-store.js → notifyMultiplayer). Keeping the signing here
 * rather than importing the verifier proves the two halves agree over the wire.
 */
function signNotify(to, type, payload, ts) {
	const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload ?? {})).digest('base64url');
	return crypto
		.createHmac('sha256', SECRET)
		.update(`notify:${to}:${type}:${ts}:${payloadHash}`)
		.digest('base64url');
}

beforeAll(async () => {
	port = await freePort();
	base = `http://127.0.0.1:${port}`;
	child = spawn(process.execPath, ['multiplayer/src/index.js'], {
		cwd: root,
		env: {
			...process.env,
			PORT: String(port),
			HOST: '127.0.0.1',
			NODE_ENV: 'development',
			MULTIPLAYER_SHARED_SECRET: SECRET,
			// StageRoom pulls its show config and the host's words from the three.ws
			// API. Point it at this server so the suite never reaches production:
			// every call 404s here, which exercises the room's own fallbacks.
			THREEWS_API_BASE: `http://127.0.0.1:${port}`,
			// Never let a developer's real Redis/Upstash creds leak a test room's
			// state into shared storage: this suite runs memory-only by construction.
			UPSTASH_REDIS_REST_URL: '',
			UPSTASH_REDIS_REST_TOKEN: '',
			REDIS_URI: '',
			REDIS_URL: '',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let out = '';
	child.stdout.on('data', (b) => { out += b; });
	child.stderr.on('data', (b) => { out += b; });
	for (let i = 0; i < 120; i++) {
		if (/listening on ws:/.test(out)) return;
		if (child.exitCode !== null) throw new Error(`server exited early: ${out.slice(-800)}`);
		await sleep(250);
	}
	throw new Error(`server never came up: ${out.slice(-800)}`);
});

afterAll(async () => {
	if (!child || child.exitCode !== null) return;
	child.kill('SIGKILL');
	await new Promise((r) => child.once('exit', r));
});

describe('multiplayer entry point', () => {
	it('answers both liveness probes the container health check uses', async () => {
		for (const route of ['/health', '/healthz']) {
			const res = await fetch(`${base}${route}`);
			expect(res.status, route).toBe(200);
			expect(await res.json()).toEqual({ ok: true, name: 'three.ws-multiplayer' });
		}
	});

	it('publishes a live population aggregate that carries no identity', async () => {
		const res = await fetch(`${base}/population`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true, coin: null, rooms: 0, players: 0 });
		// The /event landing page reads this through api/play/population.js, so it
		// must stay a count: no session ids, names, wallets or positions.
		expect(Object.keys(body).sort()).toEqual(['coin', 'ok', 'players', 'rooms']);
	});

	it('serves a real walk_world join and counts the player in /population', async () => {
		const { Client } = await import('colyseus.js');
		const client = new Client(`ws://127.0.0.1:${port}`);
		const room = await client.joinOrCreate('walk_world', {
			coin: COIN, tier: '', coinName: 'three.ws', coinSymbol: 'three',
			name: 'BootSuite', pid: 'guest-boot-suite',
		});
		try {
			await new Promise((resolve) => { room.onStateChange.once(() => resolve()); });
			const me = room.state.players.get(room.sessionId);
			expect(me, 'the joining client is in the authoritative roster').toBeTruthy();
			expect(me.name).toBe('BootSuite');

			const res = await fetch(`${base}/population?coin=${COIN}`);
			const body = await res.json();
			expect(body.ok).toBe(true);
			expect(body.coin).toBe(COIN);
			expect(body.rooms).toBe(1);
			expect(body.players).toBe(1);

			// A different coin is a different world, so it must not see this player.
			const other = await (await fetch(`${base}/population?coin=NotThisCoin111`)).json();
			expect(other).toMatchObject({ ok: true, rooms: 0, players: 0 });

			// ?by=coin adds the per-coin breakdown the /play lobby paints on its
			// cards. One poll, every world, still nothing but counts.
			const grouped = await (await fetch(`${base}/population?by=coin`)).json();
			expect(grouped).toMatchObject({ ok: true, players: 1 });
			expect(grouped.byCoin).toEqual({ [COIN]: 1 });
			expect(Object.keys(grouped).sort()).toEqual(['byCoin', 'coin', 'ok', 'players', 'rooms']);

			// Without the flag the response shape is byte-for-byte what every
			// existing caller already parses.
			const plain = await (await fetch(`${base}/population`)).json();
			expect(Object.keys(plain).sort()).toEqual(['coin', 'ok', 'players', 'rooms']);
		} finally {
			await room.leave();
		}
	});

	it('serves a real stage_world join wired the way /stage wires it', async () => {
		const { Client, getStateCallbacks } = await import('colyseus.js');
		const client = new Client(`ws://127.0.0.1:${port}`);
		// No root-schema class, like src/stage-net.js: state decodes from the
		// schema the server reflects during the handshake.
		const room = await client.joinOrCreate('stage_world', { stageId: 'boot-suite-stage', name: 'BootSuite' });
		try {
			// The first arrival opens the show and that `utterance` lands right after
			// JOIN_ROOM, so the handler has to exist before any state work.
			const utterances = [];
			room.onMessage('utterance', (m) => utterances.push(m));

			// The join resolves before the first state patch, so `state.host` has no
			// decoder ref yet and `onChange` on it throws. `listen` on the root is the
			// contract the browser client relies on: it defers until the host lands.
			const $ = getStateCallbacks(room);
			const host = await new Promise((resolve) => {
				$(room.state).listen('host', (h) => { if (h) resolve(h); });
			});
			expect(host.name, 'config 404s here, so the room falls back to a generic host').toBe('The Host');

			await new Promise((resolve) => {
				$(room.state).audience.onAdd((_m, key) => { if (key === room.sessionId) resolve(); });
			});
			const me = room.state.audience.get(room.sessionId);
			expect(me.name).toBe('BootSuite');
			expect(Math.hypot(me.x, me.z), 'the server seats each arrival on the ring').toBeGreaterThan(0);

			// The brain 404s here too; the room performs its fallback line rather
			// than going silent, and the caption in synced state matches the broadcast.
			const deadline = Date.now() + 10_000;
			while (!utterances.length && Date.now() < deadline) await sleep(100);
			expect(utterances.length, 'the opening beat reached a handler registered before state wiring').toBeGreaterThan(0);
			expect(utterances[0].text).toBeTruthy();
			expect(room.state.host.caption).toBe(utterances[0].text);
			expect(room.state.phase).toBe('live');
		} finally {
			await room.leave();
		}
	});

	it('refuses an unsigned or forged internal webhook', async () => {
		const post = (body, headers = {}) => fetch(`${base}/internal/notify`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
		});

		expect((await post({ type: '', to: '' })).status).toBe(400);
		expect((await post({ type: 'dm', to: 'acct-1', payload: {} })).status).toBe(401);

		const ts = Math.floor(Date.now() / 1000);
		const payload = { text: 'hello' };
		// A signature bound to a DIFFERENT body must not carry this one through.
		const wrong = signNotify('acct-1', 'dm', { text: 'other' }, ts);
		expect((await post({ type: 'dm', to: 'acct-1', payload }, {
			'x-mp-signature': wrong, 'x-mp-timestamp': String(ts),
		})).status).toBe(401);
	});

	it('accepts a correctly signed internal webhook and reports offline delivery honestly', async () => {
		const ts = Math.floor(Date.now() / 1000);
		const payload = { text: 'hello' };
		const res = await fetch(`${base}/internal/notify`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-mp-signature': signNotify('acct-offline', 'dm', payload, ts),
				'x-mp-timestamp': String(ts),
			},
			body: JSON.stringify({ type: 'dm', to: 'acct-offline', payload }),
		});
		expect(res.status).toBe(200);
		// Nobody with that account id has a socket here, so the API is told to fall
		// back to next-login delivery rather than being told a lie.
		expect(await res.json()).toEqual({ delivered: false });
	});

	it('refuses an unsigned operator announcement', async () => {
		const res = await fetch(`${base}/internal/announce`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: 'the event starts now' }),
		});
		expect(res.status).toBe(401);
	});
});

// The origin allow-list is the browser-facing filter documented in
// multiplayer/README.md: the listed origins plus any *.three.ws or *.vercel.app
// host upgrade, everything else is refused before the handshake completes. It is
// only a CSRF-style filter (each room's onAuth is the real access boundary), but
// it is the one part of the transport config a reader is told they can rely on.
describe('WebSocket origin allow-list', () => {
	it('upgrades an explicitly allowed origin', async () => {
		expect(await upgradeStatus('http://localhost:3000')).toBe(101);
	});

	it('upgrades any three.ws or Vercel preview subdomain without an entry per URL', async () => {
		expect(await upgradeStatus('https://staging.three.ws')).toBe(101);
		expect(await upgradeStatus('https://three-ws-abc123-team.vercel.app')).toBe(101);
	});

	it('upgrades any loopback port in dev, so a Vite that landed past 3003 still connects', async () => {
		// `npm run dev:walk-all` takes the first free port from 3000 up, so a second
		// checkout on the same box gets 3004+ and used to be refused by the fixed
		// default list. Production is unaffected: this branch is dev-only.
		expect(await upgradeStatus('http://localhost:3005')).toBe(101);
		expect(await upgradeStatus('http://127.0.0.1:4173')).toBe(101);
	});

	it('refuses an origin outside the allow-list', async () => {
		expect(await upgradeStatus('https://evil.example.com')).toBe(403);
		// A suffix that merely CONTAINS an allowed host must not pass: the check is
		// on the parsed hostname, not on the raw origin string.
		expect(await upgradeStatus('https://three.ws.evil.example.com')).toBe(403);
	});
});

// What the process does when NODE_ENV says production. Both behaviours here are
// safety defaults that only ever run on the live service, so nothing else
// exercises them; a regression would ship a forgeable holder gate or an open
// admin monitor.
describe('production posture', () => {
	it('refuses to boot in production without a real HOLDER_PASS_SECRET', async () => {
		const p = await freePort();
		const { out, exitCode } = await bootWith({ NODE_ENV: 'production', HOLDER_PASS_SECRET: '' }, p);
		expect(exitCode).toBe(1);
		expect(out).toMatch(/HOLDER_PASS_SECRET is required in production/);
	});

	it('leaves the admin monitor unmounted in production until credentials are set', async () => {
		const p = await freePort();
		const { proc, out } = await bootWith({
			NODE_ENV: 'production',
			HOLDER_PASS_SECRET: SECRET,
			MULTIPLAYER_SHARED_SECRET: SECRET,
			MONITOR_USER: '',
			MONITOR_PASS: '',
		}, p);
		try {
			expect(out).toMatch(/monitor disabled/);
			const res = await fetch(`http://127.0.0.1:${p}/colyseus`);
			expect(res.status).toBe(404);
			// Liveness still works, the process is healthy, just not exposing state.
			expect((await fetch(`http://127.0.0.1:${p}/health`)).status).toBe(200);
			// An origin-less upgrade is a production-only refusal: a browser always
			// sends Origin, so the omission is a bypass attempt there.
			expect(await upgradeStatus(null, p)).toBe(403);
			// The dev-only loopback and codespace widenings must not follow the
			// process into production; only the explicit list survives there.
			expect(await upgradeStatus('http://localhost:3005', p)).toBe(403);
			expect(await upgradeStatus('https://three.ws', p)).toBe(101);
		} finally {
			proc.kill('SIGKILL');
			await new Promise((r) => proc.once('exit', r));
		}
	});
});
