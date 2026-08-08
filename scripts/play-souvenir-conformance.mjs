// Souvenir drop conformance run: real Colyseus server, real rooms, real
// persistence, no browser.
//
// The browser run ([play-souvenir-e2e.mjs](play-souvenir-e2e.mjs)) is the one
// that proves the UI. This one proves the CONTRACT, and it does so with the
// actual colyseus.js client joining the actual `walk_world` room, so every
// assertion below crosses the real wire:
//
//   1. LIVE WINDOW     a player joining the event world is granted the souvenir,
//                      announced exactly once, and can equip it.
//   2. IDEMPOTENT      the same account rejoining is granted nothing more, gets
//                      no second announcement, and is still wearing it (proving
//                      the grant persisted, not just stuck in room memory).
//   3. WRONG WORLD     the same account, same instant, in a different coin world
//                      is granted nothing.
//   4. PEER-VISIBLE    a second player in the room sees the wearer's loadout on
//                      the shared schema.
//   5. CLOSED WINDOW   after the window ends, a fresh account gets nothing while
//                      the earlier attendee still owns and wears it.
//
// It boots its own game server on a private port against an event config it
// serves itself, so it edits nothing in the repo and leaves no live window
// behind. It needs no Vite, no GPU and no display, which is what lets it run on
// a machine too loaded to hold a WebGL page open.
//
//   node scripts/play-souvenir-conformance.mjs
//
// Exit code is 0 only when every check passes.

import { Client } from 'colyseus.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MP_PORT = Number(process.env.MP_PORT || 2572);
const CONFIG_PORT = Number(process.env.CONFIG_PORT || 4601);
const ENDPOINT = `ws://127.0.0.1:${MP_PORT}`;
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const OTHER_MINT = 'THREEsynthetic1111111111111111111111111111';
const SOUVENIR_ID = 'laurel-meetup';
const TTL_MS = 4000;

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	console.log(`${at()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
	return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the event config this run controls ─────────────────────────────────────

let windowState = 'live';
function configDoc() {
	const now = Date.now();
	const [startsAt, endsAt] = windowState === 'live'
		? [now - 10 * 60_000, now + 60 * 60_000]
		: [now - 3 * 60 * 60_000, now - 60 * 60_000];
	return {
		id: 'souvenir-conformance',
		name: '$THREE Community Day 2026',
		startsAt: new Date(startsAt).toISOString(),
		endsAt: new Date(endsAt).toISOString(),
		link: `/play?coin=${MINT}&name=three.ws&symbol=three`,
		souvenir: { cosmeticId: SOUVENIR_ID },
		agenda: [],
	};
}

// ── the game server ────────────────────────────────────────────────────────

const procs = [];
function startServer() {
	const child = spawn('node', ['src/index.js'], {
		cwd: resolve(ROOT, 'multiplayer'),
		env: {
			...process.env,
			PORT: String(MP_PORT),
			EVENT_CONFIG_URL: `http://127.0.0.1:${CONFIG_PORT}/event.json`,
			EVENT_CONFIG_TTL_MS: String(TTL_MS),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	procs.push(child);
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding('utf8');
		stream.on('data', (c) => {
			for (const line of c.split('\n')) {
				if (line && /souvenir|event-drop|EADDRINUSE|failed to start/i.test(line)) {
					console.log(`${at()} [server] ${line.trim().slice(0, 160)}`);
				}
			}
		});
	}
	return child;
}

async function waitForHealth(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if ((await fetch(`http://127.0.0.1:${MP_PORT}/health`)).ok) return true;
		} catch { /* not up yet */ }
		if (Date.now() > deadline) return false;
		await sleep(500);
	}
}

// ── a player ───────────────────────────────────────────────────────────────

// One player = one guest token, which is the identity the souvenir is granted
// against. Reusing a token across joins is exactly what a browser reconnect
// does, so `guestToken` is what makes the idempotency check meaningful.
async function join({ coin = MINT, guestToken = '', name = 'QA' } = {}) {
	const client = new Client(ENDPOINT);
	const souvenirs = [];
	let profile = null;
	let token = guestToken;

	const room = await client.joinOrCreate('walk_world', {
		token: coin,
		coin,
		coinName: coin === MINT ? 'three.ws' : 'Synthetic',
		coinSymbol: coin === MINT ? 'three' : 'syn',
		name,
		guestToken,
	});
	room.onMessage('souvenir', (m) => souvenirs.push(m));
	room.onMessage('profile', (m) => { profile = m; });
	room.onMessage('guestToken', (m) => { if (m?.token) token = m.token; });
	// A real world pushes a steady stream of minigame, quest and HUD traffic that
	// this run has no opinion about. colyseus.js warns once per unhandled type,
	// which drowns the checks; absorb the lot with a wildcard handler.
	room.onMessage('*', () => {});

	// Let the join handshake finish: the profile echo and any grant both land in
	// the first moments after the room resolves.
	await sleep(2500);

	return {
		room,
		souvenirs,
		get profile() { return profile; },
		get guestToken() { return token; },
		owned: () => [...(profile?.cosmetics?.owned || [])],
		equipped: () => ({ ...(profile?.cosmetics?.equipped || {}) }),
		// The compact loadout wire every peer in the room reads off the schema.
		wireFor: (sessionId) => room.state.players.get(sessionId)?.cosmetics ?? null,
		equip: async (id) => { room.send('equip-cosmetic', { id }); await sleep(1500); },
		leave: async () => { try { await room.leave(true); } catch { /* already gone */ } await sleep(300); },
	};
}

async function main() {
	const configServer = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(JSON.stringify(configDoc()));
	});
	await new Promise((r) => configServer.listen(CONFIG_PORT, '127.0.0.1', r));
	console.log(`${at()} event config on :${CONFIG_PORT} (window: ${windowState})`);

	startServer();
	if (!await waitForHealth(60_000)) throw new Error('game server never came up');
	console.log(`${at()} game server up on :${MP_PORT}`);

	try {
		// ── 1. live window ─────────────────────────────────────────────────────
		const alice = await join({ name: 'Alice' });
		check('live window: granted on join', alice.souvenirs.length === 1,
			`announcements=${alice.souvenirs.length}`);
		check('live window: the announcement names the souvenir',
			alice.souvenirs[0]?.id === SOUVENIR_ID,
			JSON.stringify(alice.souvenirs[0] || null));
		check('live window: owned exactly once', alice.owned().filter((i) => i === SOUVENIR_ID).length === 1,
			`owned=${JSON.stringify(alice.owned())}`);
		check('live window: not auto-equipped over the player\'s own fit',
			alice.equipped().headwear !== SOUVENIR_ID,
			`headwear=${alice.equipped().headwear}`);

		await alice.equip(SOUVENIR_ID);
		check('live window: it equips', alice.equipped().headwear === SOUVENIR_ID,
			JSON.stringify(alice.equipped()));
		check('live window: published on the shared schema',
			String(alice.wireFor(alice.room.sessionId) || '').split(',').includes(SOUVENIR_ID),
			`wire=${alice.wireFor(alice.room.sessionId)}`);

		const aliceToken = alice.guestToken;
		check('live window: the server issued a durable identity', !!aliceToken);

		// ── 2. peer visibility ─────────────────────────────────────────────────
		const bob = await join({ name: 'Bob' });
		await sleep(1500);
		const seenByBob = bob.wireFor(alice.room.sessionId);
		check('another player sees the souvenir on the wearer',
			String(seenByBob || '').split(',').includes(SOUVENIR_ID),
			`peer wire=${seenByBob}`);
		check('the peer was granted their own copy too (they are also here)',
			bob.souvenirs.length === 1 && bob.owned().includes(SOUVENIR_ID),
			`announcements=${bob.souvenirs.length}`);
		await bob.leave();

		// ── 3. wrong world, same instant ───────────────────────────────────────
		await alice.leave();
		const aliceElsewhere = await join({ coin: OTHER_MINT, guestToken: aliceToken, name: 'Alice' });
		check('a different world grants nothing, even while the event is live',
			aliceElsewhere.souvenirs.length === 0,
			`announcements=${aliceElsewhere.souvenirs.length}`);
		await aliceElsewhere.leave();

		const carolElsewhere = await join({ coin: OTHER_MINT, name: 'Carol' });
		check('a player who was never in the event world owns nothing',
			carolElsewhere.souvenirs.length === 0 && !carolElsewhere.owned().includes(SOUVENIR_ID),
			`owned=${JSON.stringify(carolElsewhere.owned())}`);
		await carolElsewhere.leave();

		// ── 4. reconnect as the same account ───────────────────────────────────
		const aliceAgain = await join({ guestToken: aliceToken, name: 'Alice' });
		check('rejoin: no second announcement', aliceAgain.souvenirs.length === 0,
			`announcements=${aliceAgain.souvenirs.length}`);
		check('rejoin: still owned exactly once',
			aliceAgain.owned().filter((i) => i === SOUVENIR_ID).length === 1,
			`owned=${JSON.stringify(aliceAgain.owned())}`);
		check('rejoin: still worn, so the equip persisted across the reconnect',
			aliceAgain.equipped().headwear === SOUVENIR_ID,
			JSON.stringify(aliceAgain.equipped()));

		// ── 5. closed window ───────────────────────────────────────────────────
		windowState = 'ended';
		console.log(`${at()} window flipped to ENDED; waiting out the ${TTL_MS}ms config TTL`);
		await sleep(TTL_MS + 2000);

		const dave = await join({ name: 'Dave' });
		check('closed window: a new player is granted nothing',
			dave.souvenirs.length === 0 && !dave.owned().includes(SOUVENIR_ID),
			`announcements=${dave.souvenirs.length} owned=${JSON.stringify(dave.owned())}`);
		check('closed window: they cannot equip what they were never granted',
			await (async () => {
				await dave.equip(SOUVENIR_ID);
				return dave.equipped().headwear !== SOUVENIR_ID;
			})(),
			`headwear=${dave.equipped().headwear}`);
		await dave.leave();

		await aliceAgain.leave();
		const aliceAfter = await join({ guestToken: aliceToken, name: 'Alice' });
		check('closed window: an earlier attendee still owns it',
			aliceAfter.owned().includes(SOUVENIR_ID), `owned=${JSON.stringify(aliceAfter.owned())}`);
		check('closed window: and is still wearing it',
			aliceAfter.equipped().headwear === SOUVENIR_ID, JSON.stringify(aliceAfter.equipped()));
		// Unequip and re-equip after the event to prove ownership is not time-scoped.
		await aliceAfter.equip('head-none');
		await aliceAfter.equip(SOUVENIR_ID);
		check('closed window: they can still take it off and put it back on',
			aliceAfter.equipped().headwear === SOUVENIR_ID, JSON.stringify(aliceAfter.equipped()));
		await aliceAfter.leave();
	} finally {
		configServer.close();
		for (const c of procs) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
	}

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${at()} ${results.length - failed.length}/${results.length} checks passed`);
	if (failed.length) {
		for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	for (const c of procs) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
	process.exit(1);
});
