// Wire-level proof of the /play reconnect contract, with no browser involved.
//
// The two-context browser run (scripts/play-multiplayer-e2e.mjs) is the full
// product check, but it needs two software-rendered 3D worlds and minutes of
// wall clock. This one talks to a WalkRoom the way the client does, so it proves
// the part that is easy to break and impossible to eyeball, in seconds:
//
//   1. A player who reconnects after an UNCLEAN drop does not leave a ghost of
//      themselves in the room. The dead socket is still half-open server-side
//      (the transport only reaps it when its ping retries expire), so without
//      the `prevSession` eviction the room holds two sessions for one person and
//      everyone watches a frozen copy of them standing at spawn.
//   2. `prevSession` cannot be aimed at anyone else. Naming a stranger's session
//      id is a no-op, because the server only honours it alongside a matching
//      persistent player key.
//   3. A peer who leaves is really gone from the roster the reconnecting client
//      is handed, so the client has something truthful to rebuild from.
//
// Usage (starts and stops its own server unless one is already given):
//   node scripts/play-reconnect-proof.mjs
//   SERVER=ws://localhost:2567 node scripts/play-reconnect-proof.mjs
//
// Exit code 0 only when every assertion passes.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'colyseus.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOM = 'walk_world';
const COIN = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const PORT = Number(process.env.PORT || 2599);
const SERVER = process.env.SERVER || `ws://localhost:${PORT}`;

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `, ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn a WalkRoom server unless the caller pointed us at one. Origin-less
// upgrades are accepted outside production, which is what a Node client sends.
async function startServer() {
	if (process.env.SERVER) return null;
	const child = spawn(process.execPath, ['multiplayer/src/index.js'], {
		cwd: root,
		env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let out = '';
	child.stdout.on('data', (b) => { out += b; });
	child.stderr.on('data', (b) => { out += b; });
	for (let i = 0; i < 60; i++) {
		if (/listening on ws:/.test(out)) return child;
		if (child.exitCode !== null) throw new Error(`server exited: ${out.slice(-500)}`);
		await sleep(500);
	}
	child.kill('SIGKILL');
	throw new Error(`server never came up: ${out.slice(-500)}`);
}

// Join as one player. `pid` is the persistent key the server resolves an
// identity from; two joins sharing it are the same person on the same device.
async function join(pid, name, extra = {}) {
	const client = new Client(SERVER);
	const room = await client.joinOrCreate(ROOM, {
		coin: COIN, tier: '', coinName: 'three.ws', coinSymbol: 'three',
		name, pid, ...extra,
	});
	// The server hands a guest a signed token on join and expects it back on the
	// next one; without replaying it a "reconnect" resolves to a brand-new guest
	// identity, which is exactly the case the eviction must not fire on.
	const tokenReady = new Promise((resolve) => {
		room.onMessage('guestToken', (m) => resolve(m?.token || ''));
		setTimeout(() => resolve(''), 3000);
	});
	await new Promise((resolve) => { room.onStateChange.once(() => resolve()); });
	return { client, room, guestToken: await tokenReady };
}

const names = (room) => [...room.state.players.values()].map((p) => p.name).sort();
const count = (room, name) => [...room.state.players.values()].filter((p) => p.name === name).length;

// Kill the socket the way a sleeping phone does: rip it out with no close
// handshake, so the server keeps reading it as OPEN until its pings time out.
function killSocketUncleanly(room) {
	const ws = room.connection?.transport?.ws || room.connection?.ws;
	if (!ws) throw new Error('could not reach the underlying socket');
	// Drop the client's own listeners first so colyseus.js does not run its
	// normal leave path, then destroy the TCP socket underneath.
	ws.onclose = null; ws.onerror = null; ws.onmessage = null;
	if (typeof ws.terminate === 'function') ws.terminate();
	else if (ws._socket) ws._socket.destroy();
	else ws.close();
}

const server = await startServer();
let a; let b; let a2; let intruder;
try {
	b = await join('guest-proof-bob', 'BobProof');
	a = await join('guest-proof-alice', 'AliceProof');
	await sleep(600);
	check('both players are in the room', names(b.room).join(',') === 'AliceProof,BobProof', names(b.room).join(','));

	// --- 1. reconnect while the old session is still present -----------------
	//
	// This models the half-open socket exactly as the SERVER experiences it: the
	// previous session is in the room and its socket still reads OPEN, because
	// the transport's ping retries have not expired. Leaving the first socket
	// genuinely alive is what makes the test deterministic; killing it here would
	// not reproduce the hazard, since a torn-down loopback socket sends a TCP
	// reset the server sees at once, and no real dropped connection does that.
	const aOldSession = a.room.sessionId;
	const oldSessionClosed = new Promise((resolve) => { a.room.onLeave(() => resolve(true)); });
	a2 = await join('guest-proof-alice', 'AliceProof', {
		prevSession: aOldSession,
		...(a.guestToken ? { guestToken: a.guestToken } : {}),
	});
	await sleep(800);
	check('the reconnected player got a fresh session id', a2.room.sessionId !== aOldSession,
		`${aOldSession} -> ${a2.room.sessionId}`);
	check('reconnecting retires the player\'s own superseded session, leaving no ghost',
		count(b.room, 'AliceProof') === 1, `${count(b.room, 'AliceProof')} AliceProof in room`);
	check('the superseded session was actually closed by the server',
		await Promise.race([oldSessionClosed, sleep(2000).then(() => false)]) === true);
	check('the roster handed to the reconnecting client matches the server',
		names(a2.room).join(',') === 'AliceProof,BobProof', names(a2.room).join(','));

	// A drop with no `prevSession` (an older client, or a first join) must be
	// inert rather than guessing: nothing is evicted, and the room heals only
	// when the transport reaps the dead socket on its own.
	killSocketUncleanly(a2.room);
	await sleep(1200);
	check('a socket that dies is reaped without help too',
		count(b.room, 'AliceProof') === 0, names(b.room).join(','));
	a2 = await join('guest-proof-alice', 'AliceProof', {
		prevSession: a2.room.sessionId,
		...(a.guestToken ? { guestToken: a.guestToken } : {}),
	});
	await sleep(600);
	check('rejoining after a reaped drop leaves exactly one of the player',
		count(b.room, 'AliceProof') === 1, names(b.room).join(','));

	// --- 2. prevSession cannot evict a stranger -----------------------------
	const bSession = b.room.sessionId;
	intruder = await join('guest-proof-intruder', 'IntruderProof', { prevSession: bSession });
	await sleep(800);
	check('naming a stranger\'s session id does not evict them',
		count(intruder.room, 'BobProof') === 1 && b.room.connection.isOpen === true,
		`BobProof x${count(intruder.room, 'BobProof')}, socket open=${b.room.connection.isOpen}`);

	// --- 3. a departure really leaves the roster ----------------------------
	await intruder.room.leave();
	intruder = null;
	await sleep(800);
	check('a player who leaves is gone from the roster peers read',
		count(a2.room, 'IntruderProof') === 0, names(a2.room).join(','));
} catch (err) {
	check('run completed without throwing', false, String(err?.stack || err).slice(0, 400));
} finally {
	for (const c of [a2, b, intruder]) { try { await c?.room.leave(); } catch { /* already gone */ } }
	if (server) server.kill('SIGKILL');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
process.exit(failed.length ? 1 : 0);
