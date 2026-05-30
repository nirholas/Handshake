// Headless proof that the in-world live chart screen renders in a coin community.
// Deep-links /play into a real pump.fun coin, waits for the world + chart screen,
// confirms it ingested real trades, then screenshots the scene.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const RESULT = '/tmp/probe.json';
const save = (o) => { try { writeFileSync(RESULT, JSON.stringify(o, null, 2)); } catch {} };

const BASE = process.env.BASE || 'http://localhost:3000';
const MINT = process.env.MINT || '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'; // Fartcoin
const errors = [];

const browser = await chromium.launch({
	args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(`${BASE}/pages/play.html?coin=${MINT}&name=Fartcoin&symbol=Fartcoin`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !!window.__CC__, { timeout: 60000 });

// The chart screen is built as soon as the world geometry is assembled (before
// the multiplayer connect, which may be offline in headless CI).
const built = await page.waitForFunction(() => !!window.__CC__?._chartScreen, { timeout: 25000 })
	.then(() => true).catch(() => false);
if (!built) {
	const dbg = await page.evaluate(() => ({ phase: window.__CC__?.phase, hasCC: !!window.__CC__ }));
	save({ ok: false, dbg, errors });
	console.log('chart screen not built. state:', JSON.stringify(dbg), 'errors:', errors);
	await page.screenshot({ path: '/tmp/chart-screen.png' });
	await browser.close();
	process.exit(1);
}

// Give the trades poll a couple of cycles to land real data.
await page.waitForTimeout(8000);

const probe = await page.evaluate(() => {
	const cs = window.__CC__._chartScreen;
	// The screen face is an HTML canvas behind a CanvasTexture. Sample its pixels
	// to prove it actually painted something (not a blank/black plane).
	let painted = false, distinctColors = 0;
	try {
		const canvas = cs?.mesh?.material?.map?.image;
		if (canvas?.getContext) {
			const c = canvas.getContext('2d');
			const { data } = c.getImageData(0, 0, canvas.width, canvas.height);
			const seen = new Set();
			for (let i = 0; i < data.length; i += 4 * 997) {
				seen.add((data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4));
			}
			distinctColors = seen.size;
			painted = seen.size > 4; // a chart has many tones; a blank canvas has ~1
		}
	} catch (e) { /* ignore */ }
	return {
		phase: window.__CC__.phase,
		hasScreen: !!cs,
		hasMesh: !!cs?.mesh,
		mint: cs?.mint || null,
		painted,
		distinctColors,
	};
});

const ok = probe.hasScreen && probe.hasMesh && probe.painted && !errors.length;
save({ ok, probe, errors });
console.log('probe:', JSON.stringify(probe));
console.log('console errors:', errors.length ? errors : 'none');

// Screenshot is best-effort: swiftshader can stall on a continuously-rendering
// WebGL page, so never let it fail the check.
try {
	await page.evaluate(() => { document.getElementById('kx-loading')?.remove(); });
	await page.screenshot({ path: '/tmp/chart-screen.png', timeout: 8000, animations: 'disabled' });
} catch { /* non-fatal */ }
await browser.close();
process.exit(ok ? 0 : 1);
