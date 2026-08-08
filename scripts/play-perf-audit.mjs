// Performance audit for /play: transfer weight to interactive, frame-time
// distribution while walking the busiest area, renderer draw-call/geometry
// budget, and heap growth over a long idle sit.
//
//   node scripts/play-perf-audit.mjs "<url>" [walkSeconds] [idleSeconds]
//   IDLE=300 node scripts/play-perf-audit.mjs "$PLAY_URL"
//
// Chromium only (heap counters + WebGL under swiftshader). Everything it prints
// is a number you can diff across a change: totals are keyed so two runs line up
// line for line.
import { chromium } from 'playwright';

const TARGET = process.argv[2] || 'https://three.ws/play';
const WALK_MS = Number(process.argv[3] || 30) * 1000;
const IDLE_MS = Number(process.argv[4] || process.env.IDLE || 300) * 1000;
const LABEL = process.env.LABEL || 'run';

const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--expose-gc'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// Frame instrumentation has to be installed before any page script runs, so the
// very first rendered frame is measured too.
await ctx.addInitScript(() => {
	window.__frames = [];
	window.__marks = {};
	let last = 0;
	const tick = (t) => {
		if (last) window.__frames.push(t - last);
		last = t;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	window.__glbLoads = [];
	const note = (url) => window.__glbLoads.push(String(url).replace(/^https?:\/\/[^/]+/, ''));
	const origOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url, ...rest) {
		if (/\.(glb|gltf|hdr|ktx2)(\?|$)/i.test(String(url))) note(url);
		return origOpen.call(this, method, url, ...rest);
	};
	const origFetch = window.fetch;
	window.fetch = function (input, init) {
		const url = typeof input === 'string' ? input : input?.url || '';
		if (/\.(glb|gltf|hdr|ktx2)(\?|$)/i.test(url) || /\/animations\/(clips|manifest)/.test(url)) note(url);
		return origFetch.call(this, input, init);
	};
});

const page = await ctx.newPage();
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

const resourceTotals = () =>
	page.evaluate(() => {
		const rows = performance.getEntriesByType('resource').map((r) => ({
			url: r.name,
			// transferSize is 0 for a memory-cache hit and ~300 for a 304; the
			// decoded body is what the CPU actually paid for either way.
			transfer: r.transferSize || 0,
			encoded: r.encodedBodySize || 0,
			type: r.initiatorType,
		}));
		return { rows, nav: performance.getEntriesByType('navigation')[0]?.duration || 0 };
	});

const heapMB = async () => {
	const client = await page.context().newCDPSession(page);
	await client.send('HeapProfiler.collectGarbage');
	const { metrics } = await client.send('Performance.getMetrics');
	await client.detach();
	return Math.round((metrics.find((m) => m.name === 'JSHeapUsedSize')?.value || 0) / 1048576);
};

const rendererStats = () =>
	page.evaluate(() => {
		const g = window.__CC__;
		const r = g?.renderer;
		if (!r) return null;
		let meshes = 0, instanced = 0, geoms = new Set(), mats = new Set();
		g.scene?.traverse?.((o) => {
			if (o.isInstancedMesh) instanced++;
			else if (o.isMesh) meshes++;
			if (o.geometry) geoms.add(o.geometry.uuid);
			if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m.uuid));
		});
		return {
			calls: r.info.render.calls,
			triangles: r.info.render.triangles,
			programs: r.info.programs?.length || 0,
			geometriesResident: r.info.memory.geometries,
			texturesResident: r.info.memory.textures,
			meshes, instanced,
			uniqueGeometries: geoms.size,
			uniqueMaterials: mats.size,
			pixelRatio: r.getPixelRatio(),
		};
	});

const frameStats = async (reset = false) => {
	const f = await page.evaluate((r) => {
		const arr = window.__frames.slice();
		if (r) window.__frames.length = 0;
		return arr;
	}, reset);
	if (!f.length) return null;
	const s = f.slice().sort((a, b) => a - b);
	const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
	return {
		frames: f.length,
		mean: +(f.reduce((a, b) => a + b, 0) / f.length).toFixed(2),
		p50: +pct(50).toFixed(2),
		p95: +pct(95).toFixed(2),
		p99: +pct(99).toFixed(2),
		worst: +s[s.length - 1].toFixed(2),
		over33ms: f.filter((x) => x > 33).length,
		fps: +(1000 / (f.reduce((a, b) => a + b, 0) / f.length)).toFixed(1),
	};
};

console.log(at(), 'goto', TARGET.slice(0, 120));
// Generous: an unbundled dev server serves the world as ~1500 separate module
// requests, and a software rasterizer makes the first paint slow on top of that.
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 180000 });

try {
	await page.waitForSelector('.pi-btn-primary', { timeout: 25000 });
	await page.click('.pi-btn-primary');
	console.log(at(), 'clicked drop-in');
} catch { console.log(at(), 'no intro CTA (deep link drops straight in)'); }

// "Interactive" = the world environment is built and the renderer is drawing it.
// Deliberately not `phase === 'world'`: that flips only after the shader warm
// pass, which on a software rasterizer takes minutes and would report a healthy
// world as a failure. The third argument is where waitForFunction takes its
// options; passing them as the second silently falls back to the 30 s default.
try {
	await page.waitForFunction(
		() => {
			const l = document.getElementById('kx-loading');
			return (!l || l.classList.contains('kx-hidden')) && !!window.__CC__?.env;
		},
		null,
		{ timeout: 300000 },
	);
} catch { console.log(at(), 'WORLD NEVER BECAME INTERACTIVE, phase =', await page.evaluate(() => window.__CC__?.phase)); }
const interactiveAt = (Date.now() - t0) / 1000;
console.log(at(), 'interactive');

const atInteractive = await resourceTotals();

// Clear onboarding so input reaches the world.
for (let i = 0; i < 5; i++) {
	await page.waitForTimeout(1200);
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('button')].find(
			(b) => /^(continue|enter the world|got it|start|close|skip|next)$/i.test(b.textContent.trim()) && b.offsetParent,
		);
		if (btn) btn.click();
	});
}

await page.mouse.click(720, 500);
await page.waitForTimeout(2000);
await frameStats(true);

// Walking is optional (pass 0 walk seconds): driving input through a software
// rasterizer costs minutes per keystroke and the frame numbers it produces say
// more about the rasterizer than about the world. The renderer/heap sections
// below are the hardware-independent ones.
let walk = null;
if (WALK_MS > 0) {
	console.log(at(), `walking ${WALK_MS / 1000}s`);
	const walkEnd = Date.now() + WALK_MS;
	const keys = ['KeyW', 'KeyA', 'KeyW', 'KeyD', 'KeyS', 'KeyD', 'KeyW', 'KeyA'];
	let ki = 0;
	while (Date.now() < walkEnd) {
		const k = keys[ki++ % keys.length];
		await page.keyboard.down(k);
		await page.waitForTimeout(1500);
		await page.keyboard.up(k);
		await page.mouse.move(400 + ((ki * 137) % 640), 450);
	}
	walk = await frameStats(true);
}
const render = await rendererStats();

const heapAfterWalk = await heapMB();
console.log(at(), `idling ${IDLE_MS / 1000}s for heap growth`);
const heapSamples = [];
const idleEnd = Date.now() + IDLE_MS;
while (Date.now() < idleEnd) {
	await page.waitForTimeout(Math.min(30000, Math.max(1000, idleEnd - Date.now())));
	const mb = await heapMB();
	heapSamples.push([+((Date.now() - t0) / 1000).toFixed(0), mb]);
	console.log(at(), 'heap', mb, 'MB');
}
const idle = await frameStats(true);
const heapEnd = heapSamples.length ? heapSamples[heapSamples.length - 1][1] : heapAfterWalk;

const final = await resourceTotals();
const glb = await page.evaluate(() => window.__glbLoads || []);
const dupes = new Map();
for (const u of glb) dupes.set(u, (dupes.get(u) || 0) + 1);

const sum = (rows, key) => rows.reduce((a, r) => a + (r[key] || 0), 0);
const mb = (n) => (n / 1048576).toFixed(2);

console.log(`\n================ PERF REPORT (${LABEL}) ================`);
console.log('url                    ', TARGET.slice(0, 100));
console.log('time to interactive    ', interactiveAt.toFixed(1), 's');
console.log('transfer @interactive  ', mb(sum(atInteractive.rows, 'transfer')), 'MB over', atInteractive.rows.length, 'requests');
console.log('decoded  @interactive  ', mb(sum(atInteractive.rows, 'encoded')), 'MB');
console.log('transfer @end          ', mb(sum(final.rows, 'transfer')), 'MB over', final.rows.length, 'requests');

const byGroup = new Map();
for (const r of final.rows) {
	const k = r.url.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/*');
	const cur = byGroup.get(k) || [0, 0];
	byGroup.set(k, [cur[0] + r.transfer, cur[1] + 1]);
}
console.log('\n--- bytes by path group (top 15) ---');
for (const [k, [n, c]] of [...byGroup].sort((a, b) => b[1][0] - a[1][0]).slice(0, 15))
	console.log(' ', mb(n).padStart(8), 'MB', String(c).padStart(4), 'x', k.slice(0, 100));

console.log('\n--- 20 largest single responses ---');
for (const r of final.rows.slice().sort((a, b) => b.transfer - a.transfer).slice(0, 20))
	console.log(' ', mb(r.transfer).padStart(8), 'MB', r.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 110));

const repeats = new Map();
for (const r of final.rows) {
	const k = r.url.replace(/^https?:\/\/[^/]+/, '');
	repeats.set(k, (repeats.get(k) || 0) + 1);
}
console.log('\n--- responses fetched more than once ---');
const rep = [...repeats].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
if (!rep.length) console.log('  none');
for (const [k, c] of rep.slice(0, 20)) console.log(' ', String(c).padStart(4), 'x', k.slice(0, 120));

console.log('\n--- model/clip loads issued by the page ---');
console.log('  total', glb.length);
for (const [u, c] of [...dupes].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 20))
	console.log(' ', String(c).padStart(4), 'x', u.slice(0, 120));

console.log('\n--- frame time (ms) ---');
console.log('  walking', JSON.stringify(walk));
console.log('  idle   ', JSON.stringify(idle));

console.log('\n--- renderer ---');
console.log(' ', JSON.stringify(render));

console.log('\n--- heap ---');
console.log('  after walk', heapAfterWalk, 'MB');
console.log('  after idle', heapEnd, 'MB');
console.log('  growth    ', heapEnd - heapAfterWalk, 'MB over', (IDLE_MS / 60000).toFixed(1), 'min');
console.log('  samples   ', JSON.stringify(heapSamples));

console.log('\n--- console errors (' + errors.length + ') ---');
for (const e of [...new Set(errors)].slice(0, 12)) console.log('  ', e);

// animations:'disabled' would freeze the world loop mid-measure; a short
// timeout instead, because a busy main thread can stall the capture forever and
// a missing screenshot must never lose the numbers above.
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, timeout: 15000 }).catch(() => {});
await browser.close();
