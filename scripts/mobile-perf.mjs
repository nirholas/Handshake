#!/usr/bin/env node
/**
 * Mobile performance harness (Playwright, real measurements).
 *
 * IMPORTANT, read before quoting any number this produces:
 * These are PLAYWRIGHT-MEASURED FIELD-STYLE METRICS, NOT LIGHTHOUSE SCORES.
 * Lighthouse is not installed in this workspace and may not be added, so this
 * harness measures the same underlying web-vitals primitives directly in the
 * page (PerformanceObserver) under emulated mobile hardware and network:
 *
 *   LCP  - largest-contentful-paint, last entry, milliseconds
 *   CLS  - sum of layout-shift values with hadRecentInput === false
 *   TBT* - long-task blocking time proxy: sum(max(0, duration - 50)) over
 *          PerformanceLongTaskTiming entries. Lighthouse computes TBT between
 *          FCP and TTI on a simulated trace; this is a measured-on-device
 *          approximation, so it is named "tbtProxy" everywhere, never "TBT".
 *   FCP  - first-contentful-paint
 *   DCL / load - navigation timing
 *   transferBytes - real over-the-wire encoded bytes from CDP
 *          Network.loadingFinished (encodedDataLength), not content-length
 *          guesses and not uncompressed resource sizes.
 *   webgl - WebGL/WebGL2 contexts created (getContext is instrumented before
 *          any page script runs), plus how many are still live (canvas still
 *          connected and context not lost) and how many of those are visible.
 *
 * There is no composite "performance score" here on purpose. A single blended
 * score would imply Lighthouse parity we do not have.
 *
 * Throttling is applied over CDP on top of a Playwright mobile device
 * descriptor (default Pixel 5):
 *   Emulation.setCPUThrottlingRate    (default 4x)
 *   Network.emulateNetworkConditions  (default "slow4g" = the Lighthouse
 *                                      mobile profile: 1.6 Mbps down /
 *                                      750 Kbps up / 150 ms RTT)
 *
 * Usage:
 *   node scripts/mobile-perf.mjs                       # top-15 preset vs production
 *   node scripts/mobile-perf.mjs --pages /,/forge      # explicit page list
 *   node scripts/mobile-perf.mjs --runs 3              # median of 3 runs per page
 *   node scripts/mobile-perf.mjs --json out.json --md out.md
 *   node scripts/mobile-perf.mjs --base http://localhost:3000
 *   node scripts/mobile-perf.mjs --device "iPhone 13" --net fast4g --cpu 2
 *   node scripts/mobile-perf.mjs --settle 8000         # post-load idle window
 *
 * Exit code is 0 unless every page failed to load (so it is safe in CI as a
 * measurement step, not a gate).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const C = {
	g: (s) => `\x1b[32m${s}\x1b[0m`,
	r: (s) => `\x1b[31m${s}\x1b[0m`,
	y: (s) => `\x1b[33m${s}\x1b[0m`,
	d: (s) => `\x1b[2m${s}\x1b[0m`,
	b: (s) => `\x1b[1m${s}\x1b[0m`,
	c: (s) => `\x1b[36m${s}\x1b[0m`,
};

// ── Network profiles (bytes/sec, ms) ─────────────────────────────────────────
// slow4g mirrors the Lighthouse mobile throttling profile; fast4g mirrors the
// Chrome DevTools "Fast 4G" preset.
const NET_PROFILES = {
	slow4g: {
		label: 'slow 4G (1.6 Mbps down / 750 Kbps up / 150 ms RTT)',
		downloadThroughput: Math.round((1.6 * 1024 * 1024) / 8),
		uploadThroughput: Math.round((750 * 1024) / 8),
		latency: 150,
	},
	fast4g: {
		label: 'fast 4G (9 Mbps down / 1.5 Mbps up / 20 ms RTT)',
		downloadThroughput: Math.round((9 * 1024 * 1024) / 8),
		uploadThroughput: Math.round((1.5 * 1024 * 1024) / 8),
		latency: 20,
	},
	slow3g: {
		label: 'slow 3G (400 Kbps down / 400 Kbps up / 400 ms RTT)',
		downloadThroughput: Math.round((400 * 1024) / 8),
		uploadThroughput: Math.round((400 * 1024) / 8),
		latency: 400,
	},
	none: { label: 'unthrottled network', downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
};

// ── The top-15 preset (prompts/finish/quality-bar-08-mobile-performance.md task 1) ──
// A coin page and an agent profile need concrete ids. The coin is $THREE (the
// only coin this platform promotes). The agent id is resolved at runtime from
// the live marketplace feed so the preset never rots; AGENT_FALLBACK is used
// only if that call fails.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const AGENT_FALLBACK = '/agents/d94d2a50-86fa-4d2e-b87b-580f7517aa4c';

const TOP15_STATIC = [
	{ path: '/', label: 'home' },
	{ path: '/forge', label: 'forge' },
	{ path: '/markets', label: 'markets' },
	{ path: '/news', label: 'news' },
	{ path: '/marketplace', label: 'marketplace' },
	{ path: `/coin/${THREE_MINT}`, label: 'coin ($THREE)' },
	{ path: '/dashboard', label: 'dashboard' },
	{ path: '/walk', label: 'walk' },
	{ path: '/irl', label: 'irl' },
	{ path: '/ar', label: 'ar' },
	{ path: '/play', label: 'play' },
	{ path: '/launches', label: 'launches' },
	{ path: '/changelog', label: 'changelog' },
	{ path: '/docs/start-here', label: 'docs start' },
];

async function resolveAgentPage(base) {
	try {
		const res = await fetch(`${base}/api/marketplace/agents?limit=1`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = await res.json();
		const id = json?.data?.items?.[0]?.id;
		if (id) return { path: `/agents/${id}`, label: 'agent profile' };
	} catch (err) {
		console.warn(C.y(`  agent-profile lookup failed (${err.message}); using fallback id`));
	}
	return { path: AGENT_FALLBACK, label: 'agent profile' };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const out = {
		base: 'https://three.ws',
		pages: null,
		runs: 3,
		device: 'Pixel 5',
		net: 'slow4g',
		cpu: 4,
		settle: 6000,
		timeout: 60000,
		loadWait: 25000,
		json: null,
		md: null,
		label: '',
		headful: false,
		scroll: false,
		scrollDwell: 2500,
	};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--base') out.base = next().replace(/\/+$/, '');
		else if (a === '--pages') out.pages = next();
		else if (a === '--runs') out.runs = Math.max(1, Number(next()) || 1);
		else if (a === '--device') out.device = next();
		else if (a === '--net') out.net = next();
		else if (a === '--cpu') out.cpu = Math.max(1, Number(next()) || 1);
		else if (a === '--settle') out.settle = Math.max(0, Number(next()) || 0);
		else if (a === '--timeout') out.timeout = Math.max(5000, Number(next()) || 5000);
		else if (a === '--load-wait') out.loadWait = Math.max(0, Number(next()) || 0);
		else if (a === '--json') out.json = next();
		else if (a === '--md') out.md = next();
		else if (a === '--label') out.label = next();
		else if (a === '--headful') out.headful = true;
		else if (a === '--scroll') out.scroll = true;
		else if (a === '--scroll-dwell') out.scrollDwell = Math.max(200, Number(next()) || 200);
		else if (a === '--help' || a === '-h') {
			printHelp();
			process.exit(0);
		} else console.warn(C.y(`unknown flag ignored: ${a}`));
	}
	return out;
}

function printHelp() {
	console.log(`
${C.b('mobile-perf')} - Playwright-measured mobile field metrics (NOT Lighthouse scores)

  --base <origin>     default https://three.ws
  --pages <list>      comma-separated paths, or "top15" (default)
  --runs <n>          runs per page, median reported (default 3)
  --device <name>     Playwright device descriptor (default "Pixel 5")
  --net <profile>     ${Object.keys(NET_PROFILES).join(' | ')} (default slow4g)
  --cpu <rate>        CPU throttling multiplier (default 4)
  --settle <ms>       idle window after load before reading metrics (default 6000)
  --timeout <ms>      DOMContentLoaded navigation timeout (default 60000)
  --load-wait <ms>    extra wait for window load after DCL (default 25000, non-fatal)
  --json <file>       write raw results JSON
  --md <file>         write a readable Markdown table
  --label <text>      free-text label stored in the JSON (e.g. "baseline")
  --scroll            after metrics are read, scroll the page and sample the
                      WebGL live/visible context ceiling (grid pages)
  --scroll-dwell <ms> settle per scroll step (default 2500)
  --headful           run with a visible browser
`);
}

// ── In-page instrumentation (installed before any page script runs) ──────────
function installProbe() {
	const S = {
		lcp: 0,
		lcpDetail: '',
		cls: 0,
		clsSources: [],
		fcp: 0,
		longTasks: [],
		webglCreated: 0,
		webglLost: 0,
		webglRestored: 0,
		_gl: [],
	};
	window.__mobilePerf = S;

	const safeObserve = (type, cb) => {
		try {
			const po = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) cb(entry);
			});
			po.observe({ type, buffered: true });
		} catch {
			/* entry type unsupported in this browser build */
		}
	};

	safeObserve('largest-contentful-paint', (e) => {
		S.lcp = e.startTime;
		const el = e.element;
		S.lcpDetail = el
			? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${
					el.className && typeof el.className === 'string'
						? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
						: ''
				}`
			: e.url || '(unknown)';
	});

	safeObserve('layout-shift', (e) => {
		if (e.hadRecentInput) return;
		S.cls += e.value;
		if (e.value >= 0.01 && S.clsSources.length < 12) {
			const node = e.sources?.[0]?.node;
			S.clsSources.push({
				value: Number(e.value.toFixed(4)),
				at: Math.round(e.startTime),
				node: node?.tagName
					? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}`
					: '(detached)',
			});
		}
	});

	safeObserve('paint', (e) => {
		if (e.name === 'first-contentful-paint') S.fcp = e.startTime;
	});

	safeObserve('longtask', (e) => {
		if (S.longTasks.length < 500) S.longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
	});

	// WebGL context accounting. Patched before page scripts so every context
	// creation is seen, including ones created inside third-party bundles.
	const orig = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, ...rest) {
		const ctx = orig.call(this, type, ...rest);
		if (ctx && /^(webgl2?|experimental-webgl)$/i.test(String(type)) && !this.__mpTracked) {
			this.__mpTracked = true;
			S.webglCreated++;
			S._gl.push({ canvas: this, ctx });
			this.addEventListener('webglcontextlost', () => {
				S.webglLost++;
			});
			this.addEventListener('webglcontextrestored', () => {
				S.webglRestored++;
			});
		}
		return ctx;
	};
}

function readProbe() {
	const S = window.__mobilePerf || {};
	const nav = performance.getEntriesByType('navigation')[0] || {};
	const tbtProxy = (S.longTasks || []).reduce((sum, t) => sum + Math.max(0, t.dur - 50), 0);
	const longest = (S.longTasks || []).reduce((m, t) => Math.max(m, t.dur), 0);

	const live = [];
	for (const rec of S._gl || []) {
		let lost = true;
		try {
			lost = rec.ctx.isContextLost();
		} catch {
			lost = true;
		}
		if (!rec.canvas.isConnected || lost) continue;
		const cs = getComputedStyle(rec.canvas);
		const box = rec.canvas.getBoundingClientRect();
		const visible =
			cs.display !== 'none' &&
			cs.visibility !== 'hidden' &&
			Number(cs.opacity) > 0.01 &&
			box.width > 8 &&
			box.height > 8;
		live.push({
			visible,
			w: Math.round(box.width),
			h: Math.round(box.height),
			id: rec.canvas.id || rec.canvas.className || '(anon)',
		});
	}

	return {
		lcp: Math.round(S.lcp || 0),
		lcpDetail: S.lcpDetail || '',
		cls: Number((S.cls || 0).toFixed(4)),
		clsSources: S.clsSources || [],
		fcp: Math.round(S.fcp || 0),
		tbtProxy: Math.round(tbtProxy),
		longTaskCount: (S.longTasks || []).length,
		longestTask: Math.round(longest),
		dcl: Math.round(nav.domContentLoadedEventEnd || 0),
		load: Math.round(nav.loadEventEnd || 0),
		webglCreated: S.webglCreated || 0,
		webglLost: S.webglLost || 0,
		webglRestored: S.webglRestored || 0,
		webglLive: live.length,
		webglVisible: live.filter((c) => c.visible).length,
		webglDetail: live,
		domNodes: document.getElementsByTagName('*').length,
		images: document.images.length,
	};
}

// Light-weight live-context sampler used during the optional scroll pass.
function sampleGl() {
	const S = window.__mobilePerf || {};
	let live = 0;
	let visible = 0;
	for (const rec of S._gl || []) {
		let lost = true;
		try {
			lost = rec.ctx.isContextLost();
		} catch {
			lost = true;
		}
		if (!rec.canvas.isConnected || lost) continue;
		live++;
		const cs = getComputedStyle(rec.canvas);
		const box = rec.canvas.getBoundingClientRect();
		if (
			cs.display !== 'none' &&
			cs.visibility !== 'hidden' &&
			Number(cs.opacity) > 0.01 &&
			box.width > 8 &&
			box.height > 8
		)
			visible++;
	}
	return { created: S.webglCreated || 0, live, visible, lost: S.webglLost || 0, y: Math.round(window.scrollY) };
}

// ── One measurement run ──────────────────────────────────────────────────────
async function measureOnce(browser, deviceDescriptor, url, opts) {
	const context = await browser.newContext({
		...deviceDescriptor,
		// A fresh profile every run: no warm HTTP cache skewing transfer bytes.
		serviceWorkers: 'block',
	});
	const page = await context.newPage();
	await page.addInitScript(installProbe);

	const bytes = { total: 0, byType: {}, resources: [] };
	const meta = new Map();
	const consoleErrors = [];

	page.on('console', (msg) => {
		if (msg.type() === 'error' && consoleErrors.length < 25) consoleErrors.push(msg.text().slice(0, 300));
	});
	page.on('pageerror', (err) => {
		if (consoleErrors.length < 25) consoleErrors.push(`pageerror: ${String(err.message).slice(0, 300)}`);
	});

	const cdp = await context.newCDPSession(page);
	await cdp.send('Network.enable');
	const net = NET_PROFILES[opts.net] || NET_PROFILES.slow4g;
	await cdp.send('Network.emulateNetworkConditions', {
		offline: false,
		latency: net.latency,
		downloadThroughput: net.downloadThroughput,
		uploadThroughput: net.uploadThroughput,
	});
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.cpu });

	cdp.on('Network.responseReceived', (e) => {
		meta.set(e.requestId, { url: e.response.url, type: e.type || 'Other', status: e.response.status });
	});
	const tally = (requestId, encodedDataLength) => {
		const m = meta.get(requestId) || { url: '(unknown)', type: 'Other' };
		const n = Number(encodedDataLength) || 0;
		if (n <= 0) return;
		bytes.total += n;
		bytes.byType[m.type] = (bytes.byType[m.type] || 0) + n;
		bytes.resources.push({ url: m.url, type: m.type, bytes: n });
	};
	cdp.on('Network.loadingFinished', (e) => tally(e.requestId, e.encodedDataLength));
	cdp.on('Network.loadingFailed', (e) => tally(e.requestId, e.encodedDataLength));

	let status = 0;
	let error = null;
	let loadFired = true;
	const t0 = Date.now();
	try {
		const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
		status = res?.status() ?? 0;
	} catch (err) {
		error = String(err.message).split('\n')[0].slice(0, 200);
	}

	// Some pages keep long-lived streams open (market feeds, telemetry), so the
	// window `load` event can lag far behind usable render. Wait for it, but do
	// not fail the run on it: record loadFired instead and keep measuring.
	if (!error) {
		try {
			await page.waitForLoadState('load', { timeout: opts.loadWait });
		} catch {
			loadFired = false;
		}
	}

	// Idle settle: lets deferred hydration, 3D bootstrap, lazy images and late
	// layout shifts land before metrics are read. No scrolling: scroll would
	// inflate CLS in a way Lighthouse's initial-load pass never sees.
	if (!error) await page.waitForTimeout(opts.settle);

	let probe = null;
	try {
		probe = await page.evaluate(readProbe);
	} catch (err) {
		error = error || `probe failed: ${String(err.message).slice(0, 160)}`;
	}

	// Optional scroll pass. Grid pages only boot their lower viewers once those
	// rows intersect the viewport, so the WebGL context ceiling is invisible
	// without scrolling. This runs AFTER the metrics read so it can never
	// inflate CLS or LCP in the reported numbers.
	let scroll = null;
	if (opts.scroll && !error) {
		try {
			scroll = { steps: 0, glCreatedMax: 0, glLiveMax: 0, glVisibleMax: 0, samples: [] };
			const height = await page.evaluate(() => document.documentElement.scrollHeight);
			const vh = await page.evaluate(() => window.innerHeight);
			const steps = Math.min(30, Math.max(1, Math.ceil(height / vh)));
			for (let i = 1; i <= steps; i++) {
				await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), i * vh);
				await page.waitForTimeout(opts.scrollDwell);
				const s = await page.evaluate(sampleGl);
				scroll.steps = i;
				scroll.samples.push(s);
				scroll.glCreatedMax = Math.max(scroll.glCreatedMax, s.created);
				scroll.glLiveMax = Math.max(scroll.glLiveMax, s.live);
				scroll.glVisibleMax = Math.max(scroll.glVisibleMax, s.visible);
			}
		} catch (err) {
			scroll = { error: String(err.message).slice(0, 160) };
		}
	}

	const wallMs = Date.now() - t0;
	bytes.resources.sort((a, b) => b.bytes - a.bytes);
	await context.close().catch(() => {});

	return {
		url,
		status,
		error,
		loadFired,
		scroll,
		wallMs,
		transferBytes: bytes.total,
		bytesByType: bytes.byType,
		topResources: bytes.resources.slice(0, 10),
		requestCount: meta.size,
		consoleErrors,
		...(probe || {}),
	};
}

// ── Stats ────────────────────────────────────────────────────────────────────
function median(values) {
	const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
	if (!v.length) return null;
	const mid = Math.floor(v.length / 2);
	return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const MEDIAN_KEYS = [
	'lcp',
	'cls',
	'fcp',
	'tbtProxy',
	'longTaskCount',
	'longestTask',
	'dcl',
	'load',
	'transferBytes',
	'requestCount',
	'webglCreated',
	'webglLive',
	'webglVisible',
	'domNodes',
	'images',
];

function summarise(label, path, runs) {
	const ok = runs.filter((r) => !r.error && r.status && r.status < 400);
	const summary = { label, path, runs: runs.length, okRuns: ok.length };
	const source = ok.length ? ok : runs;
	for (const key of MEDIAN_KEYS) {
		const m = median(source.map((r) => r[key]));
		summary[key] = key === 'cls' ? (m === null ? null : Number(m.toFixed(4))) : m === null ? null : Math.round(m);
	}
	const last = source[source.length - 1] || runs[runs.length - 1] || {};
	summary.status = last.status ?? 0;
	summary.loadFired = source.every((r) => r.loadFired !== false);
	const scrolls = source.map((r) => r.scroll).filter((s) => s && !s.error);
	if (scrolls.length) {
		summary.scrollGlCreatedMax = Math.max(...scrolls.map((s) => s.glCreatedMax));
		summary.scrollGlLiveMax = Math.max(...scrolls.map((s) => s.glLiveMax));
		summary.scrollGlVisibleMax = Math.max(...scrolls.map((s) => s.glVisibleMax));
		summary.scrollSteps = Math.max(...scrolls.map((s) => s.steps));
	}
	summary.lcpDetail = last.lcpDetail || '';
	summary.clsSources = last.clsSources || [];
	summary.bytesByType = last.bytesByType || {};
	summary.topResources = last.topResources || [];
	summary.webglDetail = last.webglDetail || [];
	summary.consoleErrors = last.consoleErrors || [];
	summary.errors = runs.filter((r) => r.error).map((r) => r.error);
	return summary;
}

const kb = (n) => (n === null || n === undefined ? '-' : `${(n / 1024).toFixed(0)} KB`);
const ms = (n) => (n === null || n === undefined ? '-' : `${n}`);

function renderTable(rows) {
	const head = ['page', 'LCP ms', 'CLS', 'TBT* ms', 'DCL ms', 'load ms', 'transfer', 'reqs', 'GL made/live/vis'];
	const body = rows.map((r) => [
		r.label,
		ms(r.lcp),
		r.cls === null ? '-' : r.cls.toFixed(3),
		ms(r.tbtProxy),
		ms(r.dcl),
		ms(r.load),
		kb(r.transferBytes),
		ms(r.requestCount),
		`${r.webglCreated ?? '-'}/${r.webglLive ?? '-'}/${r.webglVisible ?? '-'}`,
	]);
	const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => String(b[i]).length)));
	const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
	return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

function renderMarkdown(report) {
	const { config, results } = report;
	const sorted = [...results].sort((a, b) => (b.lcp ?? 0) - (a.lcp ?? 0));
	const rows = sorted.map(
		(r) =>
			`| ${r.label} | \`${r.path}\` | ${ms(r.lcp)} | ${r.cls === null ? '-' : r.cls.toFixed(3)} | ${ms(
				r.tbtProxy,
			)} | ${ms(r.fcp)} | ${ms(r.dcl)} | ${ms(r.load)} | ${kb(r.transferBytes)} | ${ms(r.requestCount)} | ${
				r.webglCreated ?? '-'
			} / ${r.webglLive ?? '-'} / ${r.webglVisible ?? '-'} | ${r.status} |`,
	);
	return `# Mobile performance measurement${config.label ? ` - ${config.label}` : ''}

**These are Playwright-measured field-style metrics, not Lighthouse scores.** Lighthouse is not
installed in this workspace and may not be added as a dependency, so \`scripts/mobile-perf.mjs\`
measures the underlying web-vitals primitives directly in the page with \`PerformanceObserver\`
under emulated mobile hardware and network. \`TBT*\` is a long-task blocking-time proxy
(\`sum(max(0, longtask.duration - 50))\`), not Lighthouse's simulated TBT.

- Origin: ${config.base}
- Device: ${config.device} (Playwright descriptor, Chromium)
- Network: ${config.netLabel} via CDP \`Network.emulateNetworkConditions\`
- CPU: ${config.cpu}x throttling via CDP \`Emulation.setCPUThrottlingRate\`
- Runs per page: ${config.runs} (median reported), settle window ${config.settle} ms after \`load\`
- Measured: ${config.startedAt}

Sorted worst LCP first.

| page | path | LCP ms | CLS | TBT* ms | FCP ms | DCL ms | load ms | transfer | reqs | GL made/live/visible | HTTP |
|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Per-page detail

${sorted
	.map((r) => {
		const types = Object.entries(r.bytesByType || {})
			.sort((a, b) => b[1] - a[1])
			.map(([t, n]) => `${t} ${kb(n)}`)
			.join(', ');
		const top = (r.topResources || [])
			.slice(0, 5)
			.map((x) => `  - ${kb(x.bytes)} \`${x.url.replace(config.base, '')}\` (${x.type})`)
			.join('\n');
		const shifts = (r.clsSources || [])
			.map((s) => `  - ${s.value} at ${s.at} ms from \`${s.node}\``)
			.join('\n');
		const gl = (r.webglDetail || []).map((c) => `  - ${c.w}x${c.h} visible=${c.visible} \`${c.id}\``).join('\n');
		return `### ${r.label} - \`${r.path}\`

- LCP ${ms(r.lcp)} ms${r.lcpDetail ? ` (element: \`${r.lcpDetail}\`)` : ''}
- CLS ${r.cls === null ? '-' : r.cls.toFixed(4)}, TBT* ${ms(r.tbtProxy)} ms over ${ms(r.longTaskCount)} long tasks (longest ${ms(r.longestTask)} ms)
- transfer ${kb(r.transferBytes)} across ${ms(r.requestCount)} requests${types ? ` - ${types}` : ''}
- window \`load\` fired within the wait window: ${r.loadFired ? 'yes' : 'NO (long-lived requests still open)'}
- DOM nodes ${ms(r.domNodes)}, img elements ${ms(r.images)}
- WebGL contexts: created ${r.webglCreated ?? '-'}, live ${r.webglLive ?? '-'}, visible ${r.webglVisible ?? '-'}, lost ${r.webglLost ?? '-'}${
			r.scrollGlLiveMax === undefined
				? ''
				: `\n- WebGL ceiling while scrolling (${r.scrollSteps} steps): created ${r.scrollGlCreatedMax}, live max ${r.scrollGlLiveMax}, visible max ${r.scrollGlVisibleMax}`
		}
${gl ? `${gl}\n` : ''}${top ? `- heaviest resources:\n${top}\n` : ''}${shifts ? `- layout shifts:\n${shifts}\n` : ''}${
			r.errors?.length ? `- run errors: ${r.errors.join('; ')}\n` : ''
		}${r.consoleErrors?.length ? `- console errors: ${r.consoleErrors.length} (first: \`${r.consoleErrors[0]}\`)\n` : ''}`;
	})
	.join('\n')}
`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
	const opts = parseArgs(process.argv);
	const net = NET_PROFILES[opts.net];
	if (!net) {
		console.error(C.r(`unknown --net profile "${opts.net}". Options: ${Object.keys(NET_PROFILES).join(', ')}`));
		process.exit(2);
	}
	const deviceDescriptor = devices[opts.device];
	if (!deviceDescriptor) {
		console.error(C.r(`unknown --device "${opts.device}". Try "Pixel 5" or "iPhone 13".`));
		process.exit(2);
	}

	let pageList;
	if (!opts.pages || opts.pages === 'top15') {
		pageList = [...TOP15_STATIC, await resolveAgentPage(opts.base)];
	} else {
		pageList = opts.pages
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => ({ path: p.startsWith('/') ? p : `/${p}`, label: p }));
	}

	const config = {
		base: opts.base,
		device: opts.device,
		net: opts.net,
		netLabel: net.label,
		cpu: opts.cpu,
		runs: opts.runs,
		settle: opts.settle,
		label: opts.label,
		startedAt: new Date().toISOString(),
		harness: 'scripts/mobile-perf.mjs',
		metricsNote:
			'Playwright-measured field-style metrics via PerformanceObserver under CDP CPU/network throttling. NOT Lighthouse scores. tbtProxy = sum(max(0, longtask.duration - 50)).',
		browser: 'chromium',
	};

	console.log(C.b('\nmobile-perf') + C.d('  (Playwright field metrics, not Lighthouse scores)'));
	console.log(C.d(`  origin ${config.base} | device ${config.device} | ${net.label} | CPU ${config.cpu}x | runs ${config.runs}\n`));

	const browser = await chromium.launch({ headless: !opts.headful });
	const results = [];
	try {
		for (const entry of pageList) {
			const url = `${opts.base}${entry.path}`;
			const runs = [];
			process.stdout.write(C.c(`  ${entry.label.padEnd(16)}`) + C.d(entry.path));
			for (let i = 0; i < opts.runs; i++) {
				const r = await measureOnce(browser, deviceDescriptor, url, opts);
				runs.push(r);
				process.stdout.write(r.error ? C.r(' x') : C.g(' .'));
			}
			const s = summarise(entry.label, entry.path, runs);
			results.push(s);
			const tag = s.okRuns
				? C.d(
						` LCP ${s.lcp}ms  CLS ${s.cls}  TBT* ${s.tbtProxy}ms  ${kb(s.transferBytes)}  GL ${s.webglCreated}/${s.webglLive}/${s.webglVisible}` +
							(s.scrollGlLiveMax === undefined
								? ''
								: `  scrollGL ${s.scrollGlCreatedMax}/${s.scrollGlLiveMax}/${s.scrollGlVisibleMax}`),
					)
				: C.r(` FAILED: ${s.errors[0] || 'unknown'}`);
			console.log(tag);
		}
	} finally {
		await browser.close().catch(() => {});
	}

	const report = { config, results };

	console.log('\n' + renderTable([...results].sort((a, b) => (b.lcp ?? 0) - (a.lcp ?? 0))));
	console.log(C.d('\n  TBT* = long-task blocking-time proxy. GL = WebGL contexts created/live/visible.'));

	if (opts.json) {
		const p = resolve(ROOT, opts.json);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(report, null, 2));
		console.log(C.g(`\n  wrote ${p}`));
	}
	if (opts.md) {
		const p = resolve(ROOT, opts.md);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, renderMarkdown(report));
		console.log(C.g(`  wrote ${p}`));
	}

	const anyOk = results.some((r) => r.okRuns > 0);
	process.exit(anyOk ? 0 : 1);
}

main().catch((err) => {
	console.error(C.r(`mobile-perf failed: ${err.stack || err.message}`));
	process.exit(1);
});
