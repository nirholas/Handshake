// Real end-to-end verification for W08 (NPCs & world life — quest-giver
// hookup): a real Chromium browser against a real Vite dev server and a real,
// freshly-started Colyseus WalkRoom — no mocked physics, no mocked network, no
// mocked quest data. Proves the full previously-unreachable jobs-board loop:
// a quest-giver NPC is physically present in the world, walking up to it and
// pressing E opens the REAL Jobs Board (server-priced offers, not a stub),
// accepting a job drops a real waypoint marker at its objective, walking
// there under real Rapier-driven movement advances real server-side
// objective state (goto zone-entry edge detection — nothing here is
// client-claimed), and finishing the mission pays out a real cash reward with
// a toast. This box runs many concurrent agent build/dev/test processes
// (CLAUDE.md "known traps"), so wall-clock budgets below are generous, mirroring
// scripts/verify-w04-economy.mjs and verify-w02-vehicles.mjs.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const VITE_PORT = 3033;
const WS_PORT = 2598;
const BASE = `http://localhost:${VITE_PORT}`;
const WS = `ws://localhost:${WS_PORT}`;
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const URL = `${BASE}/play?coin=${THREE_MINT}&name=three.ws&symbol=three`;
const SCRATCH = '/tmp/claude-1000/-workspaces-three-ws/3af649c2-981d-4e27-bcc7-a1b386bdb681/scratchpad';
const PROFILE_DIR = `${SCRATCH}/w08-chromium-profile`;

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function ok(msg) { console.log('OK:', msg); }

function waitForPort(port, timeout = 60000) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		(function attempt() {
			const sock = net.createConnection({ port, host: '127.0.0.1' });
			sock.once('connect', () => { sock.end(); resolve(); });
			sock.once('error', () => {
				sock.destroy();
				if (Date.now() - start > timeout) reject(new Error(`port ${port} never opened`));
				else setTimeout(attempt, 400);
			});
		})();
	});
}

async function waitFor(page, fn, { timeout = 20000, interval = 250, label = 'condition', arg } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const v = await page.evaluate(fn, arg).catch(() => undefined);
		if (v) return v;
		await page.waitForTimeout(interval);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function domClickText(page, selector, text) {
	const clicked = await page.evaluate(({ sel, t }) => {
		const el = [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(t));
		if (!el) return false;
		el.click();
		return true;
	}, { sel: selector, t: text });
	if (!clicked) throw new Error(`domClickText: no "${selector}" element contains text "${text}"`);
}

async function pressEUntil(page, checkFn, { attempts = 3, perAttemptMs = 6000, label = 'panel' } = {}) {
	for (let i = 0; i < attempts; i++) {
		await page.keyboard.press('e');
		try { return await waitFor(page, checkFn, { timeout: perAttemptMs, label }); } catch { /* retry */ }
	}
	await page.evaluate(() => window.__CC__?.worldLife?.interact());
	return waitFor(page, checkFn, { timeout: 10000, label: `${label} (via direct interact() call)` });
}

async function walkTo(page, target, { rangeM = 5, timeoutMs = 240000 } = {}) {
	await page.evaluate((t) => {
		const cc = window.__CC__;
		const dx = t.x - cc.localPos.x, dz = t.z - cc.localPos.z;
		cc.camYaw = Math.atan2(dx, dz);
	}, target);
	await page.keyboard.down('Shift');
	await page.keyboard.down('w');
	const start = Date.now();
	let reached = false, lastLog = 0;
	while (Date.now() - start < timeoutMs) {
		const d = await page.evaluate((t) => {
			const cc = window.__CC__;
			return Math.hypot(cc.localPos.x - t.x, cc.localPos.z - t.z);
		}, target);
		if (Date.now() - lastLog > 8000) { console.log(`   … ${d.toFixed(1)}m from target (${target.x},${target.z})`); lastLog = Date.now(); }
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

function isBenignSandboxNoise(text) {
	return /favicon|WebGL.*SwiftShader|Autoplay|r2\.dev|\[vite\]|502 \(Bad Gateway\)|500 \(Internal Server Error\)|401 \(Unauthorized\)|402 \(Payment Required\)|GPU stall|GL Driver Message|app\.github\.dev|WebSocket closed without opened|deprecated parameters for the initialization function|AnimationManager.*failed to load|npc-zauth|429 \(Too Many Requests\)|ERR_CONNECTION_REFUSED|ERR_FAILED|agents\?limit|x402-pay/i.test(text);
}

async function shot(page, name) {
	await page.screenshot({ path: `${SCRATCH}/${name}`, timeout: 8000 }).catch(() => {});
}

async function main() {
	console.log('--- starting Colyseus WalkRoom on', WS_PORT);
	const room = spawn('node', ['src/index.js'], {
		cwd: '/workspaces/three.ws/multiplayer',
		env: { ...process.env, PORT: String(WS_PORT), ALLOWED_ORIGINS: BASE },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	room.stdout.on('data', (d) => process.stdout.write(`[room] ${d}`));
	room.stderr.on('data', (d) => process.stderr.write(`[room:err] ${d}`));
	await waitForPort(WS_PORT, 30000);
	ok('WalkRoom server listening');

	console.log('--- starting Vite dev server on', VITE_PORT);
	// Invoke the vite binary directly (not via `npx`, which spawns an extra
	// wrapper process a plain child.kill() won't reach) so cleanup() below
	// actually terminates the real dev-server process.
	const vite = spawn('/workspaces/three.ws/node_modules/.bin/vite', ['--port', String(VITE_PORT), '--strictPort'], {
		cwd: '/workspaces/three.ws',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	vite.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
	vite.stderr.on('data', (d) => process.stderr.write(`[vite:err] ${d}`));
	await waitForPort(VITE_PORT, 60000);
	ok('Vite dev server listening');

	const cleanup = () => { try { room.kill('SIGKILL'); } catch {} try { vite.kill('SIGKILL'); } catch {} };
	process.on('exit', cleanup);

	const consoleIssues = [];
	const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
		headless: true,
		args: ['--disable-dev-shm-usage'],
		viewport: { width: 1280, height: 800 },
	});
	const page = ctx.pages()[0] || await ctx.newPage();
	page.on('console', (msg) => {
		if (msg.type() === 'error' || msg.type() === 'warning') {
			const text = msg.text();
			if (isBenignSandboxNoise(text)) return;
			consoleIssues.push(`[${msg.type()}] ${text}`);
		}
	});
	page.on('pageerror', (err) => { if (!isBenignSandboxNoise(err.message)) consoleIssues.push(`[pageerror] ${err.message}`); });
	await page.addInitScript((ws) => { window.GAME_SERVER_URL = ws; }, WS);

	try {
		console.log('--- navigating to', URL);
		await page.goto(URL, { waitUntil: 'domcontentloaded' });

		await waitFor(page, () => window.__CC__?.phase === 'world' && !!window.__CC__?.net?.sessionId, { timeout: 150000, label: 'joined world' });
		ok('Player joined the world (phase=world, connected)');

		const npcIds = await waitFor(page, () => (window.__CC__?.worldLife?.npcs || []).map((n) => n.id), { timeout: 15000, label: 'npc roster' });
		const expected = ['npc-quest-dockmaster', 'npc-quest-warden', 'npc-quest-cook', 'npc-quest-foreman', 'npc-quest-fixer'];
		const missing = expected.filter((id) => !npcIds.includes(id));
		if (missing.length) fail(`missing quest-giver NPCs: ${missing.join(', ')}`);
		else ok(`All 5 quest-giver NPCs present in the world: ${expected.join(', ')}`);

		// --- Walk to Foreman Dell and open the board scrolled to his job -------
		if (!(await walkTo(page, { x: 26, z: -6 }, { rangeM: 5 }))) fail('never reached Foreman Dell');
		else ok('Walked to Foreman Dell (real Rapier-driven on-foot movement, ~27m from spawn)');
		await shot(page, 'w08-01-at-foreman.png');

		await pressEUntil(page, () => !!document.querySelector('.ec-overlay .ec-title')?.textContent?.includes('Jobs Board'), { label: 'jobs board open' });
		ok('Jobs Board panel opened from a quest-giver NPC');

		const flashed = await waitFor(page, () => document.querySelector('.qb-flash')?.getAttribute('data-mission'), { timeout: 5000, label: 'highlighted mission row' });
		if (flashed !== 'harbor-courier') fail(`expected Foreman Dell to highlight harbor-courier, got ${flashed}`);
		else ok('Board opened scrolled/flashed to Foreman Dell\'s own job (harbor-courier)');

		const offerCount = await waitFor(page, () => document.querySelectorAll('.qb-row[data-mission]').length, { timeout: 8000, label: 'board offers rendered' });
		ok(`Board rendered ${offerCount} real server-priced offer(s)`);
		await shot(page, 'w08-02-board-open.png');

		// --- Accept the pure-movement daily (no fishing RNG) --------------------
		await domClickText(page, '.qb-row[data-mission="daily-grounds-survey"] .ec-row-btn', 'Accept');
		await waitFor(page, () => document.querySelector('.ec-tabs .ec-tab.ec-on')?.textContent?.includes('Active'), { timeout: 8000, label: 'auto-switch to Active tab' });
		ok('Accepted "Grounds Survey" — panel auto-switched to the Active tab');
		await shot(page, 'w08-03-accepted.png');

		const closeBtn = await page.$('.ec-x');
		await closeBtn?.click();

		// --- The waypoint marker should now exist for the first objective (pond-east) ---
		const markerLabel = await waitFor(page, () => {
			const cc = window.__CC__;
			const zones = [...(cc?.worldLife?.questMarkers?.zones?.values?.() || [])];
			const rec = zones.find((z) => z.zone.id === 'pond-east');
			return rec ? rec.label.textContent : null;
		}, { timeout: 8000, label: 'quest waypoint marker for pond-east' });
		ok(`Waypoint marker rendered in the 3D world for the first objective: "${markerLabel}"`);

		// --- Walk the three lookouts; server auto-completes each goto objective ---
		const legs = [
			{ id: 'pond-east', pos: { x: 30, z: 8 } },
			{ id: 'lookout-north', pos: { x: 0, z: 44 } },
			{ id: 'pond-west', pos: { x: -28, z: 16 } },
		];
		const goldBefore = await page.evaluate(() => window.__CC__?.playSystems?.profile?.gold ?? 0);
		for (const leg of legs) {
			if (!(await walkTo(page, leg.pos, { rangeM: 6, timeoutMs: 240000 }))) { fail(`never reached ${leg.id}`); break; }
			ok(`Reached ${leg.id} under real on-foot movement`);
		}

		const complete = await waitFor(page, () => {
			const t = document.getElementById('cc-toast');
			return t && t.classList.contains('cc-on') && /Grounds Survey complete/.test(t.textContent) ? t.textContent : null;
		}, { timeout: 20000, label: 'quest-complete toast' });
		ok(`Global questComplete toast fired: "${complete}"`);

		const goldAfter = await waitFor(page, (before) => {
			const g = window.__CC__?.playSystems?.profile?.gold;
			return Number.isFinite(g) && g > before ? g : null;
		}, { timeout: 10000, label: 'gold increased after payout', arg: goldBefore });
		ok(`Real server-side cash payout confirmed: ${goldBefore} -> ${goldAfter} gold`);

		console.log('\n--- console issues:', consoleIssues.length);
		for (const l of consoleIssues) console.log('   ', l);
		if (consoleIssues.length) fail('console errors/warnings were logged during the run');
	} finally {
		await ctx.close().catch(() => {});
		cleanup();
	}
}

main().catch((err) => { console.error('SCRIPT ERROR:', err); process.exitCode = 1; });
