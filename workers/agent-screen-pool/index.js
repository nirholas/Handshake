// agent-screen-pool — on-demand live browser caster for the agent wall.
//
// The problem: users want a live browser feed for ANY agent, 24/7, all of them.
// Running one Chromium per agent forever is economically impossible. So instead
// of casting every agent always, this worker casts exactly the agents people are
// *currently watching*:
//
//   1. Viewers on /agents-live (and any watch panel) POST /api/agent/watch-intent
//      for the agents on their screen.
//   2. This worker polls /api/agent/watch-wanted to read that set.
//   3. It maintains a bounded pool of real Chromium pages — one per wanted agent,
//      up to MAX_BROWSERS — screenshotting each and pushing frames to
//      /api/agent-screen-push (which the wall + watch panel render live).
//   4. When nobody is watching an agent, its page is torn down and the slot frees
//      up for another. The wall's zero-cost activity view takes over seamlessly.
//
// Cost scales with concurrent viewers, not with the number of agents. Deploy one
// of these anywhere a long-running Node process can live (a small VM, Fly.io,
// Railway, or the bundled GitHub Actions workflow for bursts).
//
// Required env:
//   SCREEN_WORKER_SECRET   shared secret; must match the value set on the API.
// Optional env (sensible defaults for production three.ws):
//   BASE_URL=https://three.ws
//   WANTED_URL=$BASE_URL/api/agent/watch-wanted
//   PUSH_URL=$BASE_URL/api/agent-screen-push
//   MAX_BROWSERS=6   POLL_MS=3000   FRAME_MS=700   JPEG_QUALITY=58
//   VIEWPORT_W=1280  VIEWPORT_H=720

import { chromium } from 'playwright';
import { pickTask } from './tasks/index.js';
import { generateNarration, runTaskSteps } from './task-runner.js';
import { applyEvents } from './control.js';

const BASE_URL   = (process.env.BASE_URL || 'https://three.ws').replace(/\/$/, '');
const WANTED_URL = process.env.WANTED_URL || `${BASE_URL}/api/agent/watch-wanted`;
// Single frame convention: the live wall, 2D watch panel, AND the in-world 3D
// desk all read /api/agent-screen-push frames via /api/agent-screen-stream.
const PUSH_URL = process.env.PUSH_URL || `${BASE_URL}/api/agent-screen-push`;
// Reverse channel: the owner drives the cast browser. This worker drains queued
// input events (and the manual-mode flag) for every agent it is casting, then
// dispatches them into the live page. Polled fast so control feels responsive.
const CONTROL_URL     = process.env.CONTROL_URL || `${BASE_URL}/api/agent-screen-control-drain`;
const CONTROL_POLL_MS = Number(process.env.CONTROL_POLL_MS || 250);
// How long after the last manual signal the autonomous task stays paused. Long
// enough to bridge poll gaps and idle holds; short enough that the bot resumes
// promptly once the human lets go.
const MANUAL_HOLD_MS  = Number(process.env.MANUAL_HOLD_MS || 2500);
const SECRET   = process.env.SCREEN_WORKER_SECRET || '';

// Hard cap on concurrent Chromium casters. The API's /api/agent/watch-status
// reports queue position against SCREEN_POOL_MAX (same default, 6) — keep the two
// in sync per deploy so a viewer's "queued · #N in line" matches reality: the
// worker casts the first MAX_BROWSERS wanted agents, the API queues the rest.
const MAX_BROWSERS = Number(process.env.MAX_BROWSERS || 6);
const POLL_MS      = Number(process.env.POLL_MS || 3000);
const FRAME_MS     = Number(process.env.FRAME_MS || 700);
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY || 58);
const LEAD_MS      = Number(process.env.LEAD_MS || 900);   // how long narration leads the action
const DWELL_MS     = Number(process.env.DWELL_MS || 6000); // hold on the result between task runs
const VIEWPORT     = { width: Number(process.env.VIEWPORT_W || 1280), height: Number(process.env.VIEWPORT_H || 720) };

// Coin World Tour config. When a cast page exposes window.__tour, the worker walks
// the guide through the waypoint loop, dwelling at each stop and narrating the
// platform's OWN launch feed (coins launched THROUGH three.ws). Cached so a fleet
// of concurrent tours doesn't hammer it.
//
// Coin rule: the source is /api/pump/launches (the three.ws launch directory over
// pump_agent_mints — the blessed launch-records exception), NOT a global market /
// trending feed. The guide narrates what's climbing OUR launch feed, factually.
const TOUR_DWELL_MS      = Number(process.env.TOUR_DWELL_MS || 6500);   // pause per waypoint
const TOUR_READY_MS      = Number(process.env.TOUR_READY_MS || 30_000); // max wait for scene-ready
const LAUNCH_FEED_URL    = process.env.LAUNCH_FEED_URL || `${BASE_URL}/api/pump/launches?limit=8`;
const LAUNCH_FEED_TTL_MS = Number(process.env.LAUNCH_FEED_TTL_MS || 20_000);
let _launchFeed = { at: 0, data: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// three.ws launch feed, cached ~20s and shared across every concurrent tour.
// Returns [] on any failure so commentary degrades to world-only narration.
async function getLaunchFeed() {
	if (Date.now() - _launchFeed.at < LAUNCH_FEED_TTL_MS) return _launchFeed.data;
	try {
		const res = await fetch(LAUNCH_FEED_URL, { headers: { accept: 'application/json' } });
		if (!res.ok) { _launchFeed = { at: Date.now(), data: [] }; return []; }
		const body = await res.json();
		const data = Array.isArray(body?.data?.launches) ? body.data.launches : [];
		_launchFeed = { at: Date.now(), data };
		return data;
	} catch {
		_launchFeed = { at: Date.now(), data: [] };
		return [];
	}
}

// Push a text-only commentary line (type:'analysis') to the wall + watch panel.
async function pushAnalysis(entry, line) {
	if (!line) return;
	try {
		await fetch(PUSH_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
			body: JSON.stringify({ agentId: entry.agentId, frame: { activity: String(line).slice(0, 300), type: 'analysis' } }),
		});
	} catch { /* a dropped commentary line never breaks the tour */ }
}

if (!SECRET || SECRET.length < 16) {
	console.error('[pool] SCREEN_WORKER_SECRET is required (>= 16 chars) and must match the API. Exiting.');
	process.exit(1);
}

const log = (...a) => console.log(`[pool ${new Date().toISOString()}]`, ...a);

// agentId → { page, timer, name, pushing, lastErrorAt }
const pool = new Map();
let browser = null;
let context = null;
let stopping = false;

async function ensureBrowser() {
	if (browser) return;
	browser = await chromium.launch({
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
	});
	context = await browser.newContext({
		viewport: VIEWPORT,
		userAgent:
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		locale: 'en-US',
	});
	log('chromium launched');
}

async function fetchWanted() {
	try {
		const res = await fetch(WANTED_URL, { headers: { authorization: `Bearer ${SECRET}` } });
		if (!res.ok) { log('watch-wanted', res.status); return []; }
		const data = await res.json();
		if (data.disabled) { log('pool disabled by API:', data.reason); return []; }
		return Array.isArray(data.agents) ? data.agents : [];
	} catch (err) {
		log('watch-wanted error:', err?.message || err);
		return [];
	}
}

function resolveUrl(homeUrl, agentId) {
	const u = homeUrl || `/agent/${agentId}`;
	if (/^https?:\/\//.test(u)) return u;
	return `${BASE_URL}${u.startsWith('/') ? '' : '/'}${u}`;
}

// ── control channel: the owner takes the wheel ──────────────────────────────
// True while a human holds this agent's control lease (recently signalled by the
// drain endpoint). The autonomous task/tour loops check this and stand down so
// the two never fight over the cursor.
function isManual(entry) {
	return !!(entry && entry.manualUntil && entry.manualUntil > Date.now());
}

// Drain queued input events for every casting agent and dispatch them into the
// live page. Best-effort: a blip never interrupts casting. Re-entrancy guarded so
// a slow round can't stack on the next tick.
let controlPolling = false;
async function drainControl() {
	if (controlPolling || stopping || pool.size === 0) return;
	controlPolling = true;
	try {
		const ids = [...pool.keys()];
		const res = await fetch(CONTROL_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
			body: JSON.stringify({ agentIds: ids }),
		});
		if (!res.ok) return;
		const body = await res.json().catch(() => null);
		const agents = body?.agents || {};
		await Promise.all(ids.map(async (id) => {
			const entry = pool.get(id);
			if (!entry || !entry.page || entry.page.isClosed()) return;
			const info = agents[id];
			if (!info) return;
			const wasManual = isManual(entry);
			if (info.manual) entry.manualUntil = Date.now() + MANUAL_HOLD_MS;
			// Announce the handoff exactly once as control passes each way.
			if (info.manual && !wasManual) {
				await pushTaskFrame(entry, { activity: 'Owner took the wheel, driving live', type: 'activity' });
			}
			const events = Array.isArray(info.events) ? info.events : [];
			if (events.length) {
				const { changed } = await applyEvents(entry.page, events, VIEWPORT);
				if (changed) await pushTaskFrame(entry, {}); // land the result immediately
			} else if (isManual(entry)) {
				await pushTaskFrame(entry, {}); // held wheel, no new input: keep pixels live
			}
			if (!isManual(entry) && wasManual) {
				await pushTaskFrame(entry, { activity: 'Owner released the wheel, agent resumed', type: 'activity' });
			}
		}));
	} catch {
		/* control is best-effort; casting continues regardless */
	} finally {
		controlPolling = false;
	}
}

async function pushFrame(entry) {
	if (entry.pushing || !entry.page || entry.page.isClosed()) return;
	entry.pushing = true;
	try {
		const buf = await entry.page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, fullPage: false });
		const b64 = buf.toString('base64');
		const headers = { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` };
		const res = await fetch(PUSH_URL, {
			method: 'POST', headers,
			body: JSON.stringify({
				agentId: entry.agentId,
				// On a Coin World Tour the frame is stamped with the current waypoint
				// (entry.activityOverride, e.g. "Tour · Into the arena") so the wall +
				// watch panel light up the TOUR badge; otherwise it's the live view.
				frame: { data: `data:image/jpeg;base64,${b64}`, activity: entry.activityOverride || `Live view · ${entry.name}`, type: 'screenshot' },
			}),
		});
		if (!res.ok && Date.now() - (entry.lastErrorAt || 0) > 30_000) {
			entry.lastErrorAt = Date.now();
			log('push failed', entry.agentId, res.status, (await res.text().catch(() => '')).slice(0, 120));
		}
	} catch (err) {
		if (Date.now() - (entry.lastErrorAt || 0) > 30_000) {
			entry.lastErrorAt = Date.now();
			log('frame error', entry.agentId, err?.message || err);
		}
	} finally {
		entry.pushing = false;
	}
}

async function startCasting(agent) {
	await ensureBrowser();
	const agentId = agent.agentId;
	const page = await context.newPage();
	const entry = { agentId, page, name: agent.name || 'Agent', timer: null, pushing: false, lastErrorAt: 0, controller: new AbortController() };
	pool.set(agentId, entry);
	const url = resolveUrl(agent.homeUrl, agentId);
	try {
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
	} catch (err) {
		log('goto failed', agentId, err?.message || err);
	}
	await pushFrame(entry);

	// If the page is a walkable world exposing window.__tour, run the guided world
	// tour alongside the continuous frame capture (which streams the walkthrough).
	const isTour = await page.evaluate(() => !!(window.__tour && typeof window.__tour.goTo === 'function')).catch(() => false);
	if (isTour) {
		entry.timer = setInterval(() => pushFrame(entry), FRAME_MS);
		entry.tour = true;
		log('casting (tour)', agentId, agent.name, '→', url, `(${pool.size}/${MAX_BROWSERS})`);
		runTour(entry).catch((err) => log('tour error', agentId, err?.message || err));
		return;
	}

	// Otherwise run a real, multi-step web task on this page (the "watch an agent
	// do real web work" moment). The task loop is the sole frame writer here — no
	// continuous timer — so its narration and screenshots stay in step.
	log('casting (task)', agentId, agent.name, `(${pool.size}/${MAX_BROWSERS})`);
	runCastTask(entry).catch((err) => log('cast task crashed', agentId, err?.message || err));
}

// Walk a guide agent through the world's waypoint loop, narrating live trending
// data at each stop. Runs until the agent leaves the pool (nobody watching) or the
// worker shuts down. Drives the real camera/avatar via window.__tour — no faking.
async function runTour(entry) {
	const { page, agentId } = entry;
	// Wait for the scene to become walkable (bounded so a stuck load can't hang us).
	const ready = await page.evaluate((ms) => Promise.race([
		window.__tour.ready().then(() => true),
		new Promise((r) => setTimeout(() => r(false), ms)),
	]), TOUR_READY_MS).catch(() => false);
	if (!ready) { log('tour not ready', agentId); return; }

	const stops = await page.evaluate(() => window.__tour.waypoints()).catch(() => []);
	if (!Array.isArray(stops) || !stops.length) { log('tour: no waypoints', agentId); return; }

	let i = 0;
	while (!stopping && pool.has(agentId) && !page.isClosed()) {
		// Human has the wheel: pause the guided tour, the driver steers instead.
		if (isManual(entry)) { await sleep(600); continue; }
		const name = stops[i % stops.length];
		i++;
		try {
			await page.evaluate((n) => window.__tour.goTo(n), name);
			const launches = await getLaunchFeed();
			const c = await page.evaluate((t) => window.__tour.commentary(t), launches).catch(() => null);
			if (c) {
				entry.activityOverride = c.badge;      // stamps screenshot frames with the waypoint
				await pushAnalysis(entry, c.line);     // narrates the stop in the activity log
			}
		} catch (err) {
			if (page.isClosed()) break;
			log('tour step', agentId, err?.message || err);
		}
		await sleep(TOUR_DWELL_MS);
	}
	entry.activityOverride = null;
}

// ── task-driven web-work mode ──────────────────────────────────────────────────
//
// For an agent whose home page is NOT a walkable world, the caster runs a real,
// multi-step web task (see tasks/) instead of just screenshotting a static page:
// it navigates to a real public site, fills a real form, submits, waits for real
// results, and reads them back — narrating each action a beat before it happens
// and landing a screenshot after. This is the "watch an agent do real web work"
// moment. Single writer per page (this loop), so its pushes don't collide with the
// continuous-frame timer used by the tour/static path.

// Push one frame for the task path. A narration push carries activity text + a
// fresh shot; a pixels-only push (empty activity) keeps the stream live during
// typing/waits/dwell WITHOUT spamming the activity log (the API logs only frames
// that carry activity).
async function pushTaskFrame(entry, { activity = '', type = 'screenshot', shoot = true } = {}) {
	if (!entry.page || entry.page.isClosed()) return;
	let b64 = null;
	if (shoot) {
		try {
			const buf = await entry.page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, fullPage: false });
			b64 = buf.toString('base64');
		} catch { /* page navigating — push the narration line without pixels */ }
	}
	const dataUrl = b64 ? `data:image/jpeg;base64,${b64}` : null;
	const headers = { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` };
	try {
		const res = await fetch(PUSH_URL, {
			method: 'POST', headers,
			body: JSON.stringify({ agentId: entry.agentId, frame: { data: dataUrl, activity, type } }),
		});
		if (!res.ok && Date.now() - (entry.lastErrorAt || 0) > 30_000) {
			entry.lastErrorAt = Date.now();
			log('task push failed', entry.agentId, res.status, (await res.text().catch(() => '')).slice(0, 120));
		}
	} catch (err) {
		if (Date.now() - (entry.lastErrorAt || 0) > 30_000) {
			entry.lastErrorAt = Date.now();
			log('task push error', entry.agentId, err?.message || err);
		}
	}
}

// Keep pixels flowing through the slow parts of a task (typing, waiting, dwell),
// all as empty-activity frames so the log stays clean.
async function typeWithFrames(entry, selector, value) {
	const field = entry.page.locator(selector).first();
	await field.click({ timeout: 8_000 }).catch(() => {});
	await field.fill('').catch(() => {});
	let typed = 0;
	for (const ch of value) {
		if (entry.controller.signal.aborted) return;
		await field.pressSequentially(ch, { delay: 45 }).catch(() => {});
		typed++;
		if (typed % 2 === 0 || typed === value.length) await pushTaskFrame(entry, {});
	}
}

async function waitWithFrames(entry, selector, { timeout = 15_000, fallbackUrl = null } = {}) {
	const page = entry.page;
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (entry.controller.signal.aborted) return false;
		const visible = await page.locator(selector).first().isVisible().catch(() => false);
		await pushTaskFrame(entry, {});
		if (visible) return true;
		await sleep(FRAME_MS);
	}
	if (fallbackUrl && !entry.controller.signal.aborted) {
		await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
		await pushTaskFrame(entry, {});
		return await page.locator(selector).first().isVisible().catch(() => false);
	}
	return false;
}

async function dwellTask(entry, ms) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (entry.controller.signal.aborted || isManual(entry)) return; // yield to the driver
		await pushTaskFrame(entry, {});
		await sleep(FRAME_MS);
	}
}

async function readText(entry, step) {
	const loc = entry.page.locator(step.selector);
	if (step.multi) {
		const texts = (await loc.allInnerTexts().catch(() => []))
			.map((t) => t.replace(/\s+/g, ' ').trim())
			.filter(Boolean);
		return texts.slice(0, step.limit || 5).join('  ·  ');
	}
	const t = await loc.first().innerText({ timeout: 8_000 }).catch(() => '');
	return t.replace(/\s+/g, ' ').trim();
}

// The executor the sequencer (task-runner.js) drives: narrate → perform → shot.
// narrate() pushes the line + a shot, then lets it lead by LEAD_MS (no further
// pushes, so the narration frame is reliably delivered before the result lands —
// the "one beat ahead" feel that makes it look like thinking).
function makeExecutor(entry) {
	return {
		async narrate(line) {
			if (isManual(entry)) return; // human is driving, do not narrate over them
			await pushTaskFrame(entry, { activity: line, type: 'analysis' });
			const deadline = Date.now() + LEAD_MS;
			while (Date.now() < deadline && !entry.controller.signal.aborted && !isManual(entry)) await sleep(Math.min(LEAD_MS, 150));
		},
		async perform(step) {
			if (isManual(entry)) return null; // yield the page to the driver
			const page = entry.page;
			switch (step.kind) {
				case 'goto': await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); return null;
				case 'type': await typeWithFrames(entry, step.selector, step.value); return null;
				case 'submit': await page.locator(step.selector).first().press(step.key || 'Enter'); return null;
				case 'waitResult': await waitWithFrames(entry, step.selector, { timeout: 15_000, fallbackUrl: step.fallbackUrl }); return null;
				case 'read': return await readText(entry, step);
				default: return null;
			}
		},
		async shot(step, result) {
			if (step.kind === 'read' && result) {
				await pushTaskFrame(entry, { activity: `Found: ${String(result).slice(0, 200)}`, type: 'analysis' });
			} else {
				await pushTaskFrame(entry, {}); // pixels only — land the result, no log spam
			}
		},
		async fail(step, err) {
			await pushTaskFrame(entry, {
				activity: `${step.narration} — hit a snag (${(err?.message || 'error').slice(0, 60)}), recovering`,
				type: 'activity',
			});
		},
		async done(task) {
			await pushTaskFrame(entry, { activity: `Done — researched ${task.topic}`, type: 'analysis' });
		},
	};
}

// One agent's full lifetime as a task cast: pick its task, fetch its narration plan
// (cached per task), then run the task on a loop — dwelling on the result between
// runs — until the controller aborts (nobody watching) or the page dies.
async function runCastTask(entry) {
	const task = pickTask(entry.agentId);
	entry.task = task;
	let narration = null;
	try { narration = await generateNarration(task, { baseUrl: BASE_URL }); }
	catch { /* fall back to the task's own declarative narration */ }

	const executor = makeExecutor(entry);
	while (!entry.controller.signal.aborted && entry.page && !entry.page.isClosed()) {
		// Human has the wheel: don't start a task sequence. The control loop drains
		// their input and keeps pixels flowing; we just wait for them to let go.
		if (isManual(entry)) { await sleep(FRAME_MS); continue; }
		try {
			const { aborted } = await runTaskSteps({ task, narration, executor, signal: entry.controller.signal });
			if (aborted) break;
		} catch (err) {
			if (Date.now() - (entry.lastErrorAt || 0) > 30_000) {
				entry.lastErrorAt = Date.now();
				log('cast task error', entry.agentId, err?.message || err);
			}
			await sleep(2_000);
		}
		await dwellTask(entry, DWELL_MS);
	}
}

async function stopCasting(agentId) {
	const entry = pool.get(agentId);
	if (!entry) return;
	pool.delete(agentId);
	if (entry.timer) clearInterval(entry.timer);
	entry.controller?.abort(); // stop a task-driven cast loop promptly
	try { await entry.page?.close(); } catch { /* */ }
	log('stopped', agentId, `(${pool.size}/${MAX_BROWSERS})`);
}

async function reconcile() {
	if (stopping) return;
	const wanted = await fetchWanted();
	const wantedIds = wanted.map((a) => a.agentId);
	const wantedSet = new Set(wantedIds);

	// Tear down agents nobody is watching anymore.
	for (const id of [...pool.keys()]) {
		if (!wantedSet.has(id)) await stopCasting(id);
	}

	// Spin up newly-watched agents, respecting the concurrency cap. Most-wanted
	// first (watch-wanted returns them in recency order).
	for (const agent of wanted) {
		if (pool.size >= MAX_BROWSERS) break;
		if (!pool.has(agent.agentId)) {
			try { await startCasting(agent); }
			catch (err) { log('startCasting failed', agent.agentId, err?.message || err); }
		}
	}
}

async function shutdown() {
	if (stopping) return;
	stopping = true;
	log('shutting down…');
	for (const id of [...pool.keys()]) await stopCasting(id);
	try { await browser?.close(); } catch { /* */ }
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log(`starting · base=${BASE_URL} · max=${MAX_BROWSERS} · poll=${POLL_MS}ms · frame=${FRAME_MS}ms · control=${CONTROL_POLL_MS}ms`);
await reconcile();
setInterval(reconcile, POLL_MS);
setInterval(drainControl, CONTROL_POLL_MS);
