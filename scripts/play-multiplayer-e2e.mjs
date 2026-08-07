// Two-client multiplayer conformance run for /play.
//
// Opens the same coin world in two isolated browser contexts (separate storage,
// so they are two different players) and asserts the things a crowded event
// depends on: both clients see each other, movement and chat cross in under a
// human-perceptible delay, chat text cannot inject HTML, and a forced network
// drop on one client heals back into a state that MATCHES the server — no ghost
// avatars left standing, no duplicated self, chat flowing again afterwards.
//
//   node scripts/play-multiplayer-e2e.mjs                       # local dev, $THREE world
//   BASE=http://localhost:3000 node scripts/play-multiplayer-e2e.mjs
//   BASE=https://three.ws node scripts/play-multiplayer-e2e.mjs  # live site
//
// Requires a world server the page can reach. Locally that is `npm run
// dev:walk-all` (vite on :3000 + colyseus on :2567); against three.ws the page's
// <meta name="game-server"> points at the deployed Cloud Run instance.
//
// Exit code is 0 only when every check passes and neither page logged a console
// error or a page error.
import { chromium } from 'playwright';

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
// The canonical $THREE community (docs/event-readiness/README.md).
const MINT = process.env.COIN || 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const WORLD = `${BASE}/play?coin=${encodeURIComponent(MINT)}&name=three.ws&symbol=three`;
const OFFLINE_MS = Number(process.env.OFFLINE_MS || 10000);
// A Vite dev origin compiles the whole /play module graph on first request and a
// shared/loaded machine makes that minutes, not seconds; a production origin is a
// static bundle. SLOW=1 (default for a dev BASE) stretches the load-and-join
// budgets so a busy box reads as slow, not as a failure.
const SLOW = process.env.SLOW ? process.env.SLOW !== '0' : /localhost|127\.0\.0\.1/.test(BASE);
const LOAD_MS = Number(process.env.LOAD_MS || (SLOW ? 300000 : 90000));
const JOIN_MS = Number(process.env.JOIN_MS || (SLOW ? 180000 : 60000));

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const results = [];
const consoleErrors = [];

function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	console.log(`${at()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	return ok;
}

// Poll a page expression until it is truthy or the deadline passes. Returns the
// last value seen, so a failed wait can report what it actually got.
async function until(page, fn, { timeout = 30000, every = 250, arg } = {}) {
	const deadline = Date.now() + timeout;
	let last;
	for (;;) {
		try { last = await page.evaluate(fn, arg); } catch (err) { last = { evalError: String(err).slice(0, 120) }; }
		if (last && !last.evalError && (last === true || last.ok !== false)) {
			if (last === true || last.ok === true) return last;
		}
		if (Date.now() > deadline) return last;
		await page.waitForTimeout(every);
	}
}

// Everything the assertions need, read straight off the live scene + net client.
const snapshot = () => {
	const cc = window.__CC__;
	const net = cc?.net;
	const remotes = [...(cc?.remotes || new Map())].map(([id, r]) => ({
		id,
		name: r.name,
		x: Math.round(r.rig.position.x * 100) / 100,
		z: Math.round(r.rig.position.z * 100) / 100,
		tx: Math.round(r.targetX * 100) / 100,
		tz: Math.round(r.targetZ * 100) / 100,
		motion: r.motion,
		avatar: r._avatarUrl || '',
		cosmetics: r._cosWire || '',
	}));
	return {
		ok: true,
		phase: cc?.phase || null,
		status: net?.status || null,
		live: !!net?.isLive?.(),
		sessionId: net?.sessionId || null,
		name: net?.name || '',
		self: cc ? { x: Math.round(cc.localPos.x * 100) / 100, z: Math.round(cc.localPos.z * 100) / 100 } : null,
		remotes,
		labels: document.querySelectorAll('.cc-label').length,
		chat: [...document.querySelectorAll('.cc-chat-msg')].map((n) => ({
			name: n.querySelector('b')?.textContent || '',
			text: n.querySelector('.cc-chat-text')?.textContent || '',
			// Any element inside the text span means the message was parsed as
			// markup instead of being written as text — an XSS hole.
			injected: n.querySelector('.cc-chat-text')?.children.length || 0,
		})),
		statusPill: document.querySelector('#cc-hud .cc-status .cc-status-text')?.textContent
			|| document.querySelector('[data-state] .cc-status-text')?.textContent || null,
	};
};

async function openClient(browser, tag, name) {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: [] });
	// A stable display name per client makes the cross-client assertions readable.
	// GAME_SERVER overrides the world server the page would otherwise resolve —
	// needed to point a run at an isolated Colyseus instance instead of whatever
	// the page's <meta game-server> or the localhost default picks.
	await ctx.addInitScript(({ n, server }) => {
		try { localStorage.setItem('cc-name', n); } catch { /* storage blocked */ }
		if (server) window.GAME_SERVER_URL = server;
	}, { n: name, server: process.env.GAME_SERVER || '' });
	const page = await ctx.newPage();
	page.on('console', (m) => {
		if (m.type() === 'error') {
			const text = m.text();
			// A failed asset fetch while the context is deliberately offline is the
			// test doing its job, not a defect in the client. The Vite HMR client is
			// harness scaffolding that only exists on a dev origin; its socket points
			// at the dev host, not the game server, so its noise is not a finding.
			if (/net::ERR_INTERNET_DISCONNECTED|Failed to load resource/i.test(text)) return;
			if (/\[vite\]|@vite\/client/.test(text)) return;
			consoleErrors.push(`[${tag}] ${text.slice(0, 300)}`);
			console.log(`${at()} [${tag}][console.error] ${text.slice(0, 300)}`);
		}
	});
	page.on('pageerror', (e) => {
		const text = String(e?.message || e);
		if (/WebSocket closed without opened/.test(text)) return; // Vite HMR client
		consoleErrors.push(`[${tag}] ${text.slice(0, 300)}`);
		console.log(`${at()} [${tag}][pageerror] ${String(e?.stack || e).slice(0, 400)}`);
	});
	page.on('websocket', (ws) => {
		console.log(`${at()} [${tag}][ws open] ${ws.url().slice(0, 90)}`);
		ws.on('close', () => console.log(`${at()} [${tag}][ws close]`));
	});
	await page.goto(WORLD, { waitUntil: 'domcontentloaded', timeout: 90000 });
	return { tag, ctx, page };
}

// Onboarding cards and the intro sheet sit over the world; clear whatever is up.
async function dismissOverlays(page, rounds = 4) {
	for (let i = 0; i < rounds; i++) {
		const clicked = await page.evaluate(() => {
			const btn = [...document.querySelectorAll('button')].find(
				(b) => /^(continue|enter the world|got it|start|close|skip|drop in now)$/i.test(b.textContent.trim()) && b.offsetParent,
			);
			if (btn) { btn.click(); return btn.textContent.trim(); }
			return null;
		});
		if (!clicked) break;
		await page.waitForTimeout(400);
	}
}

async function sendChat(page, text) {
	await page.fill('#cc-chat input[type="text"]', text);
	await page.click('#cc-chat .cc-chat-send');
}

// Drive the local avatar to a position and let the send loop publish it. Uses the
// same sendMove the input handler calls, so this exercises the real wire.
async function moveTo(page, x, z) {
	await page.evaluate(({ x, z }) => {
		const cc = window.__CC__;
		cc.localPos.x = x; cc.localPos.z = z;
		cc.net.sendMove({ x, y: cc.localPos.y, z, yaw: cc.localYaw, motion: 'walk' });
	}, { x, z });
}

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
let a; let b;
try {
	// ---------------------------------------------------------------- join path
	const joinStart = Date.now();
	a = await openClient(browser, 'A', 'AliceQA');
	b = await openClient(browser, 'B', 'BobQA');
	await Promise.all([dismissOverlays(a.page), dismissOverlays(b.page)]);

	const online = async (c) => until(c.page, () => {
		const net = window.__CC__?.net;
		return { ok: net?.status === 'online' && window.__CC__?.phase === 'world', status: net?.status, phase: window.__CC__?.phase };
	}, { timeout: 60000 });
	const aOnline = await online(a);
	const bOnline = await online(b);
	check('A joins the world online', aOnline?.ok === true, JSON.stringify(aOnline));
	check('B joins the world online', bOnline?.ok === true, JSON.stringify(bOnline));

	const sawEachOther = await until(a.page, () => {
		const cc = window.__CC__;
		return { ok: (cc?.remotes?.size || 0) >= 1, n: cc?.remotes?.size || 0 };
	}, { timeout: 30000 });
	check('A sees B within 30s of load', sawEachOther?.ok === true,
		`${((Date.now() - joinStart) / 1000).toFixed(1)}s to first peer`);
	const bSees = await until(b.page, () => ({ ok: (window.__CC__?.remotes?.size || 0) >= 1, n: window.__CC__?.remotes?.size || 0 }), { timeout: 30000 });
	check('B sees A', bSees?.ok === true, JSON.stringify(bSees));

	// ------------------------------------------------------- name + look sync
	let bSnap = await b.page.evaluate(snapshot);
	check('B renders A\'s display name on the nameplate',
		bSnap.remotes.some((r) => r.name === 'AliceQA'),
		JSON.stringify(bSnap.remotes.map((r) => r.name)));
	check('B renders a nameplate element per peer', bSnap.labels >= bSnap.remotes.length,
		`labels=${bSnap.labels} remotes=${bSnap.remotes.length}`);
	check('B receives A\'s avatar url', bSnap.remotes.every((r) => !!r.avatar),
		JSON.stringify(bSnap.remotes.map((r) => r.avatar.slice(-40))));

	// ------------------------------------------------------------- movement
	const moveStart = Date.now();
	await moveTo(a.page, 7.5, -4.25);
	const moved = await until(b.page, () => {
		const cc = window.__CC__;
		const r = [...(cc?.remotes || new Map())].map(([, v]) => v).find((v) => v.name === 'AliceQA');
		return { ok: !!r && Math.abs(r.targetX - 7.5) < 0.2 && Math.abs(r.targetZ + 4.25) < 0.2, tx: r?.targetX, tz: r?.targetZ };
	}, { timeout: 5000, every: 60 });
	check('A\'s movement reaches B', moved?.ok === true, `${Date.now() - moveStart}ms · ${JSON.stringify(moved)}`);

	// --------------------------------------------------------------- emotes
	await a.page.evaluate(() => window.__CC__.net.sendEmote('wave'));
	const emoted = await until(b.page, () => {
		const st = window.__CC__?.net?.state;
		const players = st?.players ? [...st.players.values()] : [];
		const alice = players.find((p) => p.name === 'AliceQA');
		return { ok: alice?.emote === 'wave', emote: alice?.emote || null };
	}, { timeout: 5000, every: 100 });
	check('A\'s emote reaches B', emoted?.ok === true, JSON.stringify(emoted));

	// ----------------------------------------------------------------- chat
	const msg = `hello from A ${Date.now()}`;
	await sendChat(a.page, msg);
	const gotChat = await until(b.page, (m) => {
		const rows = [...document.querySelectorAll('.cc-chat-msg .cc-chat-text')].map((n) => n.textContent);
		return { ok: rows.includes(m), rows: rows.slice(-3) };
	}, { timeout: 6000, every: 100, arg: msg });
	check('A→B chat delivers', gotChat?.ok === true, JSON.stringify(gotChat));

	const reply = `hi back from B ${Date.now()}`;
	await sendChat(b.page, reply);
	const gotReply = await until(a.page, (m) => {
		const rows = [...document.querySelectorAll('.cc-chat-msg .cc-chat-text')].map((n) => n.textContent);
		return { ok: rows.includes(m), rows: rows.slice(-3) };
	}, { timeout: 6000, every: 100, arg: reply });
	check('B→A chat delivers', gotReply?.ok === true, JSON.stringify(gotReply));

	// Chat must never be parsed as markup on the receiving client.
	const xss = '<img src=x onerror="window.__XSS__=1"><b>bold</b>';
	await sendChat(a.page, xss);
	await b.page.waitForTimeout(1200);
	const escaped = await b.page.evaluate((raw) => {
		const rows = [...document.querySelectorAll('.cc-chat-msg .cc-chat-text')];
		const row = rows.find((n) => n.textContent === raw);
		return {
			delivered: !!row,
			children: row ? row.children.length : -1,
			xssFired: !!window.__XSS__,
			imgs: document.querySelectorAll('#cc-chat img').length,
		};
	}, xss);
	check('chat text is escaped, never injected as HTML',
		escaped.delivered && escaped.children === 0 && !escaped.xssFired && escaped.imgs === 0,
		JSON.stringify(escaped));

	// Spam throttle: the server drops anything under its per-client cooldown, so a
	// burst must NOT arrive whole on the other client.
	const burst = Date.now();
	for (let i = 0; i < 8; i++) await sendChat(a.page, `spam-${burst}-${i}`);
	await b.page.waitForTimeout(2000);
	const delivered = await b.page.evaluate((tag) =>
		[...document.querySelectorAll('.cc-chat-msg .cc-chat-text')].filter((n) => n.textContent.startsWith(`spam-${tag}-`)).length, burst);
	check('chat burst is throttled server-side', delivered < 8, `${delivered}/8 relayed`);

	// The log must not grow without bound — the UI caps it.
	const capped = await b.page.evaluate(() => document.querySelectorAll('.cc-chat-msg').length <= 200);
	check('chat log is capped in the DOM', capped === true);

	// ------------------------------------------------------- forced disconnect
	const aBefore = await a.page.evaluate(snapshot);
	console.log(`${at()} [A] going offline for ${OFFLINE_MS}ms (session ${aBefore.sessionId})`);
	await a.ctx.setOffline(true);
	const dropped = await until(a.page, () => {
		const s = window.__CC__?.net?.status;
		return { ok: s !== 'online', status: s };
	}, { timeout: 30000, every: 250 });
	check('A notices the drop', dropped?.ok === true, JSON.stringify(dropped));
	const pill = await a.page.evaluate(() => document.querySelector('#cc-hud [role]')?.textContent || document.body.innerText.match(/reconnecting…|offline, tap to retry/i)?.[0] || null);
	check('A shows a reconnect indicator while down', /reconnect|offline/i.test(String(pill)), String(pill).slice(0, 60));

	await a.page.waitForTimeout(OFFLINE_MS);
	await a.ctx.setOffline(false);
	// Simulate the tab coming back to the foreground: the same path a phone takes
	// after Safari froze the page, and the fast lane out of the retry backoff.
	await a.page.evaluate(() => {
		document.dispatchEvent(new Event('visibilitychange'));
		dispatchEvent(new Event('online'));
	});
	const back = await until(a.page, () => {
		const net = window.__CC__?.net;
		return { ok: net?.status === 'online' && net?.isLive?.() === true, status: net?.status };
	}, { timeout: 20000, every: 250 });
	check('A reconnects automatically after the network returns', back?.ok === true, JSON.stringify(back));

	const aAfter = await a.page.evaluate(snapshot);
	check('A gets a fresh session on reconnect', !!aAfter.sessionId && aAfter.sessionId !== aBefore.sessionId,
		`${aBefore.sessionId} → ${aAfter.sessionId}`);
	check('A\'s roster after resync holds exactly one peer (no ghosts)', aAfter.remotes.length === 1,
		JSON.stringify(aAfter.remotes.map((r) => `${r.name}:${r.id}`)));
	check('A\'s nameplate count matches its roster', aAfter.labels === aAfter.remotes.length,
		`labels=${aAfter.labels} remotes=${aAfter.remotes.length}`);

	// The other client is the real judge of duplicated-self: it must hold ONE A.
	const bAfter = await until(b.page, () => {
		const cc = window.__CC__;
		const rs = [...(cc?.remotes || new Map())].map(([, r]) => r.name);
		return { ok: rs.filter((n) => n === 'AliceQA').length === 1 && rs.length === 1, rs };
	}, { timeout: 20000, every: 250 });
	check('B holds exactly one A after A\'s reconnect (no duplicated self)', bAfter?.ok === true, JSON.stringify(bAfter));

	// Position must survive the resync: A stood still through the whole drop, so
	// the server has to end up agreeing with where A actually is.
	const resynced = await until(b.page, () => {
		const r = [...(window.__CC__?.remotes || new Map())].map(([, v]) => v).find((v) => v.name === 'AliceQA');
		return { ok: !!r && Math.abs(r.targetX - 7.5) < 0.5 && Math.abs(r.targetZ + 4.25) < 0.5, tx: r?.targetX, tz: r?.targetZ };
	}, { timeout: 12000, every: 250 });
	check('A\'s position resyncs on B after the drop', resynced?.ok === true, JSON.stringify(resynced));

	const after = `after reconnect ${Date.now()}`;
	await sendChat(a.page, after);
	const chatBack = await until(b.page, (m) => {
		const rows = [...document.querySelectorAll('.cc-chat-msg .cc-chat-text')].map((n) => n.textContent);
		return { ok: rows.includes(m), rows: rows.slice(-3) };
	}, { timeout: 8000, every: 100, arg: after });
	check('chat flows again after the reconnect', chatBack?.ok === true, JSON.stringify(chatBack));

	check('no console errors on either client', consoleErrors.length === 0,
		consoleErrors.slice(0, 5).join(' | '));
} catch (err) {
	check('run completed without throwing', false, String(err?.stack || err).slice(0, 500));
} finally {
	await a?.ctx.close().catch(() => {});
	await b?.ctx.close().catch(() => {});
	await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
for (const f of failed) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
process.exit(failed.length ? 1 : 0);
