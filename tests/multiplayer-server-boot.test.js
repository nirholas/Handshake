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
