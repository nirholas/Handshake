// End-to-end conformance run for the /play event souvenir drop.
//
// Proves the four properties the feature promises, against a real browser, a
// real Colyseus server and a real persistence round-trip:
//
//   1. LIVE WINDOW → the souvenir is granted on join, announced once, equips,
//      and shows on the avatar and in the wardrobe.
//   2. IDEMPOTENT → a full reconnect as the same account re-grants nothing:
//      no second announcement, no duplicate in the owned list, and the item is
//      still worn (it persisted).
//   3. VISIBLE TO PEERS → a second player in the world sees the wearer's
//      loadout on the shared schema, which is what makes a souvenir social.
//   4. CLOSED WINDOW → a fresh account joining after the event ends is granted
//      nothing, while an account that earned it earlier still wears it.
//
// The event config is served from THIS process (a throwaway static endpoint) so
// nothing in the repo is edited to fake a live window, and the window can be
// opened and closed between phases of one run. Point the game server at it with
// EVENT_CONFIG_URL — see below.
//
// Requires vite on :3000 and colyseus on :2567 with the config override:
//
//   node scripts/play-souvenir-e2e.mjs            # boots both servers itself
//   EXTERNAL=1 node scripts/play-souvenir-e2e.mjs # you started them yourself
//
// Exit code is 0 only when every check passes.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const MINT = process.env.COIN || 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const WORLD = `${BASE}/play?coin=${encodeURIComponent(MINT)}&name=three.ws&symbol=three`;
const SOUVENIR_ID = 'laurel-meetup';
const CONFIG_PORT = Number(process.env.CONFIG_PORT || 4599);
const EXTERNAL = process.env.EXTERNAL === '1';
const LOAD_MS = Number(process.env.LOAD_MS || 300_000);
const JOIN_MS = Number(process.env.JOIN_MS || 180_000);

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const results = [];

function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	console.log(`${at()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	return ok;
}

// ── the event config this run controls ─────────────────────────────────────

// `live` flips the window between "happening right now" and "ended an hour ago"
// without touching public/event.json. The game server re-reads on its own TTL,
// so a phase change is a matter of flipping this and waiting out the cache.
let windowState = 'live';

function configDoc() {
	const now = Date.now();
	const [startsAt, endsAt] = windowState === 'live'
		? [now - 10 * 60_000, now + 60 * 60_000]
		: [now - 3 * 60 * 60_000, now - 60 * 60_000];
	return {
		id: 'souvenir-e2e',
		name: '$THREE Community Day 2026',
		tagline: 'Conformance run for the souvenir drop.',
		startsAt: new Date(startsAt).toISOString(),
		endsAt: new Date(endsAt).toISOString(),
		link: `/play?coin=${MINT}&name=three.ws&symbol=three`,
		souvenir: { cosmeticId: SOUVENIR_ID },
		agenda: [],
	};
}

function serveConfig() {
	const server = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(JSON.stringify(configDoc()));
	});
	return new Promise((r) => server.listen(CONFIG_PORT, '127.0.0.1', () => r(server)));
}

// ── servers ────────────────────────────────────────────────────────────────

const procs = [];
function start(name, cmd, args, { cwd = ROOT, env = {} } = {}) {
	const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
	procs.push(child);
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding('utf8');
		stream.on('data', (c) => {
			for (const line of c.split('\n')) {
				// Only surface what this run is about; a Colyseus log line per join
				// would bury the checks.
				if (line && /souvenir|event-drop|error|Error|listening|ready in/i.test(line)) {
					console.log(`${at()} [${name}] ${line.trim().slice(0, 200)}`);
				}
			}
		});
	}
	return child;
}

async function waitFor(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const res = await fetch(url);
			if (res.ok || res.status === 404) return true;
		} catch { /* not up yet */ }
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 1000));
	}
}

// ── browser helpers ────────────────────────────────────────────────────────

async function until(page, fn, { timeout = 30_000, every = 300, arg } = {}) {
	const deadline = Date.now() + timeout;
	let last;
	for (;;) {
		try { last = await page.evaluate(fn, arg); } catch (err) { last = { evalError: String(err).slice(0, 140) }; }
		if (last === true || last?.ok === true) return last;
		if (Date.now() > deadline) return last;
		await page.waitForTimeout(every);
	}
}

async function dismissOverlays(page, rounds = 6) {
	for (let i = 0; i < rounds; i++) {
		const clicked = await page.evaluate(() => {
			const btn = [...document.querySelectorAll('button')].find(
				(b) => /^(continue|enter the world|got it|start|close|skip|drop in now)$/i.test(b.textContent.trim()) && b.offsetParent,
			);
			if (btn) { btn.click(); return btn.textContent.trim(); }
			return null;
		});
		if (!clicked) break;
		await page.waitForTimeout(500);
	}
}

// A browser context is one player: its own storage means its own guest id, which
// is the identity the souvenir is granted against.
async function openPlayer(browser, tag, storageState) {
	const ctx = await browser.newContext(storageState ? { storageState } : {});
	const page = await ctx.newPage();
	const consoleErrors = [];
	page.on('console', (m) => {
		if (m.type() !== 'error') return;
		const text = m.text();
		// A dev origin logs unrelated noise (source maps, favicon, HMR); only the
		// page's own failures matter here.
		if (/favicon|sourcemap|Failed to load resource/i.test(text)) return;
		consoleErrors.push(text.slice(0, 200));
	});
	page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 200)}`));
	// Record every souvenir announcement this client receives, so "exactly once"
	// is measurable rather than assumed. Installed before any app code runs.
	await page.addInitScript(() => {
		window.__SOUVENIRS__ = [];
		const tick = setInterval(() => {
			const net = window.__CC__?.net;
			if (!net || net.__souvenirTap) return;
			net.__souvenirTap = true;
			try { net.on('souvenir', (m) => window.__SOUVENIRS__.push(m)); } catch { /* older build */ }
			clearInterval(tick);
		}, 200);
	});
	await page.goto(WORLD, { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
	await dismissOverlays(page);
	const joined = await until(page, () => {
		const net = window.__CC__?.net;
		return { ok: net?.status === 'online' && window.__CC__?.phase === 'world', status: net?.status, phase: window.__CC__?.phase };
	}, { timeout: JOIN_MS });
	if (joined?.ok !== true) throw new Error(`[${tag}] never joined the world: ${JSON.stringify(joined)}`);
	console.log(`${at()} [${tag}] in the world`);
	return { tag, ctx, page, consoleErrors };
}

// The client's own view of what it owns and wears, straight off the live scene.
const cosmeticsState = () => {
	const cc = window.__CC__;
	const snap = cc?._cosmeticsSnap?.cosmetics || {};
	return {
		owned: [...(snap.owned || [])],
		equipped: { ...(snap.equipped || {}) },
		wire: cc?.net?.state?.players?.get?.(cc.net.sessionId)?.cosmetics ?? null,
		souvenirs: window.__SOUVENIRS__ || [],
		cardVisible: !!document.querySelector('.es-card'),
		cardName: document.querySelector('.es-card .es-name')?.textContent || '',
	};
};

async function main() {
	const configServer = await serveConfig();
	console.log(`${at()} event config served at http://127.0.0.1:${CONFIG_PORT}/event.json (window: ${windowState})`);

	if (!EXTERNAL) {
		start('vite', 'npx', ['vite', '--port', '3000']);
		// The game server reads the event config from THIS process, not from
		// three.ws, which is what lets the run open and close the window at will.
		start('colyseus', 'node', ['src/index.js'], {
			cwd: resolve(ROOT, 'multiplayer'),
			env: { PORT: '2567', EVENT_CONFIG_URL: `http://127.0.0.1:${CONFIG_PORT}/event.json` },
		});
		if (!await waitFor('http://127.0.0.1:2567/health', 90_000)) throw new Error('colyseus never came up');
		if (!await waitFor(BASE, 120_000)) throw new Error('vite never came up');
		console.log(`${at()} servers up`);
	}

	const browser = await chromium.launch();
	const players = [];
	try {
		// ── Phase 1: window LIVE ───────────────────────────────────────────────
		const alice = await openPlayer(browser, 'alice');
		players.push(alice);

		const granted = await until(alice.page, () => {
			const s = window.__SOUVENIRS__ || [];
			return { ok: s.length > 0, n: s.length };
		}, { timeout: 60_000 });
		check('live window: souvenir announced on join', granted?.ok === true, JSON.stringify(granted));

		const afterGrant = await alice.page.evaluate(cosmeticsState);
		check('live window: announcement names the item', afterGrant.souvenirs[0]?.id === SOUVENIR_ID,
			JSON.stringify(afterGrant.souvenirs[0] || null));
		check('live window: owned exactly once', afterGrant.owned.filter((i) => i === SOUVENIR_ID).length === 1,
			`owned=${JSON.stringify(afterGrant.owned)}`);
		check('live window: drop card is on screen', afterGrant.cardVisible, afterGrant.cardName);

		// Wear it from the card, exactly as a player would.
		await alice.page.click('.es-card .es-btn-primary');
		const worn = await until(alice.page, ([id]) => {
			const eq = window.__CC__?._cosmeticsSnap?.cosmetics?.equipped || {};
			return { ok: eq.headwear === id, equipped: eq };
		}, { timeout: 30_000, arg: [SOUVENIR_ID] });
		check('live window: "Wear it" equips the souvenir', worn?.ok === true, JSON.stringify(worn?.equipped || worn));

		const onWire = await until(alice.page, ([id]) => {
			const cc = window.__CC__;
			const wire = cc?.net?.state?.players?.get?.(cc.net.sessionId)?.cosmetics || '';
			return { ok: wire.split(',').includes(id), wire };
		}, { timeout: 30_000, arg: [SOUVENIR_ID] });
		check('live window: souvenir published on the shared schema', onWire?.ok === true, JSON.stringify(onWire));

		// A peer must actually see it — that is what a souvenir is for.
		const bob = await openPlayer(browser, 'bob');
		players.push(bob);
		// `_cosWire` is the loadout string the peer's RemotePlayer last rendered, so
		// this asserts the souvenir actually reached another client's rig, not just
		// that the schema carried it.
		const peerSees = await until(bob.page, ([id]) => {
			const remotes = [...(window.__CC__?.remotes || new Map())].map(([, r]) => r);
			const wires = remotes.map((r) => String(r._cosWire || ''));
			return { ok: wires.some((w) => w.split(',').includes(id)), n: remotes.length, wires };
		}, { timeout: 60_000, arg: [SOUVENIR_ID] });
		check('live window: another player sees the souvenir worn', peerSees?.ok === true, JSON.stringify(peerSees));

		// The wardrobe is the other half of the moment.
		await alice.page.evaluate(() => window.__CC__._toggleWardrobe());
		const inWardrobe = await until(alice.page, ([id]) => {
			const card = document.querySelector(`.cw-card[data-id="${id}"]`);
			if (!card) return { ok: false, reason: 'no card' };
			return {
				ok: !card.classList.contains('cw-locked'),
				tier: card.getAttribute('data-tier'),
				label: card.querySelector('.cw-price')?.textContent || '',
				equipped: card.classList.contains('cw-equipped'),
			};
		}, { timeout: 30_000, arg: [SOUVENIR_ID] });
		check('live window: wardrobe shows it owned, event-tier and equipped',
			inWardrobe?.ok === true && inWardrobe.tier === 'event' && inWardrobe.equipped === true,
			JSON.stringify(inWardrobe));
		await alice.page.evaluate(() => window.__CC__._wardrobe?.close());

		// ── Phase 2: reconnect as the SAME account ─────────────────────────────
		const aliceState = await alice.ctx.storageState();
		await alice.page.close();
		await alice.ctx.close();
		players.pop();

		const aliceAgain = await openPlayer(browser, 'alice-rejoin', aliceState);
		players.push(aliceAgain);
		// Give the server the same amount of time it took to announce the first
		// time; a duplicate would have landed well inside it.
		await aliceAgain.page.waitForTimeout(15_000);
		const rejoin = await aliceAgain.page.evaluate(cosmeticsState);
		check('rejoin: no second announcement', rejoin.souvenirs.length === 0,
			`announcements=${rejoin.souvenirs.length}`);
		check('rejoin: still owned exactly once', rejoin.owned.filter((i) => i === SOUVENIR_ID).length === 1,
			`owned=${JSON.stringify(rejoin.owned)}`);
		check('rejoin: still worn (persisted across the reconnect)', rejoin.equipped.headwear === SOUVENIR_ID,
			JSON.stringify(rejoin.equipped));
		check('rejoin: no drop card (nothing new happened)', rejoin.cardVisible === false);

		// ── Phase 3: window CLOSED ─────────────────────────────────────────────
		windowState = 'ended';
		console.log(`${at()} event window flipped to ENDED; waiting out the server's config TTL`);
		// The reader caches for 120s; wait past it so the next join reads the
		// closed window rather than the cached live one.
		await new Promise((r) => setTimeout(r, 125_000));

		const carol = await openPlayer(browser, 'carol-after');
		players.push(carol);
		await carol.page.waitForTimeout(15_000);
		const after = await carol.page.evaluate(cosmeticsState);
		check('closed window: a new player is granted nothing', after.souvenirs.length === 0 && !after.owned.includes(SOUVENIR_ID),
			`announcements=${after.souvenirs.length} owned=${JSON.stringify(after.owned)}`);
		check('closed window: no drop card', after.cardVisible === false);

		const aliceStill = await aliceAgain.page.evaluate(cosmeticsState);
		check('closed window: an earlier attendee still owns and wears it',
			aliceStill.owned.includes(SOUVENIR_ID) && aliceStill.equipped.headwear === SOUVENIR_ID,
			JSON.stringify({ owned: aliceStill.owned, equipped: aliceStill.equipped }));

		// Someone who missed it sees the item, learns it was earned live, and is
		// offered no way to buy it.
		await carol.page.evaluate(() => window.__CC__._toggleWardrobe());
		const lockedCard = await until(carol.page, ([id]) => {
			const card = document.querySelector(`.cw-card[data-id="${id}"]`);
			if (!card) return { ok: false, reason: 'no card' };
			return { ok: true, locked: card.classList.contains('cw-locked'), label: card.querySelector('.cw-price')?.textContent || '' };
		}, { timeout: 30_000, arg: [SOUVENIR_ID] });
		check('closed window: wardrobe shows it locked and not for sale',
			lockedCard?.locked === true && /not for sale/i.test(lockedCard.label || ''),
			JSON.stringify(lockedCard));

		// ── console hygiene ────────────────────────────────────────────────────
		for (const p of players) {
			check(`${p.tag}: no console errors`, p.consoleErrors.length === 0, p.consoleErrors.slice(0, 3).join(' | '));
		}
	} finally {
		await browser.close().catch(() => {});
		configServer.close();
		for (const c of procs) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
	}

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${at()} ${results.length - failed.length}/${results.length} checks passed`);
	if (failed.length) {
		for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	for (const c of procs) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
	process.exit(1);
});
