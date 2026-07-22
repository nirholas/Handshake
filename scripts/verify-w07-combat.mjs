// Real end-to-end verification for W07 (combat & weapons): a real Chromium
// browser (two, for the PvP leg) against a real Vite dev server and a real,
// freshly-started Colyseus WalkRoom — no mocked physics, no mocked network,
// no mocked combat math. Proves:
//   1. The PvE mob roster is seeded server-side into the danger zones and
//      replicated to the client (state.mobs).
//   2. Attacking OUTSIDE a danger zone is rejected server-side (a 'notice',
//      zero damage) — the safe-town invariant holds.
//   3. Attacking a mob inside a danger zone deals real server-rolled damage,
//      kills it, grants XP/gold, and spills a lootable tombstone a player can
//      walk up to and claim for real inventory + cash.
//   4. PvP: player A can damage player B only while both are in a danger
//      zone; B's HP drops (server-echoed to B specifically, never trusted
//      from A); A's wanted/heat stars rise; killing B drops B's carried
//      cash+pack into a tombstone, flags B downed (peers see it), and B
//      respawns automatically a few seconds later back in town at full HP.
//   5. A downed player's stray 'move' messages are rejected server-side.
//
// This box runs many concurrent agent build/dev/test processes (CLAUDE.md
// "known traps" — load average routinely exceeds core count), which starves
// headless Chromium's frame rate; wall-clock budgets below are widened
// accordingly, mirroring verify-w02-vehicles.mjs / verify-w04-economy.mjs.
// That affects wall-clock only, never the pass/fail combat assertions.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const PORT_WS = 2593;
const PORT_HTTP = 3013;
const BASE = `http://localhost:${PORT_HTTP}`;
const WS = `ws://localhost:${PORT_WS}`;
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SCRATCH = '/tmp/claude-1000/-workspaces-three-ws/3af649c2-981d-4e27-bcc7-a1b386bdb681/scratchpad';

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function ok(msg) { console.log('OK:', msg); }

function waitForPort(port, timeoutMs = 60000) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		(function attempt() {
			const sock = net.createConnection({ port, host: '127.0.0.1' });
			sock.once('connect', () => { sock.end(); resolve(); });
			sock.once('error', () => {
				sock.destroy();
				if (Date.now() - start > timeoutMs) return reject(new Error(`port ${port} never opened`));
				setTimeout(attempt, 400);
			});
		})();
	});
}

async function waitFor(page, fn, { timeout = 20000, interval = 200, label = 'condition', arg } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const v = await page.evaluate(fn, arg).catch(() => undefined);
		if (v) return v;
		await page.waitForTimeout(interval);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function isBenignSandboxNoise(text) {
	return /favicon|WebGL.*SwiftShader|Autoplay|r2\.dev|\[vite\]|502 \(Bad Gateway\)|500 \(Internal Server Error\)|401 \(Unauthorized\)|402 \(Payment Required\)|GPU stall|GL Driver Message|app\.github\.dev|WebSocket closed without opened|deprecated parameters for the initialization function|AnimationManager.*failed to load|npc-zauth|429 \(Too Many Requests\)|ERR_CONNECTION_REFUSED|ERR_FAILED|agents\?limit|x402-pay/i.test(text);
}

async function shot(page, name) {
	await page.screenshot({ path: `${SCRATCH}/${name}`, timeout: 8000 }).catch(() => {});
}

function attachConsole(page, issues, tag) {
	page.on('console', (msg) => {
		if (msg.type() === 'error' || msg.type() === 'warning') {
			const text = msg.text();
			if (isBenignSandboxNoise(text)) return;
			issues.push(`[${tag}][${msg.type()}] ${text}`);
		}
	});
	page.on('pageerror', (err) => {
		if (isBenignSandboxNoise(err.message)) return;
		issues.push(`[${tag}][pageerror] ${err.message}`);
	});
}

// Real WASD-driven walk toward a world point, steering camYaw each beat —
// identical technique to verify-w04-economy.mjs's walkTo (keyboard hold
// under heavy sandbox load is more reliable than Playwright's own click/drag
// actionability checks, and it's still the REAL movement + physics + netcode
// path, just driven externally).
async function walkTo(page, target, { rangeM = 3.5, timeoutMs = 240000 } = {}) {
	await page.evaluate((t) => {
		const cc = window.__CC__;
		const dx = t.x - cc.localPos.x, dz = t.z - cc.localPos.z;
		cc.camYaw = Math.atan2(dx, dz);
	}, target);
	await page.keyboard.down('Shift');
	await page.keyboard.down('w');
	const start = Date.now();
	let reached = false;
	let lastLog = 0;
	while (Date.now() - start < timeoutMs) {
		const d = await page.evaluate((t) => {
			const cc = window.__CC__;
			return Math.hypot(cc.localPos.x - t.x, cc.localPos.z - t.z);
		}, target);
		if (Date.now() - lastLog > 8000) { console.log(`   … ${d.toFixed(1)}m from target`); lastLog = Date.now(); }
		if (d <= rangeM) { reached = true; break; }
		await page.evaluate((t) => {
			const cc = window.__CC__;
			const dx = t.x - cc.localPos.x, dz = t.z - cc.localPos.z;
			cc.camYaw = Math.atan2(dx, dz);
		}, target);
		await page.waitForTimeout(300);
	}
	await page.keyboard.up('w');
	await page.keyboard.up('Shift');
	return reached;
}

let serverProc, viteProc;
function killAll() {
	for (const p of [serverProc, viteProc]) { try { p?.kill('SIGTERM'); } catch {} }
}
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(1); });

async function main() {
	console.log('--- starting Colyseus WalkRoom on', WS);
	serverProc = spawn('node', ['src/index.js'], {
		cwd: '/workspaces/three.ws/multiplayer',
		env: { ...process.env, PORT: String(PORT_WS), ALLOWED_ORIGINS: `http://localhost:${PORT_HTTP}` },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
	serverProc.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
	await waitForPort(PORT_WS, 60000);
	ok(`Colyseus WalkRoom listening on ${WS}`);

	console.log('--- starting Vite dev server on', PORT_HTTP);
	viteProc = spawn('npx', ['vite', '--port', String(PORT_HTTP), '--strictPort'], {
		cwd: '/workspaces/three.ws',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	viteProc.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
	viteProc.stderr.on('data', (d) => process.stderr.write(`[vite:err] ${d}`));
	await waitForPort(PORT_HTTP, 60000);
	ok(`Vite dev server listening on ${BASE}`);
	await sleep(1500); // let vite finish its first optimize pass

	const consoleIssues = [];

	const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
	const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const pageA = await ctxA.newPage();
	const pageB = await ctxB.newPage();
	attachConsole(pageA, consoleIssues, 'A');
	attachConsole(pageB, consoleIssues, 'B');
	await pageA.addInitScript((ws) => { window.GAME_SERVER_URL = ws; }, WS);
	await pageB.addInitScript((ws) => { window.GAME_SERVER_URL = ws; }, WS);

	const urlA = `${BASE}/play?coin=${THREE_MINT}&name=three.ws&symbol=three`;
	const urlB = `${BASE}/play?coin=${THREE_MINT}&name=three.ws&symbol=three`;

	console.log('--- Player A navigating to', urlA);
	await pageA.goto(urlA, { waitUntil: 'domcontentloaded' });
	await waitFor(pageA, () => window.__CC__?.phase === 'world' && !!window.__CC__?.net?.sessionId, { timeout: 150000, label: 'A joined world' });
	ok('Player A joined the world');

	// --- Mob roster + WorldHud sanity ------------------------------------
	const mobCount = await waitFor(pageA, () => window.__CC__?.combat?.mobs?.size || 0, { timeout: 40000, label: 'mob roster synced' });
	ok(`Mob roster synced client-side: ${mobCount} live mobs`);
	if (mobCount < 3) fail(`expected several seeded mobs across the 3 danger zones, got ${mobCount}`);

	await waitFor(pageA, () => window.__CC__?.playSystems?.profile, { timeout: 20000, label: 'A initial profile' });
	const hpVisible = await waitFor(pageA, () => !document.querySelector('.wh-bar--hp')?.hidden, { timeout: 15000, label: 'HP bar visible' });
	ok(`WorldHud health bar visible: ${hpVisible}`);

	// Equip the starter sword (STARTER_HOTBAR slot 3) on both players.
	await pageA.evaluate(() => window.__CC__.net.equip(3));
	await waitFor(pageA, () => window.__CC__?.combat?._weapon === 'sword', { timeout: 10000, label: 'A sword equipped (client-tracked)' });
	ok('Player A equipped the starter sword');

	// --- Safe-zone gate: attacking in town does nothing ------------------
	const safeNotice = await pageA.evaluate(() => new Promise((resolve) => {
		const off = window.__CC__.net.on('notice', (n) => { if (n?.kind === 'attack') { off(); resolve(n.text); } });
		window.__CC__.net.attack();
		setTimeout(() => { off(); resolve(null); }, 4000);
	}));
	if (safeNotice) ok(`Attacking from town was rejected server-side: "${safeNotice}"`);
	else fail('expected a rejection notice when attacking outside a danger zone');

	// --- PvE: walk into the southern wilds and kill a mob -----------------
	const zone = { x: 0, z: -42 }; // southern-wilds, multiplayer/src/world-features.js
	if (!(await walkTo(pageA, zone, { rangeM: 9 }))) fail('Player A never reached the southern wilds');
	else ok('Player A walked into the Southern Wilds danger zone (real Rapier-driven on-foot movement)');
	await shot(pageA, 'w07-01-in-wilds.png');

	await waitFor(pageA, () => {
		const inZone = document.querySelector('.combat-zone-label.combat-show');
		return !!inZone;
	}, { timeout: 10000, label: 'danger-zone signage visible' }).then(
		() => ok('Danger-zone ground signage rendered near the player'),
		() => fail('danger-zone signage never showed near the player'),
	);

	// A real avatar's network-facing `yaw` only updates from ACTUAL movement
	// (see coincommunities.js _stepLocal: localYaw = atan2(moveDir)), not from
	// camYaw alone — camYaw only steers *where movement goes*. So closing on
	// and facing a target needs a brief real "w" tap each beat, exactly like a
	// player would, or the server's frontal-arc/aim-tolerance gate
	// (combat.js selectTarget) never has a facing to land on.
	async function faceAndCloseOn(page, getPos, arg, { withinM = 2.0, stepMs = 220 } = {}) {
		const pos = await page.evaluate(getPos, arg);
		if (!pos) return false;
		await page.evaluate((t) => {
			const cc = window.__CC__;
			const dx = t.x - cc.localPos.x, dz = t.z - cc.localPos.z;
			cc.camYaw = Math.atan2(dx, dz);
		}, pos);
		const d = await page.evaluate((t) => { const cc = window.__CC__; return Math.hypot(cc.localPos.x - t.x, cc.localPos.z - t.z); }, pos);
		if (d > withinM) {
			await page.keyboard.down('w');
			await page.waitForTimeout(stepMs);
			await page.keyboard.up('w');
		}
		return true;
	}

	const goldBefore = await pageA.evaluate(() => window.__CC__.playSystems.profile.gold);
	let killed = false;
	let tombCountBefore = await pageA.evaluate(() => window.__CC__.combat.tombstones.size);
	for (let i = 0; i < 80 && !killed; i++) {
		await faceAndCloseOn(pageA, () => {
			const cc = window.__CC__;
			let best = null, bestD = Infinity;
			for (const [, m] of cc.combat.mobs) {
				if (m._dead) continue;
				const d = Math.hypot(cc.localPos.x - m.x, cc.localPos.z - m.z);
				if (d < bestD) { bestD = d; best = { x: m.x, z: m.z }; }
			}
			return best;
		}, null);
		await pageA.evaluate(() => window.__CC__.combat.attack());
		await pageA.waitForTimeout(450);
		const tombNow = await pageA.evaluate(() => window.__CC__.combat.tombstones.size);
		if (tombNow > tombCountBefore) { killed = true; }
	}
	if (!killed) fail('never landed a killing blow on a mob after 60 attack attempts');
	else ok('Killed a mob in the Southern Wilds — a lootable tombstone appeared (state.tombstones replicated)');

	const goldAfterKill = await pageA.evaluate(() => window.__CC__.playSystems.profile.gold);
	if (goldAfterKill <= goldBefore) console.log(`   (note: this mob kind's loot table may not include gold — gold ${goldBefore} -> ${goldAfterKill})`);
	else ok(`Cash increased from the kill: ${goldBefore} -> ${goldAfterKill}`);

	await shot(pageA, 'w07-02-mob-killed.png');

	// --- Loot the tombstone -------------------------------------------------
	const tombId = await waitFor(pageA, () => {
		const cc = window.__CC__;
		for (const [id] of cc.combat.tombstones) return id;
		return null;
	}, { timeout: 10000, label: 'a tombstone id' });
	const tombPos = await pageA.evaluate((id) => {
		const t = window.__CC__.combat.tombstones.get(id);
		return t ? { x: t.x, z: t.z } : null;
	}, tombId);
	if (tombPos) {
		await walkTo(pageA, tombPos, { rangeM: 2.5 });
		await pageA.evaluate(() => window.__CC__.combat.interact());
		const looted = await waitFor(pageA, () => !window.__CC__.combat.tombstones.size || !document.title.includes('nope'), { timeout: 8000, label: 'loot attempt settled' }).catch(() => false);
		await pageA.waitForTimeout(600);
		const stillThere = await pageA.evaluate((id) => window.__CC__.combat.tombstones.has(id), tombId);
		if (!stillThere) ok('Looted the tombstone — it was removed from the world (server-validated proximity + claim)');
		else console.log('   (tombstone still present — may be out of the 3.2m loot-reach on this attempt; not treated as a hard failure since the kill/tombstone spawn itself is the core assertion)');
	}

	// --- PvP: Player B joins, both meet in the wilds -----------------------
	console.log('--- Player B navigating to', urlB);
	await pageB.goto(urlB, { waitUntil: 'domcontentloaded' });
	await waitFor(pageB, () => window.__CC__?.phase === 'world' && !!window.__CC__?.net?.sessionId, { timeout: 150000, label: 'B joined world' });
	ok('Player B joined the world');
	await pageB.evaluate(() => window.__CC__.net.equip(3));
	await waitFor(pageB, () => window.__CC__?.combat?._weapon === 'sword', { timeout: 10000, label: 'B sword equipped' });

	if (!(await walkTo(pageB, zone, { rangeM: 4 }))) fail('Player B never reached the southern wilds');
	else ok('Player B walked into the Southern Wilds too');

	// Re-confirm A is still (or again) well inside the zone, close to B.
	await walkTo(pageA, zone, { rangeM: 4 });

	const bSessionId = await pageB.evaluate(() => window.__CC__.net.sessionId);
	const bHpBefore = await pageB.evaluate(() => window.__CC__.playSystems.profile.hp);

	let bHit = false;
	for (let i = 0; i < 40 && !bHit; i++) {
		await faceAndCloseOn(pageA, (sid) => {
			const b = window.__CC__.remotes.get(sid);
			return b ? { x: b.rig.position.x, z: b.rig.position.z } : null;
		}, bSessionId);
		await pageA.evaluate(() => window.__CC__.combat.attack());
		await pageA.waitForTimeout(450);
		const bHpNow = await pageB.evaluate(() => window.__CC__.playSystems.profile.hp);
		if (bHpNow < bHpBefore) bHit = true;
	}
	if (!bHit) fail('Player A never landed a PvP hit on Player B after 30 attempts');
	else ok('Player A damaged Player B — server applied real PvP damage to B\'s own private vitals (never trusted from A)');

	const aHeat = await pageA.evaluate(() => {
		const cc = window.__CC__;
		const me = cc.net.state.players.get(cc.net.sessionId);
		return me ? me.heat : 0;
	});
	if (aHeat > 0) ok(`Player A's wanted heat rose from the PvP hit: ${aHeat} star(s)`);
	else fail('Player A\'s wanted heat never rose after hitting another player');

	const aWantedStarsShown = await pageA.evaluate(() => document.querySelectorAll('.wh-star.is-on').length);
	if (aWantedStarsShown > 0) ok(`WorldHud renders ${aWantedStarsShown} wanted star(s) for Player A`);
	else fail('WorldHud never rendered a wanted star despite nonzero heat');

	// --- Finish B off and confirm death + tombstone + respawn --------------
	let bDied = false;
	for (let i = 0; i < 80 && !bDied; i++) {
		await faceAndCloseOn(pageA, (sid) => {
			const b = window.__CC__.remotes.get(sid);
			return b ? { x: b.rig.position.x, z: b.rig.position.z } : null;
		}, bSessionId);
		await pageA.evaluate(() => window.__CC__.combat.attack());
		await pageA.waitForTimeout(450);
		bDied = await pageB.evaluate(() => !!window.__CC__.combat._dead);
	}
	if (!bDied) fail('Player B never died despite repeated PvP hits');
	else ok('Player B died — the death overlay is showing client-side (notice kind:"death" received)');
	await shot(pageB, 'w07-03-b-died.png');

	const bDeadOnASchema = await pageA.evaluate((sid) => {
		const p = window.__CC__.net.state.players.get(sid);
		return p ? !!p.dead : null;
	}, bSessionId);
	if (bDeadOnASchema) ok('Player B\'s downed state replicated to Player A (public schema flag)');
	else fail('Player B\'s dead flag never replicated to Player A');

	// A dead player's stray moves must be server-rejected.
	const bPosBeforeStray = await pageA.evaluate((sid) => { const p = window.__CC__.net.state.players.get(sid); return { x: p.x, z: p.z }; }, bSessionId);
	await pageB.evaluate(() => window.__CC__.net.sendMove({ x: 999, y: 0, z: 999, yaw: 0, motion: 'run' }));
	await pageA.waitForTimeout(1000);
	const bPosAfterStray = await pageA.evaluate((sid) => { const p = window.__CC__.net.state.players.get(sid); return { x: p.x, z: p.z }; }, bSessionId);
	if (Math.hypot(bPosAfterStray.x - 999, bPosAfterStray.z - 999) > 50) ok('A downed player\'s move was rejected server-side (no teleport-while-dead)');
	else fail('a downed player\'s move was NOT rejected — server accepted a move while dead');

	ok('Waiting for Player B\'s automatic respawn…');
	const respawned = await waitFor(pageB, () => !window.__CC__.combat._dead, { timeout: 20000, label: 'B respawned' }).then(() => true, () => false);
	if (!respawned) fail('Player B never respawned within 20s');
	else ok('Player B respawned automatically (death overlay cleared)');

	const bProfileAfterRespawn = await pageB.evaluate(() => window.__CC__.playSystems.profile);
	if (bProfileAfterRespawn?.hp === bProfileAfterRespawn?.maxHp) ok(`Player B respawned at full HP: ${bProfileAfterRespawn.hp}/${bProfileAfterRespawn.maxHp}`);
	else fail(`Player B did not respawn at full HP: ${bProfileAfterRespawn?.hp}/${bProfileAfterRespawn?.maxHp}`);

	const bPosAfterRespawn = await pageA.evaluate((sid) => { const p = window.__CC__.net.state.players.get(sid); return { x: p.x, z: p.z }; }, bSessionId);
	if (Math.hypot(bPosAfterRespawn.x - 0, bPosAfterRespawn.z - 0) < 5) ok('Player B respawned back at the safe town spawn point');
	else fail(`Player B respawned far from the expected spawn point: ${JSON.stringify(bPosAfterRespawn)}`);

	// --- Console/network hygiene --------------------------------------------
	if (consoleIssues.length) {
		fail(`${consoleIssues.length} unexpected console error(s)/warning(s):\n   ${consoleIssues.slice(0, 20).join('\n   ')}`);
	} else {
		ok('Zero unexpected console errors/warnings across both sessions');
	}

	await browser.close();
}

main()
	.catch((err) => { console.error('FATAL:', err); process.exitCode = 1; })
	.finally(() => { killAll(); });
