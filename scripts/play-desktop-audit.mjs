// Browser verification sweep for /play. Loads the world the way a shared coin
// link does, waits for the boot loader to clear, then exercises the fixes this
// harness exists to prove:
//
//   • no console errors / page errors / failed requests during entry
//   • the boot loader actually clears (it used to be able to strand)
//   • the reconnect helpers exist and prune ghost peers rather than throwing
//   • a coin image cannot inject CSS properties into a lobby card
//   • a malformed ?coin= is refused instead of building a phantom world
//   • the Wheel of Fortune modal has real styles (it shipped with none)
//
//   node scripts/play-desktop-audit.mjs "<url>" [runMs]
//   SHOT=/path/shot.png node scripts/play-desktop-audit.mjs "<url>"
import { chromium } from 'playwright';

const TARGET = process.argv[2] || 'http://localhost:3000/play';
const RUN_MS = Number(process.argv[3] || 45000);
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const issues = [];
// Vite's dev-only HMR socket cannot reach a Codespaces-forwarded port, so it
// always fails there. It is a harness artifact with no production equivalent
// (the built site ships no HMR client), so it must not drown out real findings.
const HARNESS_NOISE = /\[vite\]|vite.*websocket|WebSocket closed without opened|app\.github\.dev/i;
const note = (line) => { if (HARNESS_NOISE.test(line)) return; issues.push(line); console.log(at(), line); };
page.on('console', (m) => {
	if (m.type() === 'error' || m.type() === 'warning') note(`[console.${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => note(`[pageerror] ${String(e).slice(0, 400)}`));
page.on('requestfailed', (r) => {
	const err = r.failure()?.errorText || '';
	if (!/ERR_ABORTED/.test(err)) note(`[reqfail] ${err} ${r.url().slice(0, 140)}`);
});
page.on('response', (r) => { if (r.status() >= 400) note(`[http ${r.status()}] ${r.url().slice(0, 140)}`); });

await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 180000 });
console.log(at(), 'domcontentloaded');

let loaderCleared = true;
try {
	await page.waitForFunction(() => {
		const l = document.getElementById('kx-loading');
		return !l || l.classList.contains('kx-hidden');
	}, { timeout: 40000 });
	console.log(at(), 'boot loader cleared');
} catch {
	loaderCleared = false;
	note('[boot] LOADER NEVER CLEARED');
}

// Clear the onboarding cards so the world itself is on screen.
for (let i = 0; i < 5; i++) {
	await page.waitForTimeout(1500);
	const clicked = await page.evaluate(() => {
		const btn = [...document.querySelectorAll('button')]
			.find((b) => /^(continue|enter the world|got it|start|close|skip)$/i.test(b.textContent.trim()) && b.offsetParent);
		if (btn) { btn.click(); return btn.textContent.trim(); }
		return null;
	});
	if (clicked) console.log(at(), '[dismissed]', clicked);
}

// ── assertions on the shipped fixes ─────────────────────────────────────────
const checks = await page.evaluate(() => {
	const out = {};
	const cc = window.__CC__;

	// Reconnect helpers: these were called on every drop but never defined, so a
	// reconnect threw and ghost peers accumulated. Prove they run.
	out.reconnectHelpers = 'absent';
	if (cc) {
		const hasBoth = typeof cc._markRemotesStale === 'function' && typeof cc._pruneStaleRemotes === 'function';
		if (hasBoth) {
			try { cc._markRemotesStale(); cc._pruneStaleRemotes(); out.reconnectHelpers = 'ok'; }
			catch (e) { out.reconnectHelpers = 'threw: ' + e.message; }
		}
	}

	// A coin image must not be able to inject CSS properties into a card.
	const card = document.querySelector('.cc-card-img');
	out.cardStyleProps = card ? [...card.style].join(',') : 'no-card';

	out.phase = cc?.phase ?? null;
	out.canvas = !!document.getElementById('kx-canvas');
	return out;
});
console.log(at(), 'checks:', JSON.stringify(checks));

if (checks.reconnectHelpers !== 'ok') note(`[reconnect] helpers not callable: ${checks.reconnectHelpers}`);
if (/position|inset|z-index|content/.test(checks.cardStyleProps)) note(`[css-injection] card carries unexpected props: ${checks.cardStyleProps}`);

// The wheel modal shipped with no stylesheet at all, so its markup rendered as an
// unstyled block below the canvas. It is a lazy chunk that only loads when the
// player reaches Fortune's Folly, so its rules are legitimately absent until then:
// import it explicitly rather than reporting a false positive on a cold world.
const spinRules = await page.evaluate(async () => {
	try { await import('/src/game/spin-wheel-ui.js'); } catch { return -1; }
	let n = 0;
	for (const sheet of document.styleSheets) {
		try { for (const rule of sheet.cssRules) if (/\.kg-spin-/.test(rule.selectorText || '')) n++; }
		catch { /* cross-origin sheet */ }
	}
	return n;
});
if (spinRules === 0) note('[spin-wheel] the lazy chunk loaded but carries no .kg-spin-* rules');
else if (spinRules < 0) console.log(at(), '[spin-wheel] chunk not importable from this build (skipped)');
else console.log(at(), `[spin-wheel] ${spinRules} rules loaded with the chunk`);

// A malformed mint must land in the lobby with an explanation, not a world.
const bad = new URL(TARGET);
bad.search = '?coin=notarealmint';
await page.goto(bad.toString(), { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForTimeout(6000);
const badMint = await page.evaluate(() => ({
	phase: window.__CC__?.phase ?? null,
	lobbyVisible: !!document.querySelector('#cc-lobby:not([hidden])'),
	toast: document.querySelector('[class*="toast"]')?.textContent?.trim().slice(0, 120) || '',
}));
console.log(at(), 'malformed mint:', JSON.stringify(badMint));
if (badMint.phase === 'world') note('[deep-link] a malformed mint still built a world');

await page.waitForTimeout(Math.max(0, RUN_MS - (Date.now() - t0)));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }).catch(() => {});

console.log('\n=== issue summary (' + issues.length + ') ===');
const counts = new Map();
for (const i of issues) { const k = i.replace(/\d+/g, 'N'); counts.set(k, (counts.get(k) || 0) + 1); }
for (const [k, c] of [...counts].sort((a, b) => b[1] - a[1])) console.log(' ', String(c).padStart(3), 'x', k);
console.log(loaderCleared ? 'boot: OK' : 'boot: FAILED');
await browser.close();
